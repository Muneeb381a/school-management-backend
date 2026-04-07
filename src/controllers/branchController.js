const db = require('../db');
const AppError = require('../utils/AppError');

async function getBranches(req, res) {
  const { rows } = await db.query(
    `SELECT b.*,
            u.name AS principal_name,
            COUNT(DISTINCT s.id) AS student_count,
            COUNT(DISTINCT c.id) AS class_count,
            COUNT(DISTINCT us.id) FILTER (WHERE us.role = 'teacher') AS teacher_count
     FROM branches b
     LEFT JOIN users u  ON u.id = b.principal_id
     LEFT JOIN students s ON s.branch_id = b.id AND s.status = 'active'
     LEFT JOIN classes c  ON c.branch_id = b.id
     LEFT JOIN users us   ON us.branch_id = b.id
     GROUP BY b.id, u.name ORDER BY b.name`
  );
  res.json({ success: true, data: rows });
}

async function getBranch(req, res) {
  const { rows: [row] } = await db.query(
    `SELECT b.*, u.name AS principal_name FROM branches b
     LEFT JOIN users u ON u.id = b.principal_id WHERE b.id = $1`, [req.params.id]
  );
  if (!row) throw new AppError('Branch not found', 404);

  // Recent stats
  const { rows: recentStudents } = await db.query(
    `SELECT id, name, roll_number FROM students WHERE branch_id = $1 AND status = 'active' LIMIT 5`,
    [req.params.id]
  );
  res.json({ success: true, data: { ...row, recent_students: recentStudents } });
}

async function createBranch(req, res) {
  const { name, code, address, city, phone, principal_id, notes } = req.body;
  if (!name) throw new AppError('name is required', 400);
  const { rows: [row] } = await db.query(
    `INSERT INTO branches (name, code, address, city, phone, principal_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, code || null, address || null, city || null, phone || null, principal_id || null, notes || null]
  );
  res.status(201).json({ success: true, data: row });
}

async function updateBranch(req, res) {
  const { name, code, address, city, phone, principal_id, active, notes } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE branches SET
       name         = COALESCE($1, name),
       code         = COALESCE($2, code),
       address      = COALESCE($3, address),
       city         = COALESCE($4, city),
       phone        = COALESCE($5, phone),
       principal_id = COALESCE($6, principal_id),
       active       = COALESCE($7, active),
       notes        = COALESCE($8, notes),
       updated_at   = NOW()
     WHERE id = $9 RETURNING *`,
    [name, code, address, city, phone, principal_id, active, notes, req.params.id]
  );
  if (!row) throw new AppError('Branch not found', 404);
  res.json({ success: true, data: row });
}

async function deleteBranch(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM branches WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Branch not found', 404);
  res.json({ success: true, message: 'Branch deleted' });
}

// Assign an entity to a branch
async function assignToBranch(req, res) {
  const { entity, id } = req.params;  // entity: students | classes | users
  const { branch_id } = req.body;

  const allowed = ['students', 'classes', 'users'];
  if (!allowed.includes(entity)) throw new AppError('Invalid entity type', 400);

  const { rows: [row] } = await db.query(
    `UPDATE ${entity} SET branch_id = $1 WHERE id = $2 RETURNING id`, [branch_id || null, id]
  );
  if (!row) throw new AppError(`${entity.slice(0, -1)} not found`, 404);
  res.json({ success: true, message: `Assigned to branch` });
}

module.exports = { getBranches, getBranch, createBranch, updateBranch, deleteBranch, assignToBranch };
