const { solve } = require('../services/timetableSolver');
const db = require('../db');
const AppError = require('../utils/AppError');

// Day name → integer (matches timetable_entries.day_of_week)
const DAY_NUM = {
  Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7,
};

// POST /api/timetable-generator/generate
async function generate(req, res) {
  const { days, periods_per_day, class_ids } = req.body;
  if (!days || !periods_per_day) throw new AppError('days and periods_per_day are required', 400);

  // Load classes
  let classQuery = `SELECT id, name FROM classes WHERE status = 'active'`;
  const params = [];
  if (class_ids?.length) {
    params.push(class_ids);
    classQuery += ` AND id = ANY($1::int[])`;
  }
  const { rows: classes } = await db.query(classQuery, params);
  if (!classes.length) throw new AppError('No active classes found', 400);

  // Load teachers
  const { rows: teachers } = await db.query(
    `SELECT id, full_name AS name,
            COALESCE(max_periods_per_day, 5) AS max_periods_per_day
     FROM teachers
     WHERE status = 'active'`
  );

  // Load subjects with teacher assignment per class
  const classIds = classes.map(c => c.id);
  const { rows: subjects } = await db.query(
    `SELECT s.id AS subject_id, s.name AS subject_name,
            cs.class_id, cs.teacher_id,
            COALESCE(s.periods_per_week, 1) AS periods_per_week
     FROM subjects s
     JOIN class_subjects cs ON cs.subject_id = s.id
     WHERE cs.class_id = ANY($1::int[]) AND s.is_active = true`,
    [classIds]
  );

  if (!subjects.length) {
    throw new AppError(
      'No subjects assigned to the selected classes. ' +
      'Go to Subjects → assign subjects to classes first.',
      400
    );
  }

  const result = solve({ classes, teachers, subjects, days, periodsPerDay: +periods_per_day });

  // Enrich slots with display names (needed for preview + save)
  const subjectMap = Object.fromEntries(subjects.map(s => [
    `${s.class_id}:${s.subject_id}`, s.subject_name,
  ]));
  const teacherMap = Object.fromEntries(teachers.map(t => [t.id, t.name]));

  result.slots = result.slots.map(s => ({
    ...s,
    subject_name: subjectMap[`${s.class_id}:${s.subject_id}`] || `Subject ${s.subject_id}`,
    teacher_name: teacherMap[s.teacher_id] || `Teacher ${s.teacher_id}`,
  }));

  res.json({ success: true, data: result });
}

// POST /api/timetable-generator/save  — persist generated timetable to DB
async function saveGenerated(req, res) {
  const { slots } = req.body;
  if (!slots?.length) throw new AppError('slots is required', 400);

  // Clear existing auto-generated entries (keep manual ones)
  await db.query(`DELETE FROM timetable_entries WHERE auto_generated = true`);

  // Parameterized bulk insert — maps solver output to actual DB columns:
  //   subject_name → subject  (varchar)
  //   day          → day_of_week (integer, Monday=1)
  //   period       → period_id (integer)
  const params = [];
  const placeholders = slots.map((s, i) => {
    const base = i * 5;
    const dayNum = typeof s.day === 'string' ? (DAY_NUM[s.day] ?? 1) : s.day;
    const subjectText = s.subject_name || s.subject || `Subject ${s.subject_id}`;
    params.push(s.class_id, dayNum, s.period, s.teacher_id, subjectText);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true, NOW())`;
  }).join(',');

  await db.query(
    `INSERT INTO timetable_entries
       (class_id, day_of_week, period_id, teacher_id, subject, auto_generated, created_at)
     VALUES ${placeholders}`,
    params
  );

  res.json({ success: true, message: `${slots.length} slots saved` });
}

module.exports = { generate, saveGenerated };
