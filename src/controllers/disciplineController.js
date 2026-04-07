const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/discipline  — list with filters
async function getIncidents(req, res) {
  const { student_id, severity, resolved, from, to, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const vals = [];

  if (student_id) { vals.push(student_id); conditions.push(`di.student_id = $${vals.length}`); }
  if (severity)   { vals.push(severity);   conditions.push(`di.severity = $${vals.length}`); }
  if (resolved !== undefined && resolved !== '')
                  { vals.push(resolved === 'true'); conditions.push(`di.resolved = $${vals.length}`); }
  if (from)       { vals.push(from);       conditions.push(`di.date >= $${vals.length}`); }
  if (to)         { vals.push(to);         conditions.push(`di.date <= $${vals.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  vals.push(+limit, +offset);

  const { rows } = await db.query(
    `SELECT di.*,
            s.name AS student_name, s.roll_number,
            c.name AS class_name,
            u.name AS reported_by_name
     FROM discipline_incidents di
     JOIN students s      ON s.id = di.student_id
     LEFT JOIN classes c  ON c.id = s.class_id
     LEFT JOIN users u    ON u.id = di.reported_by
     ${where}
     ORDER BY di.date DESC, di.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  const countVals = vals.slice(0, -2);
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM discipline_incidents di ${where}`, countVals
  );

  res.json({ success: true, data: rows, total: +count });
}

// GET /api/discipline/:id
async function getIncident(req, res) {
  const { rows: [row] } = await db.query(
    `SELECT di.*, s.name AS student_name, s.roll_number, c.name AS class_name, u.name AS reported_by_name
     FROM discipline_incidents di
     JOIN students s      ON s.id = di.student_id
     LEFT JOIN classes c  ON c.id = s.class_id
     LEFT JOIN users u    ON u.id = di.reported_by
     WHERE di.id = $1`, [req.params.id]
  );
  if (!row) throw new AppError('Incident not found', 404);
  res.json({ success: true, data: row });
}

// POST /api/discipline
async function createIncident(req, res) {
  const {
    student_id, date, incident_type, severity = 'minor',
    description, action_taken, parent_notified = false, follow_up_date,
  } = req.body;

  if (!student_id || !incident_type || !description) {
    throw new AppError('student_id, incident_type and description are required', 400);
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO discipline_incidents
       (student_id, reported_by, date, incident_type, severity, description, action_taken, parent_notified, follow_up_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [student_id, req.user.id, date || new Date().toISOString().slice(0, 10),
     incident_type, severity, description, action_taken || null,
     parent_notified, follow_up_date || null]
  );
  res.status(201).json({ success: true, data: row });
}

// PUT /api/discipline/:id
async function updateIncident(req, res) {
  const { incident_type, severity, description, action_taken, parent_notified, follow_up_date } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE discipline_incidents
     SET incident_type   = COALESCE($1, incident_type),
         severity        = COALESCE($2, severity),
         description     = COALESCE($3, description),
         action_taken    = COALESCE($4, action_taken),
         parent_notified = COALESCE($5, parent_notified),
         follow_up_date  = COALESCE($6, follow_up_date),
         updated_at      = NOW()
     WHERE id = $7 RETURNING *`,
    [incident_type, severity, description, action_taken, parent_notified, follow_up_date, req.params.id]
  );
  if (!row) throw new AppError('Incident not found', 404);
  res.json({ success: true, data: row });
}

// POST /api/discipline/:id/resolve
async function resolveIncident(req, res) {
  const { notes } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE discipline_incidents
     SET resolved = true, resolved_at = NOW(), resolved_notes = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [notes || null, req.params.id]
  );
  if (!row) throw new AppError('Incident not found', 404);
  res.json({ success: true, data: row });
}

// DELETE /api/discipline/:id  (admin only)
async function deleteIncident(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM discipline_incidents WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Incident not found', 404);
  res.json({ success: true, message: 'Incident deleted' });
}

// GET /api/discipline/summary  — stats for dashboard
async function getSummary(req, res) {
  const { rows: bySeverity } = await db.query(
    `SELECT severity, COUNT(*) AS count FROM discipline_incidents
     WHERE date >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY severity`
  );
  const { rows: [{ total }] } = await db.query(
    `SELECT COUNT(*) AS total FROM discipline_incidents WHERE resolved = false`
  );
  const { rows: topStudents } = await db.query(
    `SELECT s.id, s.name, s.roll_number, COUNT(*) AS incident_count
     FROM discipline_incidents di
     JOIN students s ON s.id = di.student_id
     WHERE di.date >= CURRENT_DATE - INTERVAL '90 days'
     GROUP BY s.id, s.name, s.roll_number
     ORDER BY incident_count DESC
     LIMIT 5`
  );
  res.json({ success: true, data: { by_severity: bySeverity, open_count: +total, top_students: topStudents } });
}

module.exports = { getIncidents, getIncident, createIncident, updateIncident, resolveIncident, deleteIncident, getSummary };
