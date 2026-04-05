const { solve } = require('../services/timetableSolver');
const db = require('../db');
const AppError = require('../utils/AppError');

// POST /api/timetable-generator/generate
async function generate(req, res) {
  const { days, periods_per_day, class_ids } = req.body;
  if (!days || !periods_per_day) throw new AppError('days and periods_per_day are required', 400);

  // Load classes
  let classQuery = `SELECT id, name FROM classes`;
  const params = [];
  if (class_ids?.length) { params.push(class_ids); classQuery += ` WHERE id = ANY($1::int[])`; }
  const { rows: classes } = await db.query(classQuery, params);

  // Load teachers
  const { rows: teachers } = await db.query(
    `SELECT t.id, t.name, COALESCE(t.max_periods_per_day, 5) AS max_periods_per_day FROM teachers t`
  );

  // Load subjects with assigned teacher per class
  const classIds = classes.map(c => c.id);
  const { rows: subjects } = await db.query(
    `SELECT s.id AS subject_id, s.name, cs.class_id, cs.teacher_id,
            COALESCE(s.periods_per_week, 1) AS periods_per_week
     FROM subjects s
     JOIN class_subjects cs ON cs.subject_id = s.id
     WHERE cs.class_id = ANY($1::int[])`,
    [classIds]
  );

  if (!subjects.length) throw new AppError('No subjects configured for the selected classes', 400);

  const result = solve({ classes, teachers, subjects, days, periodsPerDay: +periods_per_day });

  res.json({ success: true, data: result });
}

// POST /api/timetable-generator/save  — save generated timetable to DB
async function saveGenerated(req, res) {
  const { slots } = req.body;
  if (!slots?.length) throw new AppError('slots is required', 400);

  // Clear existing auto-generated entries first (keep manually created ones)
  await db.query(`DELETE FROM timetable WHERE auto_generated = true`);

  const values = slots.map(s =>
    `(${s.class_id}, ${s.subject_id}, ${s.teacher_id}, '${s.day}', ${s.period}, true, NOW())`
  ).join(',');

  await db.query(
    `INSERT INTO timetable (class_id, subject_id, teacher_id, day, period, auto_generated, created_at)
     VALUES ${values}`
  );

  res.json({ success: true, message: `${slots.length} slots saved` });
}

module.exports = { generate, saveGenerated };
