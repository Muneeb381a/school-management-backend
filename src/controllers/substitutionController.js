const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/substitutions
async function getSubstitutions(req, res) {
  const { date, original_teacher_id, substitute_teacher_id, class_id, status, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const vals = [];

  if (date)                    { vals.push(date);                    conditions.push(`s.date = $${vals.length}`); }
  if (original_teacher_id)     { vals.push(original_teacher_id);     conditions.push(`s.original_teacher_id = $${vals.length}`); }
  if (substitute_teacher_id)   { vals.push(substitute_teacher_id);   conditions.push(`s.substitute_teacher_id = $${vals.length}`); }
  if (class_id)                { vals.push(class_id);                conditions.push(`s.class_id = $${vals.length}`); }
  if (status)                  { vals.push(status);                  conditions.push(`s.status = $${vals.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  vals.push(+limit, +offset);

  const { rows } = await db.query(
    `SELECT s.*,
            ot.name  AS original_teacher_name,
            st.name  AS substitute_teacher_name,
            c.name   AS class_name,
            cb.name  AS created_by_name
     FROM substitutions s
     JOIN users ot    ON ot.id = s.original_teacher_id
     JOIN users st    ON st.id = s.substitute_teacher_id
     JOIN classes c   ON c.id  = s.class_id
     LEFT JOIN users cb ON cb.id = s.created_by
     ${where}
     ORDER BY s.date DESC, s.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  const countVals = vals.slice(0, -2);
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM substitutions s ${where}`, countVals
  );

  res.json({ success: true, data: rows, total: +count });
}

// GET /api/substitutions/today
async function getTodaySubstitutions(req, res) {
  const { rows } = await db.query(
    `SELECT s.*,
            ot.name AS original_teacher_name,
            st.name AS substitute_teacher_name,
            c.name  AS class_name
     FROM substitutions s
     JOIN users ot   ON ot.id = s.original_teacher_id
     JOIN users st   ON st.id = s.substitute_teacher_id
     JOIN classes c  ON c.id  = s.class_id
     WHERE s.date = CURRENT_DATE
     ORDER BY s.period ASC NULLS LAST, s.created_at DESC`
  );
  res.json({ success: true, data: rows });
}

// GET /api/substitutions/available?date=YYYY-MM-DD
async function getAvailableTeachers(req, res) {
  const { date } = req.query;
  if (!date) throw new AppError('date query param required', 400);

  // Teachers who are NOT already the original_teacher on that date
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email
     FROM users u
     WHERE u.role = 'teacher'
       AND u.id NOT IN (
         SELECT original_teacher_id FROM substitutions
         WHERE date = $1 AND status != 'declined'
       )
     ORDER BY u.name`,
    [date]
  );
  res.json({ success: true, data: rows });
}

// POST /api/substitutions
async function createSubstitution(req, res) {
  const {
    original_teacher_id, substitute_teacher_id, class_id,
    subject, date, period, reason, notes,
  } = req.body;

  if (!original_teacher_id || !substitute_teacher_id || !class_id || !date) {
    throw new AppError('original_teacher_id, substitute_teacher_id, class_id and date are required', 400);
  }
  if (original_teacher_id === substitute_teacher_id) {
    throw new AppError('Original and substitute teachers must be different', 400);
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO substitutions
       (original_teacher_id, substitute_teacher_id, class_id, subject, date, period, reason, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [original_teacher_id, substitute_teacher_id, class_id,
     subject || null, date, period || null, reason || null, notes || null, req.user.id]
  );
  res.status(201).json({ success: true, data: row });
}

// PUT /api/substitutions/:id/status  — accept / decline / complete
async function updateStatus(req, res) {
  const { status } = req.body;
  const allowed = ['pending', 'accepted', 'declined', 'completed'];
  if (!allowed.includes(status)) throw new AppError(`status must be one of: ${allowed.join(', ')}`, 400);

  const { rows: [row] } = await db.query(
    `UPDATE substitutions SET status = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!row) throw new AppError('Substitution not found', 404);
  res.json({ success: true, data: row });
}

// PUT /api/substitutions/:id
async function updateSubstitution(req, res) {
  const { substitute_teacher_id, class_id, subject, date, period, reason, notes } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE substitutions
     SET substitute_teacher_id = COALESCE($1, substitute_teacher_id),
         class_id               = COALESCE($2, class_id),
         subject                = COALESCE($3, subject),
         date                   = COALESCE($4, date),
         period                 = COALESCE($5, period),
         reason                 = COALESCE($6, reason),
         notes                  = COALESCE($7, notes),
         updated_at             = NOW()
     WHERE id = $8 RETURNING *`,
    [substitute_teacher_id, class_id, subject, date, period, reason, notes, req.params.id]
  );
  if (!row) throw new AppError('Substitution not found', 404);
  res.json({ success: true, data: row });
}

// DELETE /api/substitutions/:id
async function deleteSubstitution(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM substitutions WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Substitution not found', 404);
  res.json({ success: true, message: 'Substitution deleted' });
}

// GET /api/substitutions/summary
async function getSummary(req, res) {
  const { rows: thisWeek } = await db.query(
    `SELECT COUNT(*) AS count FROM substitutions
     WHERE date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`
  );
  const { rows: byStatus } = await db.query(
    `SELECT status, COUNT(*) AS count FROM substitutions
     WHERE date >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY status`
  );
  const { rows: topOriginal } = await db.query(
    `SELECT u.id, u.name, COUNT(*) AS absences
     FROM substitutions s
     JOIN users u ON u.id = s.original_teacher_id
     WHERE s.date >= CURRENT_DATE - INTERVAL '90 days'
     GROUP BY u.id, u.name ORDER BY absences DESC LIMIT 5`
  );
  res.json({
    success: true,
    data: {
      upcoming_count: +thisWeek[0].count,
      by_status: byStatus,
      frequent_absentees: topOriginal,
    },
  });
}

module.exports = {
  getSubstitutions, getTodaySubstitutions, getAvailableTeachers,
  createSubstitution, updateStatus, updateSubstitution, deleteSubstitution,
  getSummary,
};
