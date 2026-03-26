const pool                = require('../db');
const { sendMail }        = require('../utils/mailer');
const { announcementEmail } = require('../utils/emailTemplates');
const { serverErr } = require('../utils/serverErr');


// ── Shared base SELECT ────────────────────────────────────────
const BASE_SELECT = `
  SELECT
    a.id,
    a.title,
    a.message,
    a.announcement_type,
    a.target_audience,
    a.class_id,
    a.priority,
    a.created_by_type,
    a.created_by_id,
    a.is_active,
    a.expires_at,
    a.created_at,
    a.updated_at,
    c.name    AS class_name,
    c.grade   AS class_grade,
    c.section AS class_section,
    -- Author name resolved at DB layer for 'teacher' type
    CASE
      WHEN a.created_by_type = 'teacher'
      THEN (SELECT t.full_name FROM teachers t WHERE t.id = a.created_by_id)
      ELSE NULL
    END AS created_by_name,
    -- Read count
    (SELECT COUNT(*) FROM announcement_reads ar WHERE ar.announcement_id = a.id) AS read_count
  FROM announcements a
  LEFT JOIN classes c ON c.id = a.class_id
`;

// ══════════════════════════════════════════════════════════════
//  LIST  — GET /api/announcements
//  Query params:
//    audience    = all | students | teachers | parents | class
//    type        = general | exam | fee | event | holiday
//    priority    = low | normal | high | urgent
//    class_id    = number
//    is_active   = true | false | all  (default: all)
//    active_only = true  → is_active=true AND (expires_at IS NULL OR expires_at > NOW())
//    search      = string (searches title + message)
//    limit       = number (default 50)
//    offset      = number (default 0)
// ══════════════════════════════════════════════════════════════
const getAnnouncements = async (req, res) => {
  try {
    const {
      audience, type, priority, class_id,
      is_active, active_only, search,
      limit = 50, offset = 0,
    } = req.query;

    const conditions = [];
    const values     = [];
    const push       = (val) => { values.push(val); return `$${values.length}`; };

    if (audience)     conditions.push(`a.target_audience = ${push(audience)}`);
    if (type)         conditions.push(`a.announcement_type = ${push(type)}`);
    if (priority)     conditions.push(`a.priority = ${push(priority)}`);
    if (class_id)     conditions.push(`a.class_id = ${push(Number(class_id))}`);

    if (active_only === 'true') {
      conditions.push(`a.is_active = TRUE`);
      conditions.push(`(a.expires_at IS NULL OR a.expires_at > NOW())`);
    } else if (is_active === 'true') {
      conditions.push(`a.is_active = TRUE`);
    } else if (is_active === 'false') {
      conditions.push(`a.is_active = FALSE`);
    }

    if (search) {
      conditions.push(`(a.title ILIKE ${push(`%${search}%`)} OR a.message ILIKE $${values.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `${BASE_SELECT}
       ${where}
       ORDER BY
         CASE a.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         a.created_at DESC
       LIMIT ${push(Number(limit))} OFFSET ${push(Number(offset))}`,
      values
    );

    // Total count for pagination
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM announcements a ${where}`,
      values.slice(0, -2) // strip limit/offset params
    );

    res.json({ success: true, data: rows, total: Number(countRows[0].count) });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  ACTIVE BOARD  — GET /api/announcements/active
//  Returns only active, non-expired announcements sorted by priority.
//  Used for the "Notice Board" view.
// ══════════════════════════════════════════════════════════════
const getActiveAnnouncements = async (req, res) => {
  try {
    const { audience, class_id } = req.query;

    const conditions = [
      `a.is_active = TRUE`,
      `(a.expires_at IS NULL OR a.expires_at > NOW())`,
    ];
    const values = [];
    const push   = (val) => { values.push(val); return `$${values.length}`; };

    // If audience filter is given, fetch that audience OR 'all'
    if (audience) {
      conditions.push(`(a.target_audience = ${push(audience)} OR a.target_audience = 'all')`);
    }

    // If class_id is given, include class-targeted ones for this class
    if (class_id) {
      conditions.push(
        `(a.class_id IS NULL OR a.class_id = ${push(Number(class_id))})`
      );
    }

    const { rows } = await pool.query(
      `${BASE_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE a.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         a.created_at DESC`,
      values
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  FOR STUDENTS  — GET /api/announcements/for-students
//  Returns announcements targeting 'all', 'students', or specific class.
// ══════════════════════════════════════════════════════════════
const getForStudents = async (req, res) => {
  try {
    const { class_id } = req.query;
    const conditions = [
      `a.is_active = TRUE`,
      `(a.expires_at IS NULL OR a.expires_at > NOW())`,
      `a.target_audience IN ('all','students','class')`,
    ];
    const values = [];

    if (class_id) {
      values.push(Number(class_id));
      conditions.push(`(a.target_audience != 'class' OR a.class_id = $${values.length})`);
    }

    const { rows } = await pool.query(
      `${BASE_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE a.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         a.created_at DESC`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  FOR TEACHERS  — GET /api/announcements/for-teachers
// ══════════════════════════════════════════════════════════════
const getForTeachers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${BASE_SELECT}
       WHERE a.is_active = TRUE
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
         AND a.target_audience IN ('all','teachers')
       ORDER BY
         CASE a.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         a.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  RECENT  — GET /api/announcements/recent?limit=5
// ══════════════════════════════════════════════════════════════
const getRecent = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 5, 20);
    const { rows } = await pool.query(
      `${BASE_SELECT}
       WHERE a.is_active = TRUE
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  HISTORY  — GET /api/announcements/history
//  Returns ALL announcements including expired and inactive, paginated.
// ══════════════════════════════════════════════════════════════
const getHistory = async (req, res) => {
  try {
    const { limit = 30, offset = 0, type, audience } = req.query;
    const conditions = [];
    const values     = [];
    const push       = (val) => { values.push(val); return `$${values.length}`; };

    if (type)     conditions.push(`a.announcement_type = ${push(type)}`);
    if (audience) conditions.push(`a.target_audience = ${push(audience)}`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${BASE_SELECT}
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ${push(Number(limit))} OFFSET ${push(Number(offset))}`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  SINGLE  — GET /api/announcements/:id
// ══════════════════════════════════════════════════════════════
const getAnnouncementById = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${BASE_SELECT} WHERE a.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Announcement not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  CREATE  — POST /api/announcements
// ══════════════════════════════════════════════════════════════
const createAnnouncement = async (req, res) => {
  try {
    const {
      title, message,
      announcement_type = 'general',
      target_audience   = 'all',
      class_id          = null,
      priority          = 'normal',
      created_by_type   = null,
      created_by_id     = null,
      expires_at        = null,
      is_active         = true,
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message is required' });
    if (target_audience === 'class' && !class_id) {
      return res.status(400).json({ success: false, message: 'class_id is required when target_audience is "class"' });
    }

    const { rows } = await pool.query(
      `INSERT INTO announcements
         (title, message, announcement_type, target_audience, class_id, priority,
          created_by_type, created_by_id, expires_at, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        title.trim(), message.trim(),
        announcement_type, target_audience,
        class_id || null, priority,
        created_by_type || null, created_by_id || null,
        expires_at || null, is_active,
      ]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Announcement created successfully' });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  UPDATE  — PUT /api/announcements/:id
// ══════════════════════════════════════════════════════════════
const updateAnnouncement = async (req, res) => {
  try {
    const {
      title, message, announcement_type, target_audience,
      class_id, priority, expires_at, is_active,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE announcements SET
         title             = COALESCE($1,  title),
         message           = COALESCE($2,  message),
         announcement_type = COALESCE($3,  announcement_type),
         target_audience   = COALESCE($4,  target_audience),
         class_id          = COALESCE($5,  class_id),
         priority          = COALESCE($6,  priority),
         expires_at        = COALESCE($7,  expires_at),
         is_active         = COALESCE($8,  is_active),
         updated_at        = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        title?.trim() || null, message?.trim() || null,
        announcement_type || null, target_audience || null,
        class_id || null, priority || null,
        expires_at || null,
        is_active != null ? is_active : null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Announcement not found' });
    res.json({ success: true, data: rows[0], message: 'Announcement updated' });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  TOGGLE ACTIVE  — PATCH /api/announcements/:id/toggle
// ══════════════════════════════════════════════════════════════
const toggleActive = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE announcements
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, is_active`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Announcement not found' });
    res.json({ success: true, data: rows[0], message: `Announcement ${rows[0].is_active ? 'activated' : 'deactivated'}` });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  DELETE  — DELETE /api/announcements/:id
// ══════════════════════════════════════════════════════════════
const deleteAnnouncement = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM announcements WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Announcement not found' });
    res.json({ success: true, message: 'Announcement deleted permanently' });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  MARK READ  — POST /api/announcements/:id/read
//  body: { reader_type: 'student'|'teacher', reader_id: number }
// ══════════════════════════════════════════════════════════════
const markRead = async (req, res) => {
  try {
    const { reader_type, reader_id } = req.body;
    if (!reader_type || !reader_id) {
      return res.status(400).json({ success: false, message: 'reader_type and reader_id are required' });
    }
    await pool.query(
      `INSERT INTO announcement_reads (announcement_id, reader_type, reader_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (announcement_id, reader_type, reader_id) DO NOTHING`,
      [req.params.id, reader_type, reader_id]
    );
    res.json({ success: true, message: 'Marked as read' });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  READ STATS  — GET /api/announcements/:id/reads
// ══════════════════════════════════════════════════════════════
const getReadStats = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         ar.reader_type,
         ar.reader_id,
         ar.read_at,
         CASE ar.reader_type
           WHEN 'student' THEN (SELECT full_name FROM students WHERE id = ar.reader_id)
           WHEN 'teacher' THEN (SELECT full_name FROM teachers WHERE id = ar.reader_id)
         END AS reader_name
       FROM announcement_reads ar
       WHERE ar.announcement_id = $1
       ORDER BY ar.read_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  SEND EMAIL BROADCAST  — POST /api/announcements/:id/send-email
//  Sends the announcement as an email to the target audience.
//  Returns { emailsSent, skipped }.
// ══════════════════════════════════════════════════════════════
const sendEmail = async (req, res) => {
  try {
    const { rows: annRows } = await pool.query(
      `SELECT * FROM announcements WHERE id = $1`,
      [req.params.id]
    );
    if (!annRows[0]) return res.status(404).json({ success: false, message: 'Announcement not found' });
    const ann = annRows[0];

    const audience = ann.target_audience; // all | students | teachers | parents | class
    const emails   = new Set();

    // Collect student parent emails
    if (['all', 'students', 'parents', 'class'].includes(audience)) {
      let q = `SELECT parent_email FROM students WHERE is_active = TRUE AND parent_email IS NOT NULL AND parent_email <> ''`;
      const params = [];
      if (audience === 'class' && ann.class_id) {
        q += ` AND class_id = $1`;
        params.push(ann.class_id);
      }
      const { rows } = await pool.query(q, params);
      rows.forEach(r => emails.add(r.parent_email.trim().toLowerCase()));
    }

    // Collect teacher emails
    if (['all', 'teachers'].includes(audience)) {
      const { rows } = await pool.query(
        `SELECT email FROM teachers WHERE is_active = TRUE AND email IS NOT NULL AND email <> ''`
      );
      rows.forEach(r => emails.add(r.email.trim().toLowerCase()));
    }

    if (emails.size === 0) {
      return res.json({ success: true, emailsSent: 0, skipped: 0, message: 'No email addresses found for target audience' });
    }

    const template = announcementEmail({
      title:      ann.title,
      message:    ann.message,
      type:       ann.announcement_type,
      priority:   ann.priority,
      schoolName: process.env.SCHOOL_NAME,
    });

    let emailsSent = 0;
    let skipped    = 0;
    const allEmails = [...emails];

    // Send in batches of 10 to avoid overwhelming SMTP
    for (let i = 0; i < allEmails.length; i += 10) {
      const batch = allEmails.slice(i, i + 10);
      await Promise.allSettled(
        batch.map(to =>
          sendMail({ to, subject: template.subject, html: template.html, text: template.text })
            .then(() => { emailsSent++; })
            .catch(() => { skipped++; })
        )
      );
    }

    // Update announcement record
    await pool.query(
      `UPDATE announcements SET email_sent_at = NOW(), email_sent_count = $1 WHERE id = $2`,
      [emailsSent, ann.id]
    );

    res.json({ success: true, emailsSent, skipped, total: emails.size });
  } catch (err) {
    serverErr(res, err);
  }
};

module.exports = {
  getAnnouncements,
  getActiveAnnouncements,
  getForStudents,
  getForTeachers,
  getRecent,
  getHistory,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  toggleActive,
  deleteAnnouncement,
  markRead,
  getReadStats,
  sendEmail,
};
