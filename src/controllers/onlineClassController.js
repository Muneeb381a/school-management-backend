const pool = require('../db');

const err400 = (res, msg) => res.status(400).json({ success: false, message: msg });
const err404 = (res)      => res.status(404).json({ success: false, message: 'Online class not found' });
const serverErr = (res, e) => {
  console.error('[ONLINE_CLASS]', e.message);
  res.status(500).json({ success: false, message: e.message });
};

// Base SELECT used in multiple queries
const BASE_SELECT = `
  SELECT
    oc.*,
    t.full_name        AS teacher_name,
    t.subject          AS teacher_subject,
    c.name             AS class_name,
    s.name             AS subject_name,
    u.username         AS created_by_username
  FROM online_classes oc
  LEFT JOIN teachers t  ON t.id = oc.teacher_id
  LEFT JOIN classes  c  ON c.id = oc.class_id
  LEFT JOIN subjects s  ON s.id = oc.subject_id
  LEFT JOIN users    u  ON u.id = oc.created_by
`;

// ── GET /online-classes ───────────────────────────────────────
// Query params: teacher_id, class_id, status, date (YYYY-MM-DD), upcoming (bool)
const getAll = async (req, res) => {
  try {
    const { teacher_id, class_id, status, date, upcoming } = req.query;
    const conds = []; const vals = [];
    const push  = (v) => { vals.push(v); return `$${vals.length}`; };

    if (teacher_id) conds.push(`oc.teacher_id = ${push(Number(teacher_id))}`);
    if (class_id)   conds.push(`oc.class_id   = ${push(Number(class_id))}`);
    if (status)     conds.push(`oc.status      = ${push(status)}`);
    if (date)       conds.push(`oc.scheduled_at::date = ${push(date)}`);
    if (upcoming === 'true') conds.push(`oc.scheduled_at > NOW() AND oc.status = 'scheduled'`);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${BASE_SELECT} ${where} ORDER BY oc.scheduled_at ASC`,
      vals
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (e) { serverErr(res, e); }
};

// ── GET /online-classes/my ────────────────────────────────────
// For student/parent: classes for their enrolled class
const getMy = async (req, res) => {
  try {
    const studentId = req.user?.entity_id;
    if (!studentId) return err400(res, 'Student entity not found in token');

    const { rows: stuRows } = await pool.query(
      'SELECT class_id FROM students WHERE id = $1 AND deleted_at IS NULL',
      [studentId]
    );
    if (!stuRows[0]) return err400(res, 'Student not found');

    const { rows } = await pool.query(
      `${BASE_SELECT}
       WHERE oc.class_id = $1
         AND oc.status IN ('scheduled','live')
         AND oc.scheduled_at > NOW() - INTERVAL '2 hours'
       ORDER BY oc.scheduled_at ASC
       LIMIT 30`,
      [stuRows[0].class_id]
    );
    res.json({ success: true, data: rows });
  } catch (e) { serverErr(res, e); }
};

// ── GET /online-classes/:id ───────────────────────────────────
const getOne = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${BASE_SELECT} WHERE oc.id = $1`, [req.params.id]
    );
    if (!rows[0]) return err404(res);
    res.json({ success: true, data: rows[0] });
  } catch (e) { serverErr(res, e); }
};

// ── POST /online-classes ──────────────────────────────────────
const create = async (req, res) => {
  try {
    const {
      class_id, subject_id, title, description, agenda,
      scheduled_at, duration_minutes = 45,
      meeting_platform = 'manual', meeting_link, meeting_password,
    } = req.body;

    if (!title?.trim())    return err400(res, 'Title is required');
    if (!scheduled_at)     return err400(res, 'scheduled_at is required');
    if (!meeting_link?.trim()) return err400(res, 'Meeting link is required');
    if (new Date(scheduled_at) < new Date()) return err400(res, 'Scheduled time must be in the future');

    // Resolve teacher_id: admin passes it explicitly, teacher uses entity_id
    let teacher_id = req.body.teacher_id;
    if (req.user.role === 'teacher') teacher_id = req.user.entity_id;
    if (!teacher_id) return err400(res, 'teacher_id is required');

    const { rows } = await pool.query(
      `INSERT INTO online_classes
         (teacher_id, class_id, subject_id, title, description, agenda,
          scheduled_at, duration_minutes, meeting_platform, meeting_link,
          meeting_password, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       RETURNING id`,
      [
        teacher_id, class_id || null, subject_id || null,
        title.trim(), description || null, agenda || null,
        scheduled_at, duration_minutes,
        meeting_platform, meeting_link.trim(), meeting_password || null,
        req.user.id,
      ]
    );

    // Auto-enroll students from the selected class
    if (class_id) {
      await pool.query(
        `INSERT INTO online_class_participants (oc_id, student_id)
         SELECT $1, id FROM students
         WHERE class_id = $2 AND deleted_at IS NULL
         ON CONFLICT DO NOTHING`,
        [rows[0].id, class_id]
      );
    }

    // Notify admin & teacher via notifications table
    pool.query(
      `INSERT INTO notifications (type, title, message, link, ref_key, user_id)
       VALUES ('online_class','Online Class Scheduled',$1,$2,$3,NULL)
       ON CONFLICT (ref_key) DO NOTHING`,
      [
        `A new online class "${title.trim()}" has been scheduled.`,
        `/online-classes`,
        `online_class_${rows[0].id}`,
      ]
    ).catch(() => {});

    const { rows: full } = await pool.query(
      `${BASE_SELECT} WHERE oc.id = $1`, [rows[0].id]
    );
    res.status(201).json({ success: true, data: full[0], message: 'Online class scheduled' });
  } catch (e) { serverErr(res, e); }
};

// ── PUT /online-classes/:id ───────────────────────────────────
const update = async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM online_classes WHERE id = $1', [req.params.id]
    );
    if (!existing[0]) return err404(res);

    const oc = existing[0];
    // Teachers can only edit their own classes; cannot edit live/completed
    if (req.user.role === 'teacher' && oc.teacher_id !== req.user.entity_id)
      return res.status(403).json({ success: false, message: 'Forbidden' });
    if (['live','completed'].includes(oc.status))
      return err400(res, `Cannot edit a ${oc.status} class`);

    const {
      title, description, agenda, scheduled_at, duration_minutes,
      meeting_platform, meeting_link, meeting_password, class_id, subject_id,
    } = req.body;

    if (scheduled_at && new Date(scheduled_at) < new Date())
      return err400(res, 'Scheduled time must be in the future');

    await pool.query(
      `UPDATE online_classes SET
        title              = COALESCE($1, title),
        description        = COALESCE($2, description),
        agenda             = COALESCE($3, agenda),
        scheduled_at       = COALESCE($4, scheduled_at),
        duration_minutes   = COALESCE($5, duration_minutes),
        meeting_platform   = COALESCE($6, meeting_platform),
        meeting_link       = COALESCE($7, meeting_link),
        meeting_password   = COALESCE($8, meeting_password),
        class_id           = COALESCE($9,  class_id),
        subject_id         = COALESCE($10, subject_id),
        updated_at         = NOW()
       WHERE id = $11`,
      [
        title, description, agenda, scheduled_at, duration_minutes,
        meeting_platform, meeting_link, meeting_password,
        class_id, subject_id, req.params.id,
      ]
    );

    const { rows: full } = await pool.query(`${BASE_SELECT} WHERE oc.id = $1`, [req.params.id]);
    res.json({ success: true, data: full[0], message: 'Class updated' });
  } catch (e) { serverErr(res, e); }
};

// ── DELETE /online-classes/:id  (cancel) ─────────────────────
const cancel = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM online_classes WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return err404(res);
    if (rows[0].status === 'completed')
      return err400(res, 'Cannot cancel a completed class');
    if (req.user.role === 'teacher' && rows[0].teacher_id !== req.user.entity_id)
      return res.status(403).json({ success: false, message: 'Forbidden' });

    const reason = req.body.reason || null;
    await pool.query(
      `UPDATE online_classes SET status='cancelled', cancelled_reason=$1, updated_at=NOW() WHERE id=$2`,
      [reason, req.params.id]
    );
    res.json({ success: true, message: 'Class cancelled' });
  } catch (e) { serverErr(res, e); }
};

// ── PATCH /online-classes/:id/status ─────────────────────────
// Admin/teacher marks class as live or completed
const updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['scheduled','live','completed'];
    if (!allowed.includes(status)) return err400(res, `status must be one of: ${allowed.join(', ')}`);

    const { rows } = await pool.query(
      'SELECT * FROM online_classes WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return err404(res);
    if (req.user.role === 'teacher' && rows[0].teacher_id !== req.user.entity_id)
      return res.status(403).json({ success: false, message: 'Forbidden' });

    await pool.query(
      'UPDATE online_classes SET status=$1, updated_at=NOW() WHERE id=$2',
      [status, req.params.id]
    );
    res.json({ success: true, message: `Status updated to ${status}` });
  } catch (e) { serverErr(res, e); }
};

// ── POST /online-classes/:id/join ─────────────────────────────
// Records join timestamp for student; returns meeting link
const joinClass = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM online_classes WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return err404(res);
    const oc = rows[0];

    if (oc.status === 'cancelled')
      return err400(res, 'This class has been cancelled');
    if (oc.status === 'completed')
      return err400(res, 'This class has already ended');
    if (!oc.meeting_link)
      return err400(res, 'Meeting link not yet available');

    // Record join for students
    if (req.user.role === 'student' && req.user.entity_id) {
      await pool.query(
        `UPDATE online_class_participants
         SET joined_at = COALESCE(joined_at, NOW()), attended = TRUE
         WHERE oc_id = $1 AND student_id = $2`,
        [oc.id, req.user.entity_id]
      );
    }

    res.json({
      success: true,
      data: {
        meeting_link:     oc.meeting_link,
        meeting_password: oc.meeting_password,
        meeting_platform: oc.meeting_platform,
        title:            oc.title,
      },
    });
  } catch (e) { serverErr(res, e); }
};

// ── GET /online-classes/:id/attendance ───────────────────────
const getAttendance = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ocp.*, s.full_name, s.roll_number, s.photo_url
       FROM online_class_participants ocp
       JOIN students s ON s.id = ocp.student_id
       WHERE ocp.oc_id = $1
       ORDER BY s.full_name`,
      [req.params.id]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (e) { serverErr(res, e); }
};

// ── GET /online-classes/stats (admin) ────────────────────────
const getStats = async (req, res) => {
  try {
    const [totals, byTeacher] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                        AS total,
          COUNT(*) FILTER (WHERE status='scheduled')     AS scheduled,
          COUNT(*) FILTER (WHERE status='live')          AS live,
          COUNT(*) FILTER (WHERE status='completed')     AS completed,
          COUNT(*) FILTER (WHERE status='cancelled')     AS cancelled
        FROM online_classes
      `),
      pool.query(`
        SELECT t.full_name AS teacher_name,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE oc.status='completed')::int AS completed
        FROM online_classes oc
        JOIN teachers t ON t.id = oc.teacher_id
        GROUP BY t.id, t.full_name
        ORDER BY total DESC
        LIMIT 10
      `),
    ]);
    res.json({
      success: true,
      data: { totals: totals.rows[0], by_teacher: byTeacher.rows },
    });
  } catch (e) { serverErr(res, e); }
};

module.exports = {
  getAll, getMy, getOne, create, update, cancel,
  updateStatus, joinClass, getAttendance, getStats,
};
