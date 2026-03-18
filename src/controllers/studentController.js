const bcrypt = require('bcryptjs');
const pool   = require('../db');
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

const getAllStudents = async (req, res) => {
  try {
    const { search, grade, status, class_id } = req.query;
    let query = `
      SELECT s.id, s.full_name, s.full_name_urdu, s.email, s.phone, s.grade, s.section,
             s.roll_number, s.gender, s.b_form_no, s.blood_group, s.city, s.province,
             s.status, s.admission_date, s.created_at, s.class_id, s.photo_url,
             c.name AS class_name, c.section AS class_section
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE 1=1
    `;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (s.full_name ILIKE $${params.length} OR s.email ILIKE $${params.length} OR s.b_form_no ILIKE $${params.length})`;
    }
    if (grade)    { params.push(grade);    query += ` AND s.grade = $${params.length}`; }
    if (status)   { params.push(status);   query += ` AND s.status = $${params.length}`; }
    if (class_id) { params.push(class_id); query += ` AND s.class_id = $${params.length}`; }
    query += ' ORDER BY s.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getStudentById = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const createStudent = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fields = pickFields(req.body);
    if (!fields.full_name) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }
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
      success: true,
      data: student,
      credentials: { username, password: rawPw },
      message: 'Student enrolled successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CREATE STUDENT]', err.message);
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Email already registered' });
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

const updateStudent = async (req, res) => {
  try {
    const fields    = pickFields(req.body);
    const keys      = Object.keys(fields);
    const values    = Object.values(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE students SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: rows[0], message: 'Student updated successfully' });
  } catch (err) {
    console.error('[UPDATE STUDENT]', err.message);
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Email already registered' });
    res.status(500).json({ success: false, message: err.message });
  }
};

const deleteStudent = async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM students WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const promoteStudents = async (req, res) => {
  const { from_class_id, to_class_id, student_ids } = req.body;
  if (!from_class_id || !to_class_id)
    return res.status(400).json({ success: false, message: 'from_class_id and to_class_id are required' });
  if (String(from_class_id) === String(to_class_id))
    return res.status(400).json({ success: false, message: 'Source and destination class must be different' });
  try {
    const { rows: clsRows } = await pool.query('SELECT grade, section FROM classes WHERE id = $1', [to_class_id]);
    if (!clsRows[0]) return res.status(404).json({ success: false, message: 'Destination class not found' });
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
    res.json({ success: true, promoted: rows.length, message: `${rows.length} student(s) promoted successfully` });
  } catch (err) {
    console.error('[PROMOTE STUDENTS]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

const uploadPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const { rows: old } = await pool.query('SELECT photo_url FROM students WHERE id=$1', [req.params.id]);
    if (old[0]?.photo_url) await deleteFromCloudinary(old[0].photo_url);
    const result = await uploadToCloudinary(req.file.buffer, 'students/photos');
    const { rows } = await pool.query(
      'UPDATE students SET photo_url=$1 WHERE id=$2 RETURNING id, photo_url',
      [result.secure_url, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const listDocuments = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM student_documents WHERE student_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const { name = req.file.originalname, doc_type = 'other' } = req.body;
    const result = await uploadToCloudinary(req.file.buffer, 'students/docs');
    const { rows } = await pool.query(
      `INSERT INTO student_documents (student_id, name, file_url, doc_type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name, result.secure_url, doc_type]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const deleteDocument = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM student_documents WHERE id=$1 AND student_id=$2 RETURNING *',
      [req.params.docId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Document not found' });
    await deleteFromCloudinary(rows[0].file_url);
    res.json({ success: true, message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const resetCredentials = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, full_name FROM students WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found' });
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
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getAllStudents, getStudentById, createStudent, updateStudent, deleteStudent, promoteStudents,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument, resetCredentials,
};
