const pool = require('../db');

/**
 * GET /api/parent-feed?student_id=&limit=40
 *
 * Aggregates a chronological activity feed for a parent from:
 *  - attendance records (last 14 days)
 *  - homework assignments (last 14 days)
 *  - fee invoices (all unpaid + last 5 paid)
 *  - fee payments (last 10)
 *  - published exam results
 *  - announcements visible to parents (last 7 days)
 *
 * Each item has: { type, title, subtitle, timestamp, meta }
 */
const getParentFeed = async (req, res) => {
  try {
    const callerId   = req.user.id;
    const callerRole = req.user.role;

    // Resolve student_id
    // - Parent with multiple children: must pass ?student_id= to pick one child;
    //   if omitted, defaults to first (eldest) enrolled child
    let studentId = req.query.student_id ? parseInt(req.query.student_id) : null;
    if (callerRole === 'parent') {
      if (studentId) {
        // Security: verify this student actually belongs to the calling parent
        const { rows: check } = await pool.query(
          `SELECT id FROM students WHERE id=$1 AND parent_user_id=$2 AND deleted_at IS NULL`,
          [studentId, callerId]
        );
        if (!check[0]) return res.status(403).json({ success: false, message: 'Access denied to this student' });
      } else {
        // No student_id given — pick the first child of this parent
        const { rows: children } = await pool.query(
          `SELECT id FROM students WHERE parent_user_id=$1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
          [callerId]
        );
        if (!children[0]) return res.status(404).json({ success: false, message: 'No children linked to this account' });
        studentId = children[0].id;
      }
    }
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'student_id required' });
    }

    const limit = Math.min(parseInt(req.query.limit || '50'), 100);

    // --- Attendance (last 14 days) ---
    const attP = pool.query(
      `SELECT
         a.date::text          AS timestamp,
         a.status,
         a.remarks,
         s.full_name           AS student_name
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.student_id = $1
         AND a.date >= CURRENT_DATE - INTERVAL '14 days'
       ORDER BY a.date DESC
       LIMIT 30`,
      [studentId],
    );

    // --- Homework (last 14 days) ---
    const hwP = pool.query(
      `SELECT
         h.id, h.title, h.due_date::text AS due_date,
         h.created_at,
         sub.name AS subject_name,
         c.name   AS class_name
       FROM homework h
       JOIN subjects sub ON sub.id = h.subject_id
       JOIN classes c    ON c.id   = h.class_id
       JOIN students st  ON st.class_id = h.class_id
       WHERE st.id = $1
         AND h.created_at >= NOW() - INTERVAL '14 days'
         AND h.deleted_at IS NULL
       ORDER BY h.created_at DESC
       LIMIT 20`,
      [studentId],
    );

    // --- Fee invoices (unpaid + recent 5 paid) ---
    const invP = pool.query(
      `SELECT
         fi.id, fi.amount, fi.balance, fi.status,
         fi.month, fi.created_at,
         fh.name AS fee_head_name
       FROM fee_invoices fi
       JOIN fee_heads fh ON fh.id = fi.fee_head_id
       WHERE fi.student_id = $1
         AND (fi.status IN ('unpaid','partial')
              OR (fi.status = 'paid' AND fi.updated_at >= NOW() - INTERVAL '30 days'))
       ORDER BY fi.created_at DESC
       LIMIT 15`,
      [studentId],
    );

    // --- Fee payments (last 10) ---
    const payP = pool.query(
      `SELECT
         fp.id, fp.amount, fp.payment_date::text AS payment_date,
         fp.payment_method, fp.receipt_number,
         fi.month, fh.name AS fee_head_name
       FROM fee_payments fp
       JOIN fee_invoices fi ON fi.id = fp.invoice_id
       JOIN fee_heads fh    ON fh.id = fi.fee_head_id
       WHERE fi.student_id = $1
       ORDER BY fp.payment_date DESC
       LIMIT 10`,
      [studentId],
    );

    // --- Published exam results ---
    const resP = pool.query(
      `SELECT
         er.id, er.obtained_marks, er.total_marks,
         er.is_absent,
         e.title AS exam_title, e.date::text AS exam_date,
         sub.name AS subject_name
       FROM exam_results er
       JOIN exams e     ON e.id  = er.exam_id
       JOIN subjects sub ON sub.id = er.subject_id
       WHERE er.student_id = $1
         AND e.status = 'published'
         AND e.date >= CURRENT_DATE - INTERVAL '60 days'
       ORDER BY e.date DESC
       LIMIT 15`,
      [studentId],
    );

    // --- Announcements visible to parents (last 7 days) ---
    const annP = pool.query(
      `SELECT id, title, body, created_at
       FROM announcements
       WHERE (visible_to_parents = true OR target_audience = 'all' OR target_audience = 'parents')
         AND created_at >= NOW() - INTERVAL '7 days'
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 10`,
    );

    const [attR, hwR, invR, payR, resR, annR] = await Promise.all([
      attP.catch(() => ({ rows: [] })),
      hwP.catch(() => ({ rows: [] })),
      invP.catch(() => ({ rows: [] })),
      payP.catch(() => ({ rows: [] })),
      resP.catch(() => ({ rows: [] })),
      annP.catch(() => ({ rows: [] })),
    ]);

    const feed = [];

    // Map attendance
    for (const r of attR.rows) {
      const icons = { present: '✅', absent: '❌', late: '⏰', excused: '📋' };
      feed.push({
        type:      'attendance',
        icon:      icons[r.status] || '📋',
        title:     `${r.student_name} marked ${r.status.charAt(0).toUpperCase() + r.status.slice(1)}`,
        subtitle:  r.remarks || null,
        timestamp: r.timestamp,
        meta:      { status: r.status },
      });
    }

    // Map homework
    for (const r of hwR.rows) {
      feed.push({
        type:      'homework',
        icon:      '📝',
        title:     `${r.subject_name} homework assigned`,
        subtitle:  `${r.title} · Due ${r.due_date}`,
        timestamp: r.created_at,
        meta:      { id: r.id, due_date: r.due_date, class_name: r.class_name },
      });
    }

    // Map invoices
    for (const r of invR.rows) {
      const statusEmoji = { unpaid: '🔴', partial: '🟡', paid: '✅' };
      feed.push({
        type:      'fee_invoice',
        icon:      statusEmoji[r.status] || '💳',
        title:     `Fee invoice — ${r.fee_head_name} ${r.month || ''}`,
        subtitle:  `PKR ${Number(r.amount).toLocaleString()} · Balance PKR ${Number(r.balance || 0).toLocaleString()} · ${r.status}`,
        timestamp: r.created_at,
        meta:      { id: r.id, amount: r.amount, balance: r.balance, status: r.status },
      });
    }

    // Map payments
    for (const r of payP.rows) {
      feed.push({
        type:      'fee_payment',
        icon:      '💰',
        title:     `Payment received — ${r.fee_head_name} ${r.month || ''}`,
        subtitle:  `PKR ${Number(r.amount).toLocaleString()} via ${r.payment_method || 'cash'} · Receipt #${r.receipt_number || r.id}`,
        timestamp: r.payment_date,
        meta:      { id: r.id, amount: r.amount, receipt_number: r.receipt_number },
      });
    }

    // Map results
    for (const r of resR.rows) {
      const pct = r.is_absent ? null : Math.round((r.obtained_marks / r.total_marks) * 100);
      feed.push({
        type:      'result',
        icon:      '📊',
        title:     `Result published — ${r.exam_title}`,
        subtitle:  r.is_absent
          ? `${r.subject_name} · Absent`
          : `${r.subject_name} · ${r.obtained_marks}/${r.total_marks} (${pct}%)`,
        timestamp: r.exam_date,
        meta:      { exam_title: r.exam_title, subject: r.subject_name, pct, is_absent: r.is_absent },
      });
    }

    // Map announcements
    for (const r of annR.rows) {
      feed.push({
        type:      'announcement',
        icon:      '📢',
        title:     r.title,
        subtitle:  r.body ? r.body.slice(0, 120) + (r.body.length > 120 ? '…' : '') : null,
        timestamp: r.created_at,
        meta:      { id: r.id },
      });
    }

    // Sort all by timestamp descending
    feed.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ success: true, data: feed.slice(0, limit) });
  } catch (err) {
    console.error('[PARENT_FEED] getParentFeed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load feed' });
  }
};

/**
 * GET /api/parent-feed/children
 * Returns all children linked to the calling parent account.
 */
const getMyChildren = async (req, res) => {
  try {
    let parentUserId;
    if (req.user.role === 'parent') {
      parentUserId = req.user.id;
    } else if (req.user.role === 'admin') {
      // admin can view children of any parent: ?parent_user_id=X
      parentUserId = req.query.parent_user_id ? parseInt(req.query.parent_user_id) : null;
      if (!parentUserId) return res.status(400).json({ success: false, message: 'parent_user_id required' });
    } else {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.full_name, s.full_name_urdu, s.roll_number, s.admission_number,
              s.grade, s.section, s.gender, s.photo_url, s.status,
              c.name AS class_name, c.section AS class_section
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.parent_user_id = $1 AND s.deleted_at IS NULL
       ORDER BY s.created_at ASC`,
      [parentUserId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[PARENT_FEED] getMyChildren:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load children' });
  }
};

module.exports = { getParentFeed, getMyChildren };
