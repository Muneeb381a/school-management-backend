const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/complaints
async function getComplaints(req, res) {
  const { status, category, priority, assigned_to, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const vals = [];

  // Non-admin users only see their own complaints (unless viewing anonymously submitted)
  if (req.user.role !== 'admin') {
    vals.push(req.user.id);
    conditions.push(`(c.submitted_by = $${vals.length} AND c.anonymous = false)`);
  }

  if (status)      { vals.push(status);      conditions.push(`c.status = $${vals.length}`); }
  if (category)    { vals.push(category);    conditions.push(`c.category = $${vals.length}`); }
  if (priority)    { vals.push(priority);    conditions.push(`c.priority = $${vals.length}`); }
  if (assigned_to) { vals.push(assigned_to); conditions.push(`c.assigned_to = $${vals.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  vals.push(+limit, +offset);

  const { rows } = await db.query(
    `SELECT c.*,
            CASE WHEN c.anonymous THEN NULL ELSE u.name END AS submitted_by_name,
            a.name AS assigned_to_name,
            (SELECT COUNT(*) FROM complaint_responses cr WHERE cr.complaint_id = c.id) AS response_count
     FROM complaints c
     LEFT JOIN users u ON u.id = c.submitted_by
     LEFT JOIN users a ON a.id = c.assigned_to
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  const countVals = vals.slice(0, -2);
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM complaints c ${where}`, countVals
  );

  res.json({ success: true, data: rows, total: +count });
}

// GET /api/complaints/:id
async function getComplaint(req, res) {
  const { rows: [row] } = await db.query(
    `SELECT c.*,
            CASE WHEN c.anonymous THEN NULL ELSE u.name END AS submitted_by_name,
            a.name AS assigned_to_name
     FROM complaints c
     LEFT JOIN users u ON u.id = c.submitted_by
     LEFT JOIN users a ON a.id = c.assigned_to
     WHERE c.id = $1`, [req.params.id]
  );
  if (!row) throw new AppError('Complaint not found', 404);

  // Non-admin can only view own non-anonymous complaints
  if (req.user.role !== 'admin' && row.submitted_by !== req.user.id) {
    throw new AppError('Not authorised', 403);
  }

  // Fetch responses (filter internal for non-admins)
  const { rows: responses } = await db.query(
    `SELECT cr.*, u.name AS author_name
     FROM complaint_responses cr
     LEFT JOIN users u ON u.id = cr.author_id
     WHERE cr.complaint_id = $1 ${req.user.role !== 'admin' ? 'AND cr.internal = false' : ''}
     ORDER BY cr.created_at ASC`,
    [req.params.id]
  );

  res.json({ success: true, data: { ...row, responses } });
}

// POST /api/complaints
async function createComplaint(req, res) {
  const { category, subject, description, anonymous = false, priority = 'normal' } = req.body;
  if (!category || !subject || !description) {
    throw new AppError('category, subject and description are required', 400);
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO complaints (submitted_by, category, subject, description, anonymous, priority)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.user.id, category, subject, description, anonymous, priority]
  );
  res.status(201).json({ success: true, data: row });
}

// POST /api/complaints/:id/respond
async function addResponse(req, res) {
  const { message, internal = false } = req.body;
  if (!message) throw new AppError('message is required', 400);

  const { rows: [complaint] } = await db.query(
    `SELECT * FROM complaints WHERE id = $1`, [req.params.id]
  );
  if (!complaint) throw new AppError('Complaint not found', 404);

  // Non-admin can only respond to their own complaints
  if (req.user.role !== 'admin' && complaint.submitted_by !== req.user.id) {
    throw new AppError('Not authorised', 403);
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO complaint_responses (complaint_id, author_id, message, internal)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.params.id, req.user.id, message, req.user.role === 'admin' ? internal : false]
  );

  // Auto-update status to in_review if still open
  if (complaint.status === 'open' && req.user.role === 'admin') {
    await db.query(
      `UPDATE complaints SET status = 'in_review', updated_at = NOW() WHERE id = $1 AND status = 'open'`,
      [req.params.id]
    );
  }

  res.status(201).json({ success: true, data: row });
}

// PUT /api/complaints/:id  — admin: update status, priority, assigned_to, resolution
async function updateComplaint(req, res) {
  const { status, priority, assigned_to, resolution } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE complaints
     SET status      = COALESCE($1, status),
         priority    = COALESCE($2, priority),
         assigned_to = COALESCE($3, assigned_to),
         resolution  = COALESCE($4, resolution),
         resolved_at = CASE WHEN $1 IN ('resolved', 'closed') THEN NOW() ELSE resolved_at END,
         updated_at  = NOW()
     WHERE id = $5 RETURNING *`,
    [status, priority, assigned_to, resolution, req.params.id]
  );
  if (!row) throw new AppError('Complaint not found', 404);
  res.json({ success: true, data: row });
}

// DELETE /api/complaints/:id  (admin only)
async function deleteComplaint(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM complaints WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Complaint not found', 404);
  res.json({ success: true, message: 'Complaint deleted' });
}

// GET /api/complaints/summary
async function getSummary(req, res) {
  const { rows: byStatus } = await db.query(
    `SELECT status, COUNT(*) AS count FROM complaints GROUP BY status`
  );
  const { rows: byCategory } = await db.query(
    `SELECT category, COUNT(*) AS count FROM complaints
     WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY category`
  );
  const { rows: [{ urgent }] } = await db.query(
    `SELECT COUNT(*) AS urgent FROM complaints WHERE priority = 'urgent' AND status = 'open'`
  );
  res.json({
    success: true,
    data: { by_status: byStatus, by_category: byCategory, urgent_open: +urgent },
  });
}

module.exports = {
  getComplaints, getComplaint, createComplaint, addResponse,
  updateComplaint, deleteComplaint, getSummary,
};
