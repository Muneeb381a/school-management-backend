const { calculateRisk, recalculateAll } = require('../services/riskEngine');
const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/risk/student/:id
async function getStudentRisk(req, res) {
  const { id } = req.params;
  const risk = await calculateRisk(id);
  res.json({ success: true, data: risk });
}

// GET /api/risk/scores  — all cached scores
async function getAllScores(req, res) {
  const { band, limit = 50, offset = 0 } = req.query;
  const vals = [];
  const conditions = [];
  if (band) { vals.push(band); conditions.push(`srs.band = $${vals.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT srs.*, s.name AS student_name, s.roll_number, c.name AS class_name
     FROM student_risk_scores srs
     JOIN students s ON s.id = srs.student_id
     LEFT JOIN classes c ON c.id = s.class_id
     ${where}
     ORDER BY srs.score DESC
     LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
    [...vals, +limit, +offset]
  );
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM student_risk_scores srs ${where}`, vals
  );
  res.json({ success: true, data: rows, total: +count });
}

// POST /api/risk/recalculate  — recalculate all
async function triggerRecalculate(req, res) {
  const result = await recalculateAll();
  res.json({ success: true, data: result });
}

// GET /api/risk/summary
async function getRiskSummary(req, res) {
  const { rows } = await db.query(
    `SELECT band, COUNT(*) AS count FROM student_risk_scores GROUP BY band`
  );
  const summary = rows.reduce((acc, r) => { acc[r.band] = +r.count; return acc; }, {});
  res.json({ success: true, data: summary });
}

module.exports = { getStudentRisk, getAllScores, triggerRecalculate, getRiskSummary };
