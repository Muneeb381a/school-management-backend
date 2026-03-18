const pool = require('../db');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');

/* ── helpers ── */
const notFound = (res) => res.status(404).json({ success: false, message: 'Teacher not found' });
const serverErr = (res, err) => {
  console.error('[TEACHER]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// ─────────────────────────────────────────────
//  GET /api/teachers
// ─────────────────────────────────────────────
const getTeachers = async (req, res) => {
  try {
    const { search, status } = req.query;

    let query = `
      SELECT
        t.*,
        COUNT(DISTINCT tc.class_id)::int  AS class_count,
        COUNT(DISTINCT s.id)::int         AS student_count
      FROM teachers t
      LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id
      LEFT JOIN classes          c  ON c.id = tc.class_id
      LEFT JOIN students         s  ON s.class_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND t.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (t.full_name ILIKE $${params.length}
                   OR t.email    ILIKE $${params.length}
                   OR t.subject  ILIKE $${params.length})`;
    }

    query += ' GROUP BY t.id ORDER BY t.full_name';

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  GET /api/teachers/:id
// ─────────────────────────────────────────────
const getTeacher = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         t.*,
         COUNT(DISTINCT tc.class_id)::int AS class_count,
         COUNT(DISTINCT s.id)::int        AS student_count
       FROM teachers t
       LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id
       LEFT JOIN classes          c  ON c.id = tc.class_id
       LEFT JOIN students         s  ON s.class_id = c.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [req.params.id]
    );
    if (!rows[0]) return notFound(res);
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  GET /api/teachers/:id/classes
//  Returns classes where teacher is the class_teacher
//  OR has a teacher_classes assignment.
// ─────────────────────────────────────────────
const getTeacherClasses = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT
         c.*,
         COUNT(s.id)::int AS student_count,
         tc.role,
         tc.subject AS assigned_subject
       FROM classes c
       LEFT JOIN students      s  ON s.class_id = c.id
       LEFT JOIN teacher_classes tc ON tc.class_id = c.id AND tc.teacher_id = $1
       WHERE c.teacher_id = $1
          OR tc.teacher_id = $1
       GROUP BY c.id, tc.role, tc.subject
       ORDER BY c.grade, c.section`,
      [req.params.id]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  GET /api/teachers/:id/students
//  Returns all students in classes taught by this teacher.
// ─────────────────────────────────────────────
const getTeacherStudents = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT
         s.id, s.full_name, s.email, s.phone, s.gender, s.b_form_no,
         s.roll_number, s.status, s.admission_date,
         s.grade, s.class_id,
         c.name AS class_name
       FROM students s
       JOIN classes c ON c.id = s.class_id
       WHERE c.teacher_id = $1
          OR c.id IN (
               SELECT class_id FROM teacher_classes WHERE teacher_id = $1
             )
       ORDER BY c.name, s.full_name`,
      [req.params.id]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  POST /api/teachers
// ─────────────────────────────────────────────
const createTeacher = async (req, res) => {
  try {
    const {
      full_name, email, phone, gender, date_of_birth,
      qualification, subject, join_date, status, address, assigned_grades,
    } = req.body;

    if (!full_name?.trim()) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO teachers
         (full_name, email, phone, gender, date_of_birth,
          qualification, subject, join_date, status, address, assigned_grades)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        full_name.trim(),
        email     || null,
        phone     || null,
        gender    || null,
        date_of_birth || null,
        qualification || null,
        subject   || null,
        join_date || null,
        status    || 'active',
        address   || null,
        assigned_grades?.length ? assigned_grades : null,
      ]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Teacher added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'A teacher with this email already exists' });
    }
    serverErr(res, err);
  }
};

// ─────────────────────────────────────────────
//  PUT /api/teachers/:id
// ─────────────────────────────────────────────
const updateTeacher = async (req, res) => {
  try {
    const {
      full_name, email, phone, gender, date_of_birth,
      qualification, subject, join_date, status, address, assigned_grades,
    } = req.body;

    if (!full_name?.trim()) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }

    const { rows } = await pool.query(
      `UPDATE teachers SET
         full_name=$1, email=$2, phone=$3, gender=$4, date_of_birth=$5,
         qualification=$6, subject=$7, join_date=$8, status=$9,
         address=$10, assigned_grades=$11
       WHERE id=$12
       RETURNING *`,
      [
        full_name.trim(),
        email     || null,
        phone     || null,
        gender    || null,
        date_of_birth || null,
        qualification || null,
        subject   || null,
        join_date || null,
        status    || 'active',
        address   || null,
        assigned_grades?.length ? assigned_grades : null,
        req.params.id,
      ]
    );
    if (!rows[0]) return notFound(res);
    res.json({ success: true, data: rows[0], message: 'Teacher updated successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'A teacher with this email already exists' });
    }
    serverErr(res, err);
  }
};

// ─────────────────────────────────────────────
//  DELETE /api/teachers/:id
// ─────────────────────────────────────────────
const deleteTeacher = async (req, res) => {
  try {
    // Check if they are the class_teacher of any active class
    const { rows: check } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM classes WHERE teacher_id = $1`,
      [req.params.id]
    );
    if (check[0].cnt > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete: teacher is assigned as class teacher for ${check[0].cnt} class(es). Reassign them first.`,
      });
    }

    const { rows } = await pool.query(
      'DELETE FROM teachers WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return notFound(res);
    res.json({ success: true, message: 'Teacher deleted successfully' });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  POST /api/teachers/:id/classes  — assign teacher to a class
//  Body: { class_id, subject, role }
// ─────────────────────────────────────────────
const assignTeacherToClass = async (req, res) => {
  try {
    const { class_id, subject, role = 'subject_teacher' } = req.body;
    if (!class_id) {
      return res.status(400).json({ success: false, message: 'class_id is required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO teacher_classes (teacher_id, class_id, subject, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (teacher_id, class_id, role) DO UPDATE
         SET subject = EXCLUDED.subject
       RETURNING *`,
      [req.params.id, class_id, subject || null, role]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Teacher assigned to class' });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  POST /api/teachers/:id/photo
// ─────────────────────────────────────────────
const uploadPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const { rows: old } = await pool.query('SELECT photo_url FROM teachers WHERE id=$1', [req.params.id]);
    if (old[0]?.photo_url) await deleteFromCloudinary(old[0].photo_url);
    const result = await uploadToCloudinary(req.file.buffer, 'teachers/photos');
    const { rows } = await pool.query(
      'UPDATE teachers SET photo_url=$1 WHERE id=$2 RETURNING id, photo_url',
      [result.secure_url, req.params.id]
    );
    if (!rows[0]) return notFound(res);
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  GET /api/teachers/:id/documents
// ─────────────────────────────────────────────
const listDocuments = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM teacher_documents WHERE teacher_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  POST /api/teachers/:id/documents
// ─────────────────────────────────────────────
const uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const { name = req.file.originalname, doc_type = 'other' } = req.body;
    const result = await uploadToCloudinary(req.file.buffer, 'teachers/docs');
    const { rows } = await pool.query(
      `INSERT INTO teacher_documents (teacher_id, name, file_url, doc_type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name, result.secure_url, doc_type]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  DELETE /api/teachers/:id/documents/:docId
// ─────────────────────────────────────────────
const deleteDocument = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM teacher_documents WHERE id=$1 AND teacher_id=$2 RETURNING *',
      [req.params.docId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Document not found' });
    await deleteFromCloudinary(rows[0].file_url);
    res.json({ success: true, message: 'Document deleted' });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  DELETE /api/teachers/:id/classes/:classId — remove assignment
// ─────────────────────────────────────────────
const removeTeacherFromClass = async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM teacher_classes WHERE teacher_id=$1 AND class_id=$2',
      [req.params.id, req.params.classId]
    );
    res.json({ success: true, message: 'Assignment removed' });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getTeachers,
  getTeacher,
  getTeacherClasses,
  getTeacherStudents,
  createTeacher,
  updateTeacher,
  deleteTeacher,
  assignTeacherToClass,
  removeTeacherFromClass,
  uploadPhoto,
  listDocuments,
  uploadDocument,
  deleteDocument,
};
