const pool = require('../db');
const { serverErr } = require('../utils/serverErr');

// GET /api/classes
const getClasses = async (req, res) => {
  try {
    const { status, academic_year } = req.query;
    let query = `
      SELECT
        c.*,
        t.id        AS teacher_id,
        t.full_name AS teacher_name,
        t.subject   AS teacher_subject,
        COUNT(s.id)::int AS student_count
      FROM classes c
      LEFT JOIN teachers t ON t.id = c.teacher_id
      LEFT JOIN students s ON s.class_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (status)        { params.push(status);        query += ` AND c.status = $${params.length}`; }
    if (academic_year) { params.push(academic_year); query += ` AND c.academic_year = $${params.length}`; }
    query += ' GROUP BY c.id, t.id ORDER BY c.grade, c.section';

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    return serverErr(res, err);
  }
};

// GET /api/classes/:id
const getClass = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.*,
         t.id        AS teacher_id,
         t.full_name AS teacher_name,
         t.subject   AS teacher_subject,
         COUNT(s.id)::int AS student_count
       FROM classes c
       LEFT JOIN teachers t ON t.id = c.teacher_id
       LEFT JOIN students s ON s.class_id = c.id
       WHERE c.id = $1
       GROUP BY c.id, t.id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Class not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    return serverErr(res, err);
  }
};

// GET /api/classes/:id/students
const getClassStudents = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, full_name_urdu, email, phone, gender, b_form_no,
              roll_number, blood_group, status, admission_date, father_name, father_phone
       FROM students WHERE class_id = $1 ORDER BY roll_number NULLS LAST, full_name`,
      [req.params.id]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    return serverErr(res, err);
  }
};

// POST /api/classes
const createClass = async (req, res) => {
  try {
    const { name, grade, section, academic_year, room_number, capacity, teacher_id, description, status } = req.body;
    if (!name || !grade || !section) {
      return res.status(400).json({ success: false, message: 'Name, grade, and section are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO classes (name, grade, section, academic_year, room_number, capacity, teacher_id, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, grade, section, academic_year || '2024-25', room_number || null, capacity || 40, teacher_id || null, description || null, status || 'active']
    );

    // Keep teacher_classes in sync: add class_teacher role row
    if (teacher_id) {
      await pool.query(
        `INSERT INTO teacher_classes (teacher_id, class_id, role)
         VALUES ($1,$2,'class_teacher')
         ON CONFLICT (teacher_id, class_id, role) DO NOTHING`,
        [teacher_id, rows[0].id]
      );
    }

    res.status(201).json({ success: true, data: rows[0], message: 'Class created successfully' });
  } catch (err) {
    console.error('[CREATE CLASS]', err.message);
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Class with this grade, section, and academic year already exists' });
    return serverErr(res, err);
  }
};

// PUT /api/classes/:id
const updateClass = async (req, res) => {
  try {
    const { name, grade, section, academic_year, room_number, capacity, teacher_id, description, status } = req.body;

    // Capture old teacher to detect change
    const { rows: old } = await pool.query('SELECT teacher_id FROM classes WHERE id=$1', [req.params.id]);
    const oldTeacherId = old[0]?.teacher_id || null;
    const newTeacherId = teacher_id || null;

    const { rows } = await pool.query(
      `UPDATE classes SET name=$1, grade=$2, section=$3, academic_year=$4, room_number=$5,
       capacity=$6, teacher_id=$7, description=$8, status=$9
       WHERE id=$10 RETURNING *`,
      [name, grade, section, academic_year, room_number || null, capacity || 40, newTeacherId, description || null, status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Class not found' });

    // Sync teacher_classes
    if (oldTeacherId && oldTeacherId !== newTeacherId) {
      await pool.query(
        `DELETE FROM teacher_classes WHERE teacher_id=$1 AND class_id=$2 AND role='class_teacher'`,
        [oldTeacherId, req.params.id]
      );
    }
    if (newTeacherId) {
      await pool.query(
        `INSERT INTO teacher_classes (teacher_id, class_id, role)
         VALUES ($1,$2,'class_teacher')
         ON CONFLICT (teacher_id, class_id, role) DO NOTHING`,
        [newTeacherId, req.params.id]
      );
    }

    res.json({ success: true, data: rows[0], message: 'Class updated successfully' });
  } catch (err) {
    console.error('[UPDATE CLASS]', err.message);
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Class with this grade, section, and academic year already exists' });
    return serverErr(res, err);
  }
};

// DELETE /api/classes/:id
const deleteClass = async (req, res) => {
  try {
    const { rows: check } = await pool.query('SELECT COUNT(*)::int AS cnt FROM students WHERE class_id=$1', [req.params.id]);
    if (check[0].cnt > 0) {
      return res.status(409).json({ success: false, message: `Cannot delete: ${check[0].cnt} student(s) are assigned to this class` });
    }
    const { rows } = await pool.query('DELETE FROM classes WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Class not found' });
    res.json({ success: true, message: 'Class deleted successfully' });
  } catch (err) {
    return serverErr(res, err);
  }
};

module.exports = { getClasses, getClass, getClassStudents, createClass, updateClass, deleteClass };
