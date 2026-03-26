const pool = require('../db');
const { serverErr } = require('../utils/serverErr');

// ══════════════════════════════════════════════════════════════
//  SUBJECTS — master catalogue CRUD
// ══════════════════════════════════════════════════════════════

// GET /api/subjects
const getSubjects = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM subjects ORDER BY name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    return serverErr(res, err);
  }
};

// POST /api/subjects
const createSubject = async (req, res) => {
  try {
    const { name, code, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Subject name is required' });

    const { rows } = await pool.query(
      `INSERT INTO subjects (name, code, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), code?.trim() || null, description?.trim() || null]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Subject created successfully' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A subject with this name or code already exists' });
    return serverErr(res, err);
  }
};

// PUT /api/subjects/:id
const updateSubject = async (req, res) => {
  try {
    const { name, code, description, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Subject name is required' });

    const { rows } = await pool.query(
      `UPDATE subjects SET name=$1, code=$2, description=$3, is_active=$4
       WHERE id=$5 RETURNING *`,
      [name.trim(), code?.trim() || null, description?.trim() || null, is_active ?? true, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Subject not found' });
    res.json({ success: true, data: rows[0], message: 'Subject updated successfully' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A subject with this name or code already exists' });
    return serverErr(res, err);
  }
};

// DELETE /api/subjects/:id
const deleteSubject = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM subjects WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Subject not found' });
    res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (err) {
    return serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  CLASS SUBJECTS — assign / remove subjects from a class
// ══════════════════════════════════════════════════════════════

// GET /api/subjects/class/:classId?academic_year=2024-25
const getClassSubjects = async (req, res) => {
  try {
    const { academic_year = '2024-25' } = req.query;
    const { rows } = await pool.query(
      `SELECT
         cs.id,
         cs.class_id,
         cs.subject_id,
         cs.academic_year,
         cs.is_active,
         s.name        AS subject_name,
         s.code        AS subject_code,
         tsa.teacher_id,
         t.full_name   AS teacher_name,
         t.phone       AS teacher_phone
       FROM class_subjects cs
       JOIN subjects s ON s.id = cs.subject_id
       LEFT JOIN teacher_subject_assignments tsa
         ON tsa.subject_id    = cs.subject_id
        AND tsa.class_id      = cs.class_id
        AND tsa.academic_year = cs.academic_year
       LEFT JOIN teachers t ON t.id = tsa.teacher_id
       WHERE cs.class_id = $1 AND cs.academic_year = $2
       ORDER BY s.name`,
      [req.params.classId, academic_year]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    return serverErr(res, err);
  }
};

// POST /api/subjects/class/:classId
const assignSubjectToClass = async (req, res) => {
  try {
    const { subject_id, academic_year = '2024-25' } = req.body;
    const class_id = req.params.classId;
    if (!subject_id) return res.status(400).json({ success: false, message: 'subject_id is required' });

    const { rows } = await pool.query(
      `INSERT INTO class_subjects (class_id, subject_id, academic_year)
       VALUES ($1, $2, $3)
       ON CONFLICT (class_id, subject_id, academic_year) DO UPDATE SET is_active = TRUE
       RETURNING *`,
      [class_id, subject_id, academic_year]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Subject assigned to class' });
  } catch (err) {
    return serverErr(res, err);
  }
};

// DELETE /api/subjects/class-subject/:id
const removeSubjectFromClass = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM class_subjects WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Assignment not found' });
    res.json({ success: true, message: 'Subject removed from class' });
  } catch (err) {
    return serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  TEACHER SUBJECT ASSIGNMENTS
// ══════════════════════════════════════════════════════════════

// POST /api/subjects/assign-teacher
//   body: { teacher_id, subject_id, class_id, academic_year }
//   Upserts: if assignment already exists, swaps the teacher.
const assignTeacherToSubject = async (req, res) => {
  try {
    const { teacher_id, subject_id, class_id, academic_year = '2024-25' } = req.body;
    if (!teacher_id || !subject_id || !class_id) {
      return res.status(400).json({ success: false, message: 'teacher_id, subject_id, and class_id are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id, academic_year)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subject_id, class_id, academic_year)
       DO UPDATE SET teacher_id = EXCLUDED.teacher_id, is_active = TRUE
       RETURNING *`,
      [teacher_id, subject_id, class_id, academic_year]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Teacher assigned to subject' });
  } catch (err) {
    return serverErr(res, err);
  }
};

// DELETE /api/subjects/teacher-assignment/:id
const removeTeacherAssignment = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM teacher_subject_assignments WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Assignment not found' });
    res.json({ success: true, message: 'Teacher assignment removed' });
  } catch (err) {
    return serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  FULL SCHEDULE — subjects + assigned teachers for a class
// ══════════════════════════════════════════════════════════════

// GET /api/subjects/schedule/:classId?academic_year=2024-25
const getClassSchedule = async (req, res) => {
  try {
    const { academic_year = '2024-25' } = req.query;
    const { rows } = await pool.query(
      `SELECT
         c.id          AS class_id,
         c.name        AS class_name,
         c.grade,
         c.section,
         s.id          AS subject_id,
         s.name        AS subject_name,
         s.code        AS subject_code,
         t.id          AS teacher_id,
         t.full_name   AS teacher_name,
         t.phone       AS teacher_phone,
         t.email       AS teacher_email
       FROM class_subjects cs
       JOIN classes  c  ON c.id = cs.class_id
       JOIN subjects s  ON s.id = cs.subject_id
       LEFT JOIN teacher_subject_assignments tsa
         ON tsa.subject_id    = cs.subject_id
        AND tsa.class_id      = cs.class_id
        AND tsa.academic_year = cs.academic_year
       LEFT JOIN teachers t ON t.id = tsa.teacher_id
       WHERE cs.class_id = $1 AND cs.academic_year = $2
       ORDER BY s.name`,
      [req.params.classId, academic_year]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    return serverErr(res, err);
  }
};

// GET /api/subjects/all-schedules?academic_year=2024-25
//   Returns the full school-wide subject schedule (all classes)
const getAllSchedules = async (req, res) => {
  try {
    const { academic_year = '2024-25' } = req.query;
    const { rows } = await pool.query(
      `SELECT
         c.id          AS class_id,
         c.name        AS class_name,
         c.grade,
         c.section,
         s.id          AS subject_id,
         s.name        AS subject_name,
         s.code        AS subject_code,
         t.id          AS teacher_id,
         t.full_name   AS teacher_name
       FROM class_subjects cs
       JOIN classes  c  ON c.id = cs.class_id
       JOIN subjects s  ON s.id = cs.subject_id
       LEFT JOIN teacher_subject_assignments tsa
         ON tsa.subject_id    = cs.subject_id
        AND tsa.class_id      = cs.class_id
        AND tsa.academic_year = cs.academic_year
       LEFT JOIN teachers t ON t.id = tsa.teacher_id
       WHERE cs.academic_year = $1
       ORDER BY c.grade, c.section, s.name`,
      [academic_year]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    return serverErr(res, err);
  }
};

module.exports = {
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getClassSubjects,
  assignSubjectToClass,
  removeSubjectFromClass,
  assignTeacherToSubject,
  removeTeacherAssignment,
  getClassSchedule,
  getAllSchedules,
};
