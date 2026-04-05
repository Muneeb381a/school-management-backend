const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/audit/logs
async function getLogs(req, res) {
  const { user_id, action, entity, from, to, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const vals = [];

  if (user_id) { vals.push(user_id); conditions.push(`al.user_id = $${vals.length}`); }
  if (action)  { vals.push(action);  conditions.push(`al.action ILIKE $${vals.length}`); }
  if (entity)  { vals.push(entity);  conditions.push(`al.entity ILIKE $${vals.length}`); }
  if (from)    { vals.push(from);    conditions.push(`al.created_at >= $${vals.length}`); }
  if (to)      { vals.push(to);      conditions.push(`al.created_at <= $${vals.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  vals.push(+limit, +offset);

  const { rows } = await db.query(
    `SELECT al.*, u.name AS user_name, u.role AS user_role
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     ${where}
     ORDER BY al.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  const countVals = vals.slice(0, -2);
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM audit_logs al ${where}`, countVals
  );

  res.json({ success: true, data: rows, total: +count });
}

// GET /api/audit/logs/:id
async function getLog(req, res) {
  const { rows: [log] } = await db.query(
    `SELECT * FROM audit_logs WHERE id = $1`, [req.params.id]
  );
  if (!log) throw new AppError('Log not found', 404);
  res.json({ success: true, data: log });
}

// GET /api/audit/summary
async function getSummary(req, res) {
  const { rows } = await db.query(
    `SELECT action, COUNT(*) AS count
     FROM audit_logs
     WHERE created_at >= NOW() - INTERVAL '7 days'
     GROUP BY action
     ORDER BY count DESC
     LIMIT 20`
  );
  res.json({ success: true, data: rows });
}

module.exports = { getLogs, getLog, getSummary };
