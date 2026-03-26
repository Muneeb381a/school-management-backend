const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// GET /api/notifications  — list recent 60 for this user (own + global)
const getNotifications = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { rows } = await pool.query(`
      SELECT * FROM notifications
      WHERE (user_id = $1 OR user_id IS NULL)
      ORDER BY created_at DESC
      LIMIT 60
    `, [userId]);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /api/notifications/unread-count
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE is_read = FALSE AND (user_id = $1 OR user_id IS NULL)`,
      [userId]
    );
    res.json({ success: true, count: rows[0].count });
  } catch (err) { serverErr(res, err); }
};

// PATCH /api/notifications/:id/read
const markRead = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
      [req.params.id, userId]
    );
    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

// POST /api/notifications/mark-all-read
const markAllRead = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { rowCount } = await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE AND (user_id = $1 OR user_id IS NULL)`,
      [userId]
    );
    res.json({ success: true, updated: rowCount });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/notifications/:id
const deleteNotification = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
      [req.params.id, userId]
    );
    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

// POST /api/notifications/generate
// Scans the DB for alert conditions and inserts new notifications.
// All 8 alert types are gathered in parallel, then flushed in ONE batch INSERT.
// ref_key UNIQUE constraint + ON CONFLICT DO NOTHING prevents duplicates.
const generateNotifications = async (req, res) => {
  const client = await pool.connect();
  try {
    const today      = new Date().toISOString().slice(0, 10);
    const in3days    = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const in15min    = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const fmtD = (d) => d ? new Date(d).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

    // Gather all alert data in parallel — 8 queries fire simultaneously
    const [
      { rows: overdueInvoices },
      { rows: dueSoonInvoices },
      { rows: absentStudents },
      { rows: overdueBooks },
      { rows: lowStock },
      { rows: upcomingExams },
      { rows: pendingLeaves },
      { rows: soonClasses },
    ] = await Promise.all([

      // 1. Fee overdue
      client.query(`
        SELECT fi.id, fi.invoice_no, fi.due_date, s.full_name AS student_name
        FROM fee_invoices fi
        JOIN students s ON s.id = fi.student_id
        WHERE fi.status = 'overdue' AND fi.due_date IS NOT NULL
      `),

      // 2. Fee due in ≤3 days
      client.query(`
        SELECT fi.id, fi.invoice_no, fi.due_date, s.full_name AS student_name
        FROM fee_invoices fi
        JOIN students s ON s.id = fi.student_id
        WHERE fi.status IN ('unpaid','partial')
          AND fi.due_date IS NOT NULL
          AND fi.due_date BETWEEN $1 AND $2
      `, [today, in3days]),

      // 3. Chronic absentees (2+ absences in last 3 days)
      client.query(`
        SELECT a.entity_id AS student_id, s.full_name, COUNT(*)::int AS absent_count
        FROM attendance a
        JOIN students s ON s.id = a.entity_id
        WHERE a.entity_type = 'student'
          AND a.status = 'absent'
          AND a.date BETWEEN $1 AND $2
          AND a.period_id IS NULL
        GROUP BY a.entity_id, s.full_name
        HAVING COUNT(*) >= 2
      `, [threeDaysAgo, today]),

      // 4. Library books overdue
      client.query(`
        SELECT bi.id, bi.due_date,
               b.title AS book_title,
               COALESCE(s.full_name, t.full_name) AS borrower_name
        FROM book_issues bi
        JOIN book_copies bc ON bc.id = bi.book_copy_id
        JOIN books b ON b.id = bc.book_id
        LEFT JOIN students s ON bi.borrower_type = 'student' AND s.id = bi.borrower_id
        LEFT JOIN teachers t ON bi.borrower_type = 'teacher' AND t.id = bi.borrower_id
        WHERE bi.status IN ('issued','overdue')
          AND bi.due_date < $1
          AND bi.return_date IS NULL
      `, [today]),

      // 5. Low / out-of-stock inventory
      client.query(`
        SELECT id, name, quantity, category
        FROM inventory_items
        WHERE quantity <= 2
      `),

      // 6. Upcoming exams in ≤3 days
      client.query(`
        SELECT id, exam_name, start_date, academic_year
        FROM exams
        WHERE start_date BETWEEN $1 AND $2
          AND status NOT IN ('completed','cancelled')
      `, [today, in3days]),

      // 7. Pending leave requests
      client.query(`
        SELECT tl.id, tl.from_date, tl.to_date, tl.total_days,
               t.full_name AS teacher_name, lt.name AS leave_type_name
        FROM teacher_leaves tl
        JOIN teachers    t  ON t.id  = tl.teacher_id
        JOIN leave_types lt ON lt.id = tl.leave_type_id
        WHERE tl.status = 'pending'
      `),

      // 8. Online classes starting within 15 minutes
      client.query(`
        SELECT oc.id, oc.title, oc.scheduled_at,
               t.full_name AS teacher_name, c.name AS class_name
        FROM online_classes oc
        JOIN teachers t ON t.id = oc.teacher_id
        LEFT JOIN classes c ON c.id = oc.class_id
        WHERE oc.status = 'scheduled'
          AND oc.scheduled_at BETWEEN NOW() AND $1
      `, [in15min]),
    ]);

    // Build the full rows array in memory (zero DB round-trips)
    const rows = [];
    const push = (type, title, message, link, ref_key) =>
      rows.push({ type, title, message, link, ref_key });

    for (const inv of overdueInvoices) {
      push('fee_overdue',
        `Fee Overdue — ${inv.student_name}`,
        `Invoice ${inv.invoice_no} was due on ${inv.due_date}. Payment is overdue.`,
        '/fees', `fee_overdue_${inv.id}_${today}`);
    }
    for (const inv of dueSoonInvoices) {
      push('fee_due_soon',
        `Fee Due Soon — ${inv.student_name}`,
        `Invoice ${inv.invoice_no} is due on ${inv.due_date}.`,
        '/fees', `fee_due_soon_${inv.id}_${today}`);
    }
    for (const stu of absentStudents) {
      push('absent',
        `Repeated Absence — ${stu.full_name}`,
        `${stu.full_name} has been absent ${stu.absent_count} day(s) in the last 3 days.`,
        '/attendance', `absent_${stu.student_id}_${today}`);
    }
    for (const issue of overdueBooks) {
      push('library_overdue',
        `Book Overdue — ${issue.borrower_name}`,
        `"${issue.book_title}" was due back on ${issue.due_date} and has not been returned.`,
        '/library', `library_overdue_${issue.id}_${today}`);
    }
    for (const item of lowStock) {
      const label = item.quantity === 0 ? 'Out of Stock' : 'Low Stock';
      push('low_stock',
        `${label} — ${item.name}`,
        `${item.name} (${item.category}) has ${item.quantity} unit(s) remaining.`,
        '/inventory', `low_stock_${item.id}_${today}`);
    }
    for (const exam of upcomingExams) {
      push('upcoming_exam',
        `Upcoming Exam — ${exam.exam_name}`,
        `"${exam.exam_name}" (${exam.academic_year}) starts on ${exam.start_date}.`,
        '/exams', `upcoming_exam_${exam.id}_${today}`);
    }
    for (const lv of pendingLeaves) {
      push('leave_request',
        `Leave Request — ${lv.teacher_name}`,
        `${lv.teacher_name} applied for ${lv.leave_type_name} (${lv.total_days} day${lv.total_days !== 1 ? 's' : ''}) from ${fmtD(lv.from_date)} to ${fmtD(lv.to_date)}.`,
        '/leaves', `leave_request_${lv.id}`);
    }
    for (const oc of soonClasses) {
      const timeStr = new Date(oc.scheduled_at).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
      push('online_class',
        `Class Starting Soon — ${oc.title}`,
        `"${oc.title}" by ${oc.teacher_name}${oc.class_name ? ' for ' + oc.class_name : ''} starts at ${timeStr}.`,
        '/online-classes', `online_class_soon_${oc.id}_${today}`);
    }

    // Single batch INSERT for all rows — O(1) round-trips regardless of row count
    let inserted = 0;
    if (rows.length > 0) {
      const { rowCount } = await client.query(`
        INSERT INTO notifications (type, title, message, link, ref_key)
        SELECT * FROM UNNEST(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[]
        )
        ON CONFLICT (ref_key) DO NOTHING
      `, [
        rows.map(r => r.type),
        rows.map(r => r.title),
        rows.map(r => r.message),
        rows.map(r => r.link),
        rows.map(r => r.ref_key),
      ]);
      inserted = rowCount;
    }

    res.json({ success: true, inserted, message: `${inserted} new notification(s) generated` });
  } catch (err) {
    serverErr(res, err);
  } finally { client.release(); }
};

module.exports = {
  getNotifications, getUnreadCount,
  markRead, markAllRead, deleteNotification,
  generateNotifications,
};
