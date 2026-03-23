const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[LEAVE]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

const BASE_SELECT = `
  SELECT
    tl.id, tl.teacher_id, tl.leave_type_id,
    lt.name        AS leave_type_name,
    lt.is_paid     AS leave_type_paid,
    lt.color       AS leave_type_color,
    tl.from_date, tl.to_date, tl.total_days,
    tl.reason, tl.status, tl.admin_note,
    tl.applied_at, tl.reviewed_at, tl.reviewed_by,
    tl.created_at, tl.updated_at,
    t.full_name    AS teacher_name,
    t.subject      AS teacher_subject,
    t.phone        AS teacher_phone
  FROM teacher_leaves tl
  JOIN leave_types lt ON lt.id = tl.leave_type_id
  JOIN teachers t     ON t.id  = tl.teacher_id
`;

// ── GET /api/leaves/types ─────────────────────────────────────
const getLeaveTypes = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leave_types WHERE is_active = TRUE ORDER BY name`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/leaves ───────────────────────────────────────────
// Query: teacher_id, status, leave_type_id, month (YYYY-MM), year (YYYY)
const getLeaves = async (req, res) => {
  try {
    const { teacher_id, status, leave_type_id, month, year } = req.query;

    const conds = [];
    const vals  = [];
    const push  = (v) => { vals.push(v); return `$${vals.length}`; };

    if (teacher_id)   conds.push(`tl.teacher_id = ${push(Number(teacher_id))}`);
    if (status)       conds.push(`tl.status = ${push(status)}`);
    if (leave_type_id) conds.push(`tl.leave_type_id = ${push(Number(leave_type_id))}`);
    if (month)        conds.push(`TO_CHAR(tl.from_date,'YYYY-MM') = ${push(month)}`);
    else if (year)    conds.push(`EXTRACT(YEAR FROM tl.from_date) = ${push(Number(year))}`);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${BASE_SELECT} ${where} ORDER BY tl.applied_at DESC`, vals
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/leaves/:id ───────────────────────────────────────
const getLeave = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${BASE_SELECT} WHERE tl.id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Leave not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ── POST /api/leaves ──────────────────────────────────────────
const applyLeave = async (req, res) => {
  try {
    const { teacher_id, leave_type_id, from_date, to_date, total_days, reason } = req.body;

    if (!teacher_id)   return res.status(400).json({ success: false, message: 'teacher_id is required' });
    if (!leave_type_id) return res.status(400).json({ success: false, message: 'leave_type_id is required' });
    if (!from_date || !to_date) return res.status(400).json({ success: false, message: 'from_date and to_date are required' });
    if (!total_days || Number(total_days) <= 0) return res.status(400).json({ success: false, message: 'total_days must be > 0' });

    // Check for overlapping approved/pending leave
    const overlap = await pool.query(
      `SELECT id FROM teacher_leaves
       WHERE teacher_id = $1
         AND status IN ('pending','approved')
         AND from_date <= $2 AND to_date >= $3`,
      [teacher_id, to_date, from_date]
    );
    if (overlap.rows.length)
      return res.status(409).json({ success: false, message: 'Overlapping leave request already exists for this period' });

    const { rows } = await pool.query(
      `INSERT INTO teacher_leaves
         (teacher_id, leave_type_id, from_date, to_date, total_days, reason, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING id`,
      [teacher_id, leave_type_id, from_date, to_date, Number(total_days), reason || null]
    );

    const { rows: full } = await pool.query(`${BASE_SELECT} WHERE tl.id = $1`, [rows[0].id]);
    const leave = full[0];

    // Insert admin notification — non-blocking, failure must not break the response
    const fmtD = (d) => d ? new Date(d).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    pool.query(
      `INSERT INTO notifications (type, title, message, link, ref_key, user_id)
       VALUES ('leave_request', $1, $2, '/leaves', $3, NULL)
       ON CONFLICT (ref_key) DO NOTHING`,
      [
        `Leave Request — ${leave.teacher_name}`,
        `${leave.teacher_name} applied for ${leave.leave_type_name} (${leave.total_days} day${leave.total_days !== 1 ? 's' : ''}) from ${fmtD(leave.from_date)} to ${fmtD(leave.to_date)}.`,
        `leave_request_${rows[0].id}`,
      ]
    ).catch(() => {}); // fire-and-forget

    res.status(201).json({ success: true, data: leave, message: 'Leave application submitted' });
  } catch (err) { serverErr(res, err); }
};

// ── PUT /api/leaves/:id/review  (admin approve/reject) ────────
const reviewLeave = async (req, res) => {
  try {
    const { status, admin_note } = req.body;
    if (!['approved', 'rejected'].includes(status))
      return res.status(400).json({ success: false, message: 'status must be approved or rejected' });

    const reviewedBy = req.user?.username || req.user?.name || 'Admin';

    const { rows } = await pool.query(
      `UPDATE teacher_leaves SET
         status      = $1,
         admin_note  = $2,
         reviewed_at = NOW(),
         reviewed_by = $3,
         updated_at  = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING id`,
      [status, admin_note || null, reviewedBy, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Leave not found or already reviewed' });

    const { rows: full } = await pool.query(`${BASE_SELECT} WHERE tl.id = $1`, [rows[0].id]);
    res.json({ success: true, data: full[0], message: `Leave ${status}` });
  } catch (err) { serverErr(res, err); }
};

// ── PUT /api/leaves/:id/cancel  (teacher cancels pending) ─────
const cancelLeave = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE teacher_leaves SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Leave not found or cannot be cancelled' });
    res.json({ success: true, message: 'Leave cancelled' });
  } catch (err) { serverErr(res, err); }
};

// ── DELETE /api/leaves/:id ────────────────────────────────────
const deleteLeave = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM teacher_leaves WHERE id=$1 RETURNING id`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Leave not found' });
    res.json({ success: true, message: 'Leave deleted' });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/leaves/balance?teacher_id=&year= ─────────────────
// Returns used/remaining days per leave type for a teacher in a year
const getLeaveBalance = async (req, res) => {
  try {
    const { teacher_id, year = new Date().getFullYear() } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, message: 'teacher_id is required' });

    const [typesRes, usedRes] = await Promise.all([
      pool.query(`SELECT * FROM leave_types WHERE is_active = TRUE ORDER BY name`),
      pool.query(
        `SELECT leave_type_id,
                SUM(total_days)::NUMERIC AS used_days
         FROM teacher_leaves
         WHERE teacher_id = $1
           AND status = 'approved'
           AND EXTRACT(YEAR FROM from_date) = $2
         GROUP BY leave_type_id`,
        [teacher_id, Number(year)]
      ),
    ]);

    const usedMap = {};
    usedRes.rows.forEach(r => { usedMap[r.leave_type_id] = Number(r.used_days); });

    const balance = typesRes.rows.map(lt => ({
      leave_type_id:   lt.id,
      leave_type_name: lt.name,
      color:           lt.color,
      is_paid:         lt.is_paid,
      days_allowed:    lt.days_allowed,
      used_days:       usedMap[lt.id] || 0,
      remaining_days:  lt.days_allowed > 0 ? Math.max(0, lt.days_allowed - (usedMap[lt.id] || 0)) : null,
    }));

    res.json({ success: true, data: balance, year: Number(year) });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/leaves/stats ─────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const thisMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

    const [totals, byStatus, byType, onLeaveToday, pendingList] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int                                      AS total,
           COUNT(*) FILTER (WHERE status='pending')::int     AS pending,
           COUNT(*) FILTER (WHERE status='approved')::int    AS approved,
           COUNT(*) FILTER (WHERE status='rejected')::int    AS rejected,
           COUNT(*) FILTER (WHERE status='cancelled')::int   AS cancelled,
           COALESCE(SUM(total_days) FILTER (WHERE status='approved'),0) AS total_days_taken
         FROM teacher_leaves
         WHERE EXTRACT(YEAR FROM from_date) = $1`,
        [Number(year)]
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM teacher_leaves
         WHERE EXTRACT(YEAR FROM from_date) = $1
         GROUP BY status ORDER BY count DESC`,
        [Number(year)]
      ),
      pool.query(
        `SELECT lt.name, lt.color,
                COUNT(tl.id)::int AS count,
                COALESCE(SUM(tl.total_days),0) AS total_days
         FROM leave_types lt
         LEFT JOIN teacher_leaves tl ON tl.leave_type_id = lt.id
           AND tl.status = 'approved'
           AND EXTRACT(YEAR FROM tl.from_date) = $1
         WHERE lt.is_active = TRUE
         GROUP BY lt.id, lt.name, lt.color ORDER BY total_days DESC`,
        [Number(year)]
      ),
      // Teachers on leave today
      pool.query(
        `SELECT t.full_name, lt.name AS leave_type, tl.from_date, tl.to_date, tl.total_days
         FROM teacher_leaves tl
         JOIN teachers t    ON t.id  = tl.teacher_id
         JOIN leave_types lt ON lt.id = tl.leave_type_id
         WHERE tl.status = 'approved'
           AND CURRENT_DATE BETWEEN tl.from_date AND tl.to_date
         ORDER BY t.full_name`
      ),
      // Pending requests
      pool.query(
        `${BASE_SELECT} WHERE tl.status = 'pending' ORDER BY tl.applied_at ASC LIMIT 10`
      ),
    ]);

    res.json({
      success: true,
      data: {
        totals:       totals.rows[0],
        byStatus:     byStatus.rows,
        byType:       byType.rows,
        onLeaveToday: onLeaveToday.rows,
        pendingList:  pendingList.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getLeaveTypes,
  getLeaves, getLeave,
  applyLeave, reviewLeave, cancelLeave, deleteLeave,
  getLeaveBalance, getStats,
};
