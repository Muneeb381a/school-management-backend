const db = require('../db');
const AppError = require('../utils/AppError');

const STEPS = [
  { key: 'school_info',    label: 'School Info',       required: true },
  { key: 'admin_account',  label: 'Admin Account',     required: true },
  { key: 'classes',        label: 'Classes & Sections', required: true },
  { key: 'subjects',       label: 'Subjects',           required: false },
  { key: 'teachers',       label: 'Teachers',           required: false },
  { key: 'fee_structure',  label: 'Fee Structure',      required: false },
  { key: 'whatsapp',       label: 'WhatsApp Setup',     required: false },
];

// GET /api/onboarding/progress
async function getProgress(req, res) {
  const completed = [];
  const schema = req.schema;

  // School info
  const { rows: [school] } = await db.raw.query(
    `SELECT name, address, phone FROM public.schools WHERE schema_name = $1`, [schema]
  );
  if (school?.name && school?.phone) completed.push('school_info');

  // Admin account exists = always true if they're logged in
  completed.push('admin_account');

  // Classes
  const { rows: [cc] } = await db.query(`SELECT COUNT(*) FROM classes`);
  if (+cc.count > 0) completed.push('classes');

  // Subjects
  const { rows: [sc] } = await db.query(`SELECT COUNT(*) FROM subjects`);
  if (+sc.count > 0) completed.push('subjects');

  // Teachers
  const { rows: [tc] } = await db.query(`SELECT COUNT(*) FROM teachers`);
  if (+tc.count > 0) completed.push('teachers');

  // Fee structure
  const { rows: [fc] } = await db.query(`SELECT COUNT(*) FROM fee_structures`);
  if (+fc.count > 0) completed.push('fee_structure');

  // WhatsApp — check settings table
  const { rows: [wa] } = await db.query(
    `SELECT value FROM settings WHERE key = 'wa_enabled'`
  ).catch(() => ({ rows: [] }));
  if (wa?.value === 'true') completed.push('whatsapp');

  const steps = STEPS.map(s => ({ ...s, completed: completed.includes(s.key) }));
  const pct = Math.round((completed.length / STEPS.length) * 100);
  res.json({ success: true, data: { steps, percent: pct, completed_count: completed.length, total: STEPS.length } });
}

// POST /api/onboarding/school-info
async function saveSchoolInfo(req, res) {
  const { name, address, phone, logo_url } = req.body;
  if (!name) throw new AppError('School name is required', 400);
  await db.raw.query(
    `UPDATE public.schools SET name = $1, address = $2, phone = $3, logo_url = $4 WHERE schema_name = $5`,
    [name, address, phone, logo_url, req.schema]
  );
  res.json({ success: true, message: 'School info saved' });
}

// POST /api/onboarding/complete
async function markComplete(req, res) {
  await db.raw.query(
    `UPDATE public.schools SET onboarding_complete = true WHERE schema_name = $1`,
    [req.schema]
  );
  res.json({ success: true, message: 'Onboarding complete' });
}

module.exports = { getProgress, saveSchoolInfo, markComplete };
