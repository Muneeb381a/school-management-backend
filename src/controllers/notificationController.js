const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[NOTIFICATIONS]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// GET /api/notifications  — list recent 60
const getNotifications = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM notifications
      ORDER BY created_at DESC
      LIMIT 60
    `);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /api/notifications/unread-count
const getUnreadCount = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE is_read = FALSE`);
    res.json({ success: true, count: rows[0].count });
  } catch (err) { serverErr(res, err); }
};

// PATCH /api/notifications/:id/read
const markRead = async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

// POST /api/notifications/mark-all-read
const markAllRead = async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE`);
    res.json({ success: true, updated: rowCount });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/notifications/:id
const deleteNotification = async (req, res) => {
  try {
    await pool.query(`DELETE FROM notifications WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

// POST /api/notifications/generate
// Scans the DB for alert conditions and inserts new notifications.
// ref_key has UNIQUE constraint → ON CONFLICT DO NOTHING prevents duplicates.
const generateNotifications = async (req, res) => {
  const client = await pool.connect();
  try {
    const today    = new Date().toISOString().slice(0, 10);
    const in3days  = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    let inserted   = 0;

    const ins = async (type, title, message, link, ref_key) => {
      const r = await client.query(`
        INSERT INTO notifications (type, title, message, link, ref_key)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (ref_key) DO NOTHING
      `, [type, title, message, link, ref_key]);
      inserted += r.rowCount;
    };

    await client.query('BEGIN');

    // ── 1. Fee overdue ──────────────────────────────────────────
    const { rows: overdueInvoices } = await client.query(`
      SELECT fi.id, fi.invoice_no, fi.due_date,
             s.full_name AS student_name
      FROM fee_invoices fi
      JOIN students s ON s.id = fi.student_id
      WHERE fi.status = 'overdue'
        AND fi.due_date IS NOT NULL
    `);
    for (const inv of overdueInvoices) {
      await ins(
        'fee_overdue',
        `Fee Overdue — ${inv.student_name}`,
        `Invoice ${inv.invoice_no} was due on ${inv.due_date}. Payment is overdue.`,
        '/fees',
        `fee_overdue_${inv.id}_${today}`
      );
    }

    // ── 2. Fee due in ≤3 days ──────────────────────────────────
    const { rows: dueSoonInvoices } = await client.query(`
      SELECT fi.id, fi.invoice_no, fi.due_date,
             s.full_name AS student_name
      FROM fee_invoices fi
      JOIN students s ON s.id = fi.student_id
      WHERE fi.status IN ('unpaid','partial')
        AND fi.due_date IS NOT NULL
        AND fi.due_date BETWEEN $1 AND $2
    `, [today, in3days]);
    for (const inv of dueSoonInvoices) {
      await ins(
        'fee_due_soon',
        `Fee Due Soon — ${inv.student_name}`,
        `Invoice ${inv.invoice_no} is due on ${inv.due_date}.`,
        '/fees',
        `fee_due_soon_${inv.id}_${today}`
      );
    }

    // ── 3. Students absent 2+ days in last 3 days ──────────────
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const { rows: absentStudents } = await client.query(`
      SELECT a.entity_id AS student_id, s.full_name,
             COUNT(*)::int AS absent_count
      FROM attendance a
      JOIN students s ON s.id = a.entity_id
      WHERE a.entity_type = 'student'
        AND a.status = 'absent'
        AND a.date BETWEEN $1 AND $2
        AND a.period_id IS NULL
      GROUP BY a.entity_id, s.full_name
      HAVING COUNT(*) >= 2
    `, [threeDaysAgo, today]);
    for (const stu of absentStudents) {
      await ins(
        'absent',
        `Repeated Absence — ${stu.full_name}`,
        `${stu.full_name} has been absent ${stu.absent_count} day(s) in the last 3 days.`,
        '/attendance',
        `absent_${stu.student_id}_${today}`
      );
    }

    // ── 4. Library books overdue ────────────────────────────────
    const { rows: overdueBooks } = await client.query(`
      SELECT bi.id, bi.due_date, bi.borrower_type, bi.borrower_id,
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
    `, [today]);
    for (const issue of overdueBooks) {
      await ins(
        'library_overdue',
        `Book Overdue — ${issue.borrower_name}`,
        `"${issue.book_title}" was due back on ${issue.due_date} and has not been returned.`,
        '/library',
        `library_overdue_${issue.id}_${today}`
      );
    }

    // ── 5. Low / out-of-stock inventory ─────────────────────────
    const { rows: lowStock } = await client.query(`
      SELECT id, name, quantity, category
      FROM inventory_items
      WHERE quantity <= 2
    `);
    for (const item of lowStock) {
      const label = item.quantity === 0 ? 'Out of Stock' : 'Low Stock';
      await ins(
        'low_stock',
        `${label} — ${item.name}`,
        `${item.name} (${item.category}) has ${item.quantity} unit(s) remaining.`,
        '/inventory',
        `low_stock_${item.id}_${today}`
      );
    }

    // ── 6. Upcoming exams in ≤3 days ───────────────────────────
    const { rows: upcomingExams } = await client.query(`
      SELECT id, name, start_date, academic_year
      FROM exams
      WHERE start_date BETWEEN $1 AND $2
        AND status NOT IN ('completed','cancelled')
    `, [today, in3days]);
    for (const exam of upcomingExams) {
      await ins(
        'upcoming_exam',
        `Upcoming Exam — ${exam.name}`,
        `"${exam.name}" (${exam.academic_year}) starts on ${exam.start_date}.`,
        '/exams',
        `upcoming_exam_${exam.id}_${today}`
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, inserted, message: `${inserted} new notification(s) generated` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

module.exports = {
  getNotifications, getUnreadCount,
  markRead, markAllRead, deleteNotification,
  generateNotifications,
};
