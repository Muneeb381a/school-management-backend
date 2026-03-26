const bcrypt   = require('bcryptjs');
const pool     = require('../db');
const AppError = require('../utils/AppError');
const { invalidateDashboard } = require('../utils/cache');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const { parseCSV, validateRows, buildTemplate } = require('../utils/csvImport');
const { buildWorkbook, sendWorkbook }           = require('../utils/excelExport');
const { sendMail }                              = require('../utils/mailer');
const { serverErr }      = require('../utils/serverErr');
const { genTempPassword } = require('../utils/genTempPassword');

const ALL_FIELDS = [
  'class_id',
  'full_name','full_name_urdu','date_of_birth','place_of_birth','gender',
  'religion','nationality','b_form_no','blood_group',
  'email','phone','emergency_contact','address','city','province','postal_code',
  'grade','section','roll_number','admission_number','admission_date',
  'previous_school','previous_class','previous_marks','leaving_reason',
  'father_name','father_cnic','father_occupation','father_education','father_phone','father_email',
  'mother_name','mother_cnic','mother_occupation','mother_phone',
  'guardian_name','guardian_relation','guardian_phone','guardian_cnic',
  'medical_condition','allergies','disability',
  'transport_required','transport_route','hostel_required',
  'siblings_in_school','extra_curricular','house_color','status',
];

const DATE_FIELDS      = ['date_of_birth', 'admission_date'];
const BOOLEAN_FIELDS   = ['transport_required', 'hostel_required'];
// Never overwritten by client on update — auto-generated on create only
const IMMUTABLE_FIELDS = ['admission_number', 'roll_number'];

function pickFields(body, forUpdate = false) {
  const result = {};
  for (const f of ALL_FIELDS) {
    if (forUpdate && IMMUTABLE_FIELDS.includes(f)) continue;
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
      s.roll_number, s.admission_number, s.gender, s.b_form_no, s.blood_group, s.city, s.province,
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

    // ── Auto-generate admission number ────────────────────────
    const year = new Date().getFullYear();
    const { rows: seqRows } = await client.query(`SELECT nextval('admission_number_seq') AS seq`);
    fields.admission_number = `ADM-${year}-${String(seqRows[0].seq).padStart(4, '0')}`;

    // ── Auto-generate roll number ─────────────────────────────
    // Sequential within the assigned class; falls back to global count
    if (fields.class_id) {
      const { rows: cntRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM students WHERE class_id = $1 AND deleted_at IS NULL`,
        [fields.class_id]
      );
      fields.roll_number = String(cntRows[0].cnt + 1).padStart(3, '0');
    } else {
      const { rows: cntRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM students WHERE deleted_at IS NULL`
      );
      fields.roll_number = String(cntRows[0].cnt + 1).padStart(4, '0');
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
    const rawPw    = genTempPassword();
    const hashed   = await bcrypt.hash(rawPw, 10);
    await client.query(
      `INSERT INTO users (username, password, role, name, entity_id, must_change_password)
       VALUES ($1,$2,'student',$3,$4,TRUE)
       ON CONFLICT (username) DO NOTHING`,
      [username, hashed, student.full_name, student.id]
    );
    await client.query('COMMIT');
    invalidateDashboard().catch(() => {});

    // Try to email credentials — prefer student email, fall back to father email
    const emailTo = student.email || student.father_email || null;
    let emailSent = false;
    if (emailTo) {
      try {
        await sendMail({
          to:      emailTo,
          subject: 'Your School Portal Login Credentials',
          html:    `<p>Dear ${student.full_name},</p>
                    <p>Your login credentials for the school portal have been created:</p>
                    <ul>
                      <li><strong>Username:</strong> ${username}</li>
                      <li><strong>Temporary Password:</strong> ${rawPw}</li>
                    </ul>
                    <p>Please log in and change your password immediately.</p>`,
        });
        emailSent = true;
      } catch { /* email failure is non-blocking */ }
    }

    res.status(201).json({
      success:     true,
      data:        student,
      credentials: emailSent
        ? { username, emailSent: true, note: `Credentials emailed to ${emailTo}` }
        : { username, tempPassword: rawPw, note: 'No email on file — share this password with the student directly. It will not be shown again.' },
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
    const fields    = pickFields(req.body, true); // forUpdate=true → skips immutable fields
    const keys      = Object.keys(fields);
    const values    = Object.values(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE students SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows[0]) throw new AppError('Student not found.', 404);
    invalidateDashboard().catch(() => {});
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
    invalidateDashboard().catch(() => {});
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

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const uploadPhoto = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file uploaded.', 400);
    if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype))
      throw new AppError('Only JPG, PNG, or WebP images are allowed.', 400);
    if (req.file.size > 5 * 1024 * 1024)
      throw new AppError('File size must not exceed 5 MB.', 400);
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
    const { rows } = await pool.query(
      'SELECT id, full_name, email, father_email FROM students WHERE id=$1',
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Student not found.', 404);
    const student  = rows[0];
    const username = buildUsername(student.full_name, student.id);
    const rawPw    = genTempPassword();
    const hashed   = await bcrypt.hash(rawPw, 10);
    await pool.query(
      `INSERT INTO users (username, password, role, name, entity_id, must_change_password)
       VALUES ($1,$2,'student',$3,$4,TRUE)
       ON CONFLICT (username) DO UPDATE SET password=$2, must_change_password=TRUE`,
      [username, hashed, student.full_name, student.id]
    );

    const emailTo = student.email || student.father_email || null;
    let emailSent = false;
    if (emailTo) {
      try {
        await sendMail({
          to:      emailTo,
          subject: 'Your School Portal Password Has Been Reset',
          html:    `<p>Dear ${student.full_name},</p>
                    <p>Your school portal password has been reset:</p>
                    <ul>
                      <li><strong>Username:</strong> ${username}</li>
                      <li><strong>Temporary Password:</strong> ${rawPw}</li>
                    </ul>
                    <p>Please log in and change your password immediately.</p>`,
        });
        emailSent = true;
      } catch { /* email failure is non-blocking */ }
    }

    res.json({
      success:     true,
      credentials: emailSent
        ? { username, emailSent: true, note: `New password emailed to ${emailTo}` }
        : { username, tempPassword: rawPw, note: 'No email on file — share this password directly. It will not be shown again.' },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/students/import/template ────────────────────────────
const getImportTemplate = (_req, res) => {
  const csv = buildTemplate([
    { header: 'full_name',    example1: 'Ahmed Ali',       example2: 'Sara Khan' },
    { header: 'grade',        example1: '5',               example2: '3' },
    { header: 'gender',       example1: 'male',            example2: 'female' },
    { header: 'father_name',  example1: 'Ali Khan',        example2: 'Imran Khan' },
    { header: 'phone',        example1: '03001234567',     example2: '03211234567' },
    { header: 'date_of_birth',example1: '2012-05-15',      example2: '2014-03-20' },
    { header: 'b_form_no',    example1: '35202-1234567-1', example2: '' },
    { header: 'email',        example1: 'ahmed@example.com',example2: '' },
    { header: 'address',      example1: 'House 1, Street 2, Lahore', example2: '' },
    { header: 'section',      example1: 'A',               example2: 'B' },
    { header: 'roll_number',  example1: '101',             example2: '102' },
    { header: 'admission_date',example1: '2024-04-01',     example2: '2024-04-01' },
    { header: 'status',       example1: 'active',          example2: 'active' },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="students_import_template.csv"');
  res.send(csv);
};

// ── POST /api/students/import ─────────────────────────────────────
const importStudents = async (req, res, next) => {
  if (!req.file) return next(new AppError('CSV file is required.', 400));

  const { headers, rows } = parseCSV(req.file.buffer);
  if (!rows.length) return next(new AppError('CSV file is empty or has no data rows.', 400));

  const REQUIRED = ['full_name', 'grade', 'gender', 'father_name', 'phone'];
  if (!REQUIRED.every(f => headers.includes(f))) {
    return next(new AppError(`CSV missing required columns: ${REQUIRED.join(', ')}`, 400));
  }

  const { valid, errors } = validateRows(rows, REQUIRED);
  let imported = 0;

  const client = await pool.connect();
  try {
    for (const { rowNum, data } of valid) {
      try {
        await client.query('BEGIN');
        const { rows: ins } = await client.query(
          `INSERT INTO students
             (full_name, grade, gender, father_name, phone,
              date_of_birth, b_form_no, email, address, section,
              roll_number, admission_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id, full_name`,
          [
            data.full_name.trim(),
            data.grade || null,
            data.gender || null,
            data.father_name || null,
            data.phone || null,
            data.date_of_birth || null,
            data.b_form_no || null,
            data.email || null,
            data.address || null,
            data.section || null,
            data.roll_number || null,
            data.admission_date || null,
            data.status || 'active',
          ]
        );
        const student  = ins[0];
        const username = buildUsername(student.full_name, student.id);
        const rawPw    = genTempPassword();
        const hashed   = await bcrypt.hash(rawPw, 10);
        await client.query(
          `INSERT INTO users (username, password, role, name, entity_id)
           VALUES ($1,$2,'student',$3,$4) ON CONFLICT (username) DO NOTHING`,
          [username, hashed, student.full_name, student.id]
        );
        await client.query('COMMIT');
        imported++;
      } catch (err) {
        await client.query('ROLLBACK');
        errors.push({ row: rowNum, message: err.message });
      }
    }
  } finally {
    client.release();
  }

  res.json({
    success:  true,
    imported,
    failed:   errors.length,
    errors,
    message:  `Import complete. ${imported} student(s) imported, ${errors.length} failed.`,
  });
};

// ── GET /api/students/export?format=xlsx ──────────────────────────
const exportStudents = async (req, res, next) => {
  try {
    const { class_id, grade, status, format = 'csv' } = req.query;
    let where = 'WHERE s.deleted_at IS NULL';
    const params = [];
    if (grade)    { params.push(grade);    where += ` AND s.grade = $${params.length}`; }
    if (status)   { params.push(status);   where += ` AND s.status = $${params.length}`; }
    if (class_id) { params.push(class_id); where += ` AND s.class_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT s.full_name, s.roll_number, s.grade, s.section, s.gender,
              s.b_form_no, s.date_of_birth, s.phone, s.email, s.address,
              s.father_name, s.father_phone, s.status, s.admission_date,
              c.name AS class_name
       FROM students s LEFT JOIN classes c ON c.id = s.class_id
       ${where} ORDER BY s.grade, s.roll_number`,
      params
    );

    if (format === 'xlsx') {
      const wb = await buildWorkbook({
        title:     'Student List',
        sheetName: 'Students',
        subtitle:  `Total: ${rows.length} students | Exported: ${new Date().toLocaleDateString('en-PK')}`,
        columns: [
          { key: 'roll_number',   header: 'Roll No',        width: 10 },
          { key: 'full_name',     header: 'Full Name',      width: 22 },
          { key: 'class_name',    header: 'Class',          width: 14 },
          { key: 'grade',         header: 'Grade',          width: 8  },
          { key: 'section',       header: 'Section',        width: 9  },
          { key: 'gender',        header: 'Gender',         width: 10 },
          { key: 'date_of_birth', header: 'Date of Birth',  width: 14 },
          { key: 'b_form_no',     header: 'B-Form No',      width: 18 },
          { key: 'phone',         header: 'Phone',          width: 14 },
          { key: 'email',         header: 'Email',          width: 22 },
          { key: 'father_name',   header: 'Father Name',    width: 20 },
          { key: 'father_phone',  header: 'Father Phone',   width: 14 },
          { key: 'address',       header: 'Address',        width: 28 },
          { key: 'status',        header: 'Status',         width: 10 },
          { key: 'admission_date',header: 'Admission Date', width: 14 },
        ],
        rows,
      });
      return sendWorkbook(res, wb, `students_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    // Default: CSV (original behaviour preserved)
    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hdr = ['Roll No','Full Name','Class','Grade','Section','Gender','DOB','B-Form','Phone','Email','Father','Father Phone','Address','Status','Admission Date'];
    const csv = [hdr, ...rows.map(r => [
      r.roll_number, r.full_name, r.class_name, r.grade, r.section, r.gender,
      r.date_of_birth?.toString().slice(0,10), r.b_form_no, r.phone, r.email,
      r.father_name, r.father_phone, r.address, r.status,
      r.admission_date?.toString().slice(0,10),
    ].map(q))].map(row => row.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="students_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

// ── GET /api/students/:id/credentials ────────────────────────────
// Returns username + account status without resetting the password
const getStudentCredentials = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.username, u.must_change_password, u.is_active, u.last_login_at
       FROM users u
       JOIN students s ON s.id = u.entity_id
       WHERE u.role='student' AND s.id=$1 AND s.deleted_at IS NULL`,
      [req.params.id]
    );
    // Also include student id for deriving default password
    const { rows: sRows } = await pool.query('SELECT id FROM students WHERE id=$1', [req.params.id]);
    if (!sRows[0]) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: rows[0] || null, student_id: sRows[0].id });
  } catch (err) { next(err); }
};

module.exports = {
  getAllStudents, getStudentById, createStudent, updateStudent, deleteStudent,
  getDeletedStudents, restoreStudent,
  promoteStudents,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument, resetCredentials,
  getImportTemplate, importStudents, exportStudents,
  getStudentCredentials,
};
