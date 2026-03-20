const bcrypt   = require('bcryptjs');
const pool     = require('../db');
const AppError = require('../utils/AppError');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');

const ALL_FIELDS = [
  'class_id',
  'full_name','full_name_urdu','date_of_birth','place_of_birth','gender',
  'religion','nationality','b_form_no','blood_group',
  'email','phone','emergency_contact','address','city','province','postal_code',
  'grade','section','roll_number','admission_date',
  'previous_school','previous_class','previous_marks','leaving_reason',
  'father_name','father_cnic','father_occupation','father_education','father_phone','father_email',
  'mother_name','mother_cnic','mother_occupation','mother_phone',
  'guardian_name','guardian_relation','guardian_phone','guardian_cnic',
  'medical_condition','allergies','disability',
  'transport_required','transport_route','hostel_required',
  'siblings_in_school','extra_curricular','house_color','status',
];

const DATE_FIELDS    = ['date_of_birth', 'admission_date'];
const BOOLEAN_FIELDS = ['transport_required', 'hostel_required'];

function pickFields(body) {
  const result = {};
  for (const f of ALL_FIELDS) {
    let val = body[f] !== undefined ? body[f] : null;
    if (val === '') val = null;
    if (DATE_FIELDS.includes(f) && !val) val = null;
    if (BOOLEAN_FIELDS.includes(f)) val = val === true || val === 'true';
    result[f] = val;
  }
  return result;
}

function buildUsername(fullName, id) {
  const clean = (fullName || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4).padEnd(3, 'x');
  return `stu_${clean}${id}`;
}

const getAllStudents = async (req, res, next) => {
  try {
    const { search, grade, status, class_id } = req.query;
    const { page, limit, offset }             = parsePagination(req.query);

    let where  = 'WHERE s.deleted_at IS NULL';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      where += ` AND (s.full_name ILIKE $${p} OR s.email ILIKE $${p} OR s.b_form_no ILIKE $${p})`;
    }
    if (grade)    { params.push(grade);    where += ` AND s.grade = $${params.length}`; }
    if (status)   { params.push(status);   where += ` AND s.status = $${params.length}`; }
    if (class_id) { params.push(class_id); where += ` AND s.class_id = $${params.length}`; }

    const selectCols = `
      s.id, s.full_name, s.full_name_urdu, s.email, s.phone, s.grade, s.section,
      s.roll_number, s.gender, s.b_form_no, s.blood_group, s.city, s.province,
      s.status, s.admission_date, s.created_at, s.class_id, s.photo_url,
      c.name AS class_name, c.section AS class_section`;

    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM students s ${where}`, params),
      pool.query(
        `SELECT ${selectCols}
         FROM students s LEFT JOIN classes c ON c.id = s.class_id
         ${where}
         ORDER BY s.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].total, 10);
    res.json({ success: true, data: dataRes.rows, meta: paginationMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
};

const getStudentById = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Student not found.', 404);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
};

const createStudent = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fields = pickFields(req.body);

    const keys         = Object.keys(fields);
    const values       = Object.values(fields);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await client.query(
      `INSERT INTO students (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    const student  = rows[0];
    const username = buildUsername(student.full_name, student.id);
    const rawPw    = `Stu@${student.id}`;
    const hashed   = await bcrypt.hash(rawPw, 10);
    await client.query(
      `INSERT INTO users (username, password, role, name, entity_id)
       VALUES ($1,$2,'student',$3,$4)
       ON CONFLICT (username) DO NOTHING`,
      [username, hashed, student.full_name, student.id]
    );
    await client.query('COMMIT');
    res.status(201).json({
      success:     true,
      data:        student,
      credentials: { username, password: rawPw },
      message:     'Student enrolled successfully.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

const updateStudent = async (req, res, next) => {
  try {
    const fields    = pickFields(req.body);
    const keys      = Object.keys(fields);
    const values    = Object.values(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE students SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows[0]) throw new AppError('Student not found.', 404);
    res.json({ success: true, data: rows[0], message: 'Student updated successfully.' });
  } catch (err) {
    next(err);
  }
};

const deleteStudent = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE students SET deleted_at = NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Student not found.', 404);
    res.json({ success: true, message: 'Student deleted successfully.' });
  } catch (err) {
    next(err);
  }
};

const getDeletedStudents = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.full_name, s.email, s.grade, s.roll_number, s.deleted_at,
              c.name AS class_name
       FROM students s LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.deleted_at IS NOT NULL
       ORDER BY s.deleted_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
};

const restoreStudent = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE students SET deleted_at = NULL WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id, full_name`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Student not found in deleted records.', 404);
    res.json({ success: true, data: rows[0], message: 'Student restored successfully.' });
  } catch (err) {
    next(err);
  }
};

const promoteStudents = async (req, res, next) => {
  const { from_class_id, to_class_id, student_ids } = req.body;
  if (!from_class_id || !to_class_id)
    return next(new AppError('from_class_id and to_class_id are required.', 400));
  if (String(from_class_id) === String(to_class_id))
    return next(new AppError('Source and destination class must be different.', 400));
  try {
    const { rows: clsRows } = await pool.query('SELECT grade, section FROM classes WHERE id = $1', [to_class_id]);
    if (!clsRows[0]) throw new AppError('Destination class not found.', 404);
    const { grade, section } = clsRows[0];
    let query, params;
    if (Array.isArray(student_ids) && student_ids.length > 0) {
      query  = `UPDATE students SET class_id=$1, grade=$2, section=$3 WHERE id = ANY($4::int[]) AND class_id = $5 RETURNING id`;
      params = [to_class_id, grade, section, student_ids, from_class_id];
    } else {
      query  = `UPDATE students SET class_id=$1, grade=$2, section=$3 WHERE class_id = $4 AND status = 'active' RETURNING id`;
      params = [to_class_id, grade, section, from_class_id];
    }
    const { rows } = await pool.query(query, params);
    res.json({ success: true, promoted: rows.length, message: `${rows.length} student(s) promoted successfully.` });
  } catch (err) {
    next(err);
  }
};

const uploadPhoto = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file uploaded.', 400);
    const { rows: old } = await pool.query('SELECT photo_url FROM students WHERE id=$1', [req.params.id]);
    if (!old[0]) throw new AppError('Student not found.', 404);
    if (old[0]?.photo_url) await deleteFromCloudinary(old[0].photo_url);
    const result = await uploadToCloudinary(req.file.buffer, 'students/photos');
    const { rows } = await pool.query(
      'UPDATE students SET photo_url=$1 WHERE id=$2 RETURNING id, photo_url',
      [result.secure_url, req.params.id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
};

const listDocuments = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM student_documents WHERE student_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
};

const uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file uploaded.', 400);
    const { name = req.file.originalname, doc_type = 'other' } = req.body;
    const result = await uploadToCloudinary(req.file.buffer, 'students/docs');
    const { rows } = await pool.query(
      `INSERT INTO student_documents (student_id, name, file_url, doc_type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name, result.secure_url, doc_type]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
};

const deleteDocument = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM student_documents WHERE id=$1 AND student_id=$2 RETURNING *',
      [req.params.docId, req.params.id]
    );
    if (!rows[0]) throw new AppError('Document not found.', 404);
    await deleteFromCloudinary(rows[0].file_url);
    res.json({ success: true, message: 'Document deleted.' });
  } catch (err) {
    next(err);
  }
};

const resetCredentials = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, full_name FROM students WHERE id=$1', [req.params.id]);
    if (!rows[0]) throw new AppError('Student not found.', 404);
    const student  = rows[0];
    const username = buildUsername(student.full_name, student.id);
    const rawPw    = `Stu@${student.id}`;
    const hashed   = await bcrypt.hash(rawPw, 10);
    await pool.query(
      `INSERT INTO users (username, password, role, name, entity_id)
       VALUES ($1,$2,'student',$3,$4)
       ON CONFLICT (username) DO UPDATE SET password=$2`,
      [username, hashed, student.full_name, student.id]
    );
    res.json({ success: true, credentials: { username, password: rawPw } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAllStudents, getStudentById, createStudent, updateStudent, deleteStudent,
  getDeletedStudents, restoreStudent,
  promoteStudents,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument, resetCredentials,
};
