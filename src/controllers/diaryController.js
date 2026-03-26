const pool = require('../db');
const { docUpload, uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const { serverErr } = require('../utils/serverErr');

const err500 = (res, err, tag = 'DIARY') => {
  console.error(`[${tag}]`, err.message);
  return serverErr(res, err);
};

/* ─────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────── */

/** Build WhatsApp-formatted text for a diary */
function buildWhatsappText({ className, date, entries, generalRemarks }) {
  const dayName = new Date(date).toLocaleDateString('en-PK', { weekday: 'long' });
  const dateStr = new Date(date).toLocaleDateString('en-PK', { day: 'numeric', month: 'long', year: 'numeric' });

  let text = `📚 *${className} — Daily Diary*\n📅 *${dayName}, ${dateStr}*\n\n`;

  for (const e of entries) {
    if (!e.homework && !e.classwork && !e.notes) continue;
    text += `📖 *${e.subject_name || 'General'}*\n`;
    if (e.classwork) text += `📝 Classwork: ${e.classwork}\n`;
    if (e.homework)  text += `✏️  Homework: ${e.homework}\n`;
    if (e.notes)     text += `📌 Notes: ${e.notes}\n`;
    text += '\n';
  }

  if (generalRemarks?.trim()) {
    text += `📣 *General Instructions:*\n${generalRemarks}\n\n`;
  }

  text += `_Shared via SchoolMS_`;
  return text;
}

/* ─────────────────────────────────────────────────────────
   GET /api/diary
   List diary entries — filters: class_id, date, subject_id,
   teacher_id, status, date_from, date_to
───────────────────────────────────────────────────────── */
const getDiaries = async (req, res) => {
  try {
    const { class_id, date, subject_id, teacher_id, status, date_from, date_to } = req.query;
    const p = [];
    let where = 'WHERE 1=1';

    if (class_id)   { p.push(class_id);   where += ` AND de.class_id=$${p.length}`; }
    if (date)       { p.push(date);        where += ` AND de.date=$${p.length}`; }
    if (subject_id) { p.push(subject_id);  where += ` AND de.subject_id=$${p.length}`; }
    if (teacher_id) { p.push(teacher_id);  where += ` AND de.teacher_id=$${p.length}`; }
    if (status)     { p.push(status);      where += ` AND de.status=$${p.length}`; }
    if (date_from)  { p.push(date_from);   where += ` AND de.date >= $${p.length}`; }
    if (date_to)    { p.push(date_to);     where += ` AND de.date <= $${p.length}`; }

    const { rows } = await pool.query(
      `SELECT de.*,
              c.name  AS class_name, c.grade, c.section,
              s.name  AS subject_name, s.code AS subject_code,
              t.full_name AS teacher_name
       FROM diary_entries de
       LEFT JOIN classes  c ON c.id = de.class_id
       LEFT JOIN subjects s ON s.id = de.subject_id
       LEFT JOIN teachers t ON t.id = de.teacher_id
       ${where}
       ORDER BY de.date DESC, s.name ASC`,
      p,
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   GET /api/diary/:id
───────────────────────────────────────────────────────── */
const getDiary = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT de.*,
              c.name AS class_name, c.grade, c.section,
              s.name AS subject_name, s.code AS subject_code,
              t.full_name AS teacher_name
       FROM diary_entries de
       LEFT JOIN classes  c ON c.id = de.class_id
       LEFT JOIN subjects s ON s.id = de.subject_id
       LEFT JOIN teachers t ON t.id = de.teacher_id
       WHERE de.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Diary entry not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   POST /api/diary
   Create a diary entry (teacher/admin).
   Prevent duplicate (class_id + subject_id + date).
───────────────────────────────────────────────────────── */
const createDiary = async (req, res) => {
  try {
    const { class_id, subject_id, teacher_id, date, homework, classwork, notes } = req.body;

    if (!class_id || !date) {
      return res.status(400).json({ success: false, message: 'class_id and date are required' });
    }

    // Upload attachment if provided
    let attachment_url = null, attachment_name = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'schoolms/diary');
      attachment_url  = result.secure_url;
      attachment_name = req.file.originalname;
    }

    const { rows } = await pool.query(
      `INSERT INTO diary_entries
         (class_id, subject_id, teacher_id, date, homework, classwork, notes,
          attachment_url, attachment_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
       ON CONFLICT (class_id, subject_id, date) DO NOTHING
       RETURNING *`,
      [class_id, subject_id || null, teacher_id || null, date,
       homework || null, classwork || null, notes || null,
       attachment_url, attachment_name],
    );

    if (!rows[0]) {
      return res.status(409).json({
        success: false,
        message: 'A diary entry already exists for this class, subject and date.',
      });
    }

    res.status(201).json({ success: true, data: rows[0], message: 'Diary entry created' });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   PUT /api/diary/:id
   Update a diary entry (teacher or incharge/admin).
   Cannot edit published entries unless admin.
───────────────────────────────────────────────────────── */
const updateDiary = async (req, res) => {
  try {
    const { homework, classwork, notes, incharge_remark, status } = req.body;

    // Fetch existing
    const { rows: [existing] } = await pool.query(
      'SELECT * FROM diary_entries WHERE id=$1', [req.params.id],
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Entry not found' });

    // Delete old attachment if new file uploaded
    let attachment_url  = existing.attachment_url;
    let attachment_name = existing.attachment_name;
    if (req.file) {
      if (existing.attachment_url) await deleteFromCloudinary(existing.attachment_url).catch(() => {});
      const result    = await uploadToCloudinary(req.file.buffer, 'schoolms/diary');
      attachment_url  = result.secure_url;
      attachment_name = req.file.originalname;
    }

    const { rows } = await pool.query(
      `UPDATE diary_entries SET
         homework=$1, classwork=$2, notes=$3,
         attachment_url=$4, attachment_name=$5,
         incharge_remark=$6,
         status=COALESCE($7, status),
         updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [homework ?? existing.homework, classwork ?? existing.classwork,
       notes ?? existing.notes, attachment_url, attachment_name,
       incharge_remark ?? existing.incharge_remark,
       status || null,
       req.params.id],
    );

    res.json({ success: true, data: rows[0], message: 'Entry updated' });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   DELETE /api/diary/:id
───────────────────────────────────────────────────────── */
const deleteDiary = async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      'DELETE FROM diary_entries WHERE id=$1 RETURNING *', [req.params.id],
    );
    if (!row) return res.status(404).json({ success: false, message: 'Entry not found' });
    if (row.attachment_url) await deleteFromCloudinary(row.attachment_url).catch(() => {});
    res.json({ success: true, message: 'Entry deleted' });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   POST /api/diary/:id/submit
   Teacher submits entry for review: draft → pending
───────────────────────────────────────────────────────── */
const submitDiary = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE diary_entries SET status='pending', updated_at=NOW()
       WHERE id=$1 AND status='draft' RETURNING *`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Entry not found or already submitted' });
    res.json({ success: true, data: rows[0], message: 'Submitted for review' });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   GET /api/diary/class/:classId/date/:date
   Full diary for a class+date (all entries + publish status).
   Used by incharge, admin, student, parent.
───────────────────────────────────────────────────────── */
const getClassDiary = async (req, res) => {
  try {
    const { classId, date } = req.params;

    const [entriesRes, publishRes, classRes] = await Promise.all([
      pool.query(
        `SELECT de.*,
                s.name AS subject_name, s.code AS subject_code,
                t.full_name AS teacher_name
         FROM diary_entries de
         LEFT JOIN subjects s ON s.id = de.subject_id
         LEFT JOIN teachers t ON t.id = de.teacher_id
         WHERE de.class_id=$1 AND de.date=$2
         ORDER BY s.name ASC`,
        [classId, date],
      ),
      pool.query(
        `SELECT dp.*, t.full_name AS published_by_name
         FROM diary_publishes dp
         LEFT JOIN teachers t ON t.id = dp.published_by
         WHERE dp.class_id=$1 AND dp.date=$2`,
        [classId, date],
      ),
      pool.query(
        `SELECT c.id, c.name, c.grade, c.section,
                t.id AS incharge_id, t.full_name AS incharge_name
         FROM classes c
         LEFT JOIN teachers t ON t.id = c.teacher_id
         WHERE c.id = $1`,
        [classId],
      ),
    ]);

    res.json({
      success: true,
      data: {
        class:    classRes.rows[0]  || null,
        entries:  entriesRes.rows,
        publish:  publishRes.rows[0] || null,
      },
    });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   POST /api/diary/class/:classId/date/:date/publish
   Class incharge / admin publishes the diary.
   All pending entries → published. Generates whatsapp text.
───────────────────────────────────────────────────────── */
const publishDiary = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { classId, date } = req.params;
    const { general_remarks, teacher_id } = req.body;

    // Get class info
    const { rows: [cls] } = await client.query(
      'SELECT name, grade, section FROM classes WHERE id=$1', [classId],
    );
    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

    // Promote all draft/pending entries to published
    await client.query(
      `UPDATE diary_entries SET status='published', updated_at=NOW()
       WHERE class_id=$1 AND date=$2 AND status IN ('draft','pending')`,
      [classId, date],
    );

    // Fetch published entries to build WhatsApp text
    const { rows: entries } = await client.query(
      `SELECT de.*, s.name AS subject_name
       FROM diary_entries de
       LEFT JOIN subjects s ON s.id = de.subject_id
       WHERE de.class_id=$1 AND de.date=$2 AND de.status='published'
       ORDER BY s.name ASC`,
      [classId, date],
    );

    const className = `${cls.grade}-${cls.section}`;
    const whatsapp_text = buildWhatsappText({ className, date, entries, generalRemarks: general_remarks });

    // Upsert publish record
    const { rows: [pub] } = await client.query(
      `INSERT INTO diary_publishes (class_id, date, published_by, general_remarks, whatsapp_text, published_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (class_id, date) DO UPDATE SET
         general_remarks=$4, whatsapp_text=$5,
         published_by=$3, published_at=NOW(), updated_at=NOW()
       RETURNING *`,
      [classId, date, teacher_id || null, general_remarks || null, whatsapp_text],
    );

    await client.query('COMMIT');
    res.json({ success: true, data: pub, message: 'Diary published successfully' });
  } catch (e) {
    await client.query('ROLLBACK');
    err500(res, e);
  } finally {
    client.release();
  }
};

/* ─────────────────────────────────────────────────────────
   DELETE /api/diary/class/:classId/date/:date/publish
   Unpublish — revert published entries back to pending.
───────────────────────────────────────────────────────── */
const unpublishDiary = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { classId, date } = req.params;

    await client.query(
      `UPDATE diary_entries SET status='pending', updated_at=NOW()
       WHERE class_id=$1 AND date=$2 AND status='published'`,
      [classId, date],
    );
    await client.query(
      'DELETE FROM diary_publishes WHERE class_id=$1 AND date=$2',
      [classId, date],
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Diary unpublished' });
  } catch (e) {
    await client.query('ROLLBACK');
    err500(res, e);
  } finally {
    client.release();
  }
};

/* ─────────────────────────────────────────────────────────
   GET /api/diary/week/:classId
   Returns diary publish summary for a week (Mon–Sat).
   Query param: week_start (YYYY-MM-DD, must be a Monday)
───────────────────────────────────────────────────────── */
const getWeekOverview = async (req, res) => {
  try {
    const { classId } = req.params;
    const { week_start } = req.query;

    if (!week_start) return res.status(400).json({ success: false, message: 'week_start required' });

    const { rows } = await pool.query(
      `SELECT
         d.date::text,
         COUNT(de.id)::int AS entry_count,
         COUNT(de.id) FILTER (WHERE de.status='published')::int AS published_count,
         COUNT(de.id) FILTER (WHERE de.status='pending')::int   AS pending_count,
         COUNT(de.id) FILTER (WHERE de.status='draft')::int     AS draft_count,
         dp.published_at,
         dp.general_remarks
       FROM generate_series($1::date, $1::date + INTERVAL '5 days', INTERVAL '1 day') AS d(date)
       LEFT JOIN diary_entries de  ON de.class_id=$2 AND de.date=d.date
       LEFT JOIN diary_publishes dp ON dp.class_id=$2 AND dp.date=d.date
       GROUP BY d.date, dp.published_at, dp.general_remarks
       ORDER BY d.date`,
      [week_start, classId],
    );

    res.json({ success: true, data: rows });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   GET /api/diary/incharge-classes/:teacherId
   Returns classes where this teacher is the class incharge.
───────────────────────────────────────────────────────── */
const getInchargeClasses = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.grade, c.section, c.academic_year
       FROM classes c
       WHERE c.teacher_id = $1 AND c.status = 'active'
       ORDER BY c.grade, c.section`,
      [req.params.teacherId],
    );
    res.json({ success: true, data: rows });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   GET /api/diary/teacher-subjects/:teacherId
   Returns subjects + classes this teacher is assigned to.
───────────────────────────────────────────────────────── */
const getTeacherSubjects = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tsa.class_id, tsa.subject_id,
              c.name AS class_name, c.grade, c.section,
              s.name AS subject_name, s.code AS subject_code
       FROM teacher_subject_assignments tsa
       JOIN classes  c ON c.id = tsa.class_id
       JOIN subjects s ON s.id = tsa.subject_id
       WHERE tsa.teacher_id=$1 AND tsa.is_active=true AND c.status='active'
       ORDER BY c.grade, c.section, s.name`,
      [req.params.teacherId],
    );
    res.json({ success: true, data: rows });
  } catch (e) { err500(res, e); }
};

/* ─────────────────────────────────────────────────────────
   POST /api/diary/upload-attachment
   Upload a file and return the URL (standalone, before saving entry).
───────────────────────────────────────────────────────── */
const uploadAttachment = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const result = await uploadToCloudinary(req.file.buffer, 'schoolms/diary');
    res.json({
      success: true,
      data: { url: result.secure_url, name: req.file.originalname },
    });
  } catch (e) { err500(res, e); }
};

module.exports = {
  getDiaries,
  getDiary,
  createDiary,
  updateDiary,
  deleteDiary,
  submitDiary,
  getClassDiary,
  publishDiary,
  unpublishDiary,
  getWeekOverview,
  getInchargeClasses,
  getTeacherSubjects,
  uploadAttachment,
};
