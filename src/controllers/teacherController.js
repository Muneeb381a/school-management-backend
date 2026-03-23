const bcrypt = require('bcryptjs');
const pool   = require('../db');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const { parseCSV, validateRows, buildTemplate } = require('../utils/csvImport');
const { buildWorkbook, sendWorkbook }           = require('../utils/excelExport');

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
        MIN(u.id)                         AS user_id,
        COUNT(DISTINCT tc.class_id)::int  AS class_count,
        COUNT(DISTINCT s.id)::int         AS student_count
      FROM teachers t
      LEFT JOIN users            u  ON u.entity_id = t.id AND u.role = 'teacher'
      LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id
      LEFT JOIN classes          c  ON c.id = tc.class_id
      LEFT JOIN students         s  ON s.class_id = c.id
      WHERE t.deleted_at IS NULL
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
       WHERE t.id = $1 AND t.deleted_at IS NULL
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
  const client = await pool.connect();
  try {
    const {
      full_name, email, phone, gender, date_of_birth,
      qualification, subject, join_date, status, address, assigned_grades,
    } = req.body;

    if (!full_name?.trim()) {
      client.release();
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
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
    const teacher  = rows[0];
    const base     = (teacher.full_name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5).padEnd(3, 'x');
    const username = `tch_${base}${teacher.id}`;
    const rawPw    = `Tch@${teacher.id}`;
    const hashed   = await bcrypt.hash(rawPw, 10);
    await client.query(
      `INSERT INTO users (username, password, role, name, entity_id, must_change_password)
       VALUES ($1,$2,'teacher',$3,$4,TRUE)
       ON CONFLICT (username) DO NOTHING`,
      [username, hashed, teacher.full_name, teacher.id]
    );
    await client.query('COMMIT');

    // Try email delivery — non-blocking
    let emailSent = false;
    if (email) {
      try {
        const sendMail = require('../utils/mailer').sendMail;
        await sendMail({
          to:      email,
          subject: 'Your School Portal Login Credentials',
          html:    `<p>Dear ${teacher.full_name},</p>
                    <p>Your teacher portal credentials have been created:</p>
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
      success: true,
      data: teacher,
      credentials: emailSent
        ? { username, emailSent: true, note: `Credentials emailed to ${email}` }
        : { username, tempPassword: rawPw, note: 'No email on file — share this password directly. It will not be shown again.' },
      message: 'Teacher added successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'A teacher with this email already exists' });
    }
    serverErr(res, err);
  } finally { client.release(); }
};

// ─────────────────────────────────────────────
//  POST /api/teachers/:id/reset-credentials
// ─────────────────────────────────────────────
const resetTeacherCredentials = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, full_name, email FROM teachers WHERE id=$1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!rows[0]) return notFound(res);
    const teacher  = rows[0];
    const base     = (teacher.full_name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5).padEnd(3, 'x');
    const username = `tch_${base}${teacher.id}`;
    const rawPw    = `Tch@${teacher.id}`;
    const hashed   = await bcrypt.hash(rawPw, 10);
    await pool.query(
      `INSERT INTO users (username, password, role, name, entity_id, must_change_password)
       VALUES ($1,$2,'teacher',$3,$4,TRUE)
       ON CONFLICT (username) DO UPDATE SET password=$2, must_change_password=TRUE`,
      [username, hashed, teacher.full_name, teacher.id]
    );

    let emailSent = false;
    if (teacher.email) {
      try {
        const sendMail = require('../utils/mailer').sendMail;
        await sendMail({
          to:      teacher.email,
          subject: 'Your School Portal Password Has Been Reset',
          html:    `<p>Dear ${teacher.full_name},</p>
                    <p>Your teacher portal password has been reset:</p>
                    <ul>
                      <li><strong>Username:</strong> ${username}</li>
                      <li><strong>New Password:</strong> ${rawPw}</li>
                    </ul>
                    <p>Please log in and change your password immediately.</p>`,
        });
        emailSent = true;
      } catch { /* non-blocking */ }
    }

    res.json({
      success: true,
      credentials: emailSent
        ? { username, emailSent: true, note: `New password emailed to ${teacher.email}` }
        : { username, tempPassword: rawPw, note: 'No email on file — share this password directly. It will not be shown again.' },
    });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  GET /api/teachers/:id/credentials
//  Returns just the username (password never stored in plain text)
// ─────────────────────────────────────────────
const getTeacherCredentials = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.username, u.must_change_password, u.is_active, u.last_login_at
       FROM users u
       JOIN teachers t ON t.id = u.entity_id
       WHERE u.role='teacher' AND t.id=$1 AND t.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows[0]) return res.json({ success: true, data: null });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
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
      `UPDATE teachers SET deleted_at = NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return notFound(res);
    res.json({ success: true, message: 'Teacher deleted successfully' });
  } catch (err) { serverErr(res, err); }
};

const getDeletedTeachers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, subject, phone, deleted_at
       FROM teachers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

const restoreTeacher = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE teachers SET deleted_at = NULL WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id, full_name`,
      [req.params.id]
    );
    if (!rows[0]) return notFound(res);
    res.json({ success: true, data: rows[0], message: 'Teacher restored successfully' });
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

// ── GET /api/teachers/import/template ────────────────────────────
const getImportTemplate = (_req, res) => {
  const csv = buildTemplate([
    { header: 'full_name',     example1: 'Tariq Mehmood',      example2: 'Amina Bibi' },
    { header: 'subject',       example1: 'Mathematics',        example2: 'English' },
    { header: 'phone',         example1: '03001234567',        example2: '03211234567' },
    { header: 'email',         example1: 'tariq@school.edu.pk',example2: 'amina@school.edu.pk' },
    { header: 'gender',        example1: 'male',               example2: 'female' },
    { header: 'qualification', example1: 'M.Sc Mathematics',   example2: 'B.Ed' },
    { header: 'join_date',     example1: '2024-01-15',         example2: '2024-02-01' },
    { header: 'status',        example1: 'active',             example2: 'active' },
    { header: 'address',       example1: 'House 5, Lahore',    example2: '' },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="teachers_import_template.csv"');
  res.send(csv);
};

// ── POST /api/teachers/import ─────────────────────────────────────
const importTeachers = async (req, res, next) => {
  if (!req.file) return next(new (require('../utils/AppError'))('CSV file is required.', 400));

  const { headers, rows } = parseCSV(req.file.buffer);
  if (!rows.length) return next(new (require('../utils/AppError'))('CSV file is empty.', 400));

  const REQUIRED = ['full_name', 'subject', 'phone'];
  if (!REQUIRED.every(f => headers.includes(f))) {
    return next(new (require('../utils/AppError'))(`CSV missing required columns: ${REQUIRED.join(', ')}`, 400));
  }

  const { valid, errors } = validateRows(rows, REQUIRED);
  let imported = 0;

  const client = await pool.connect();
  try {
    for (const { rowNum, data } of valid) {
      try {
        await client.query('BEGIN');
        const { rows: ins } = await client.query(
          `INSERT INTO teachers (full_name, subject, phone, email, gender, qualification, join_date, status, address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, full_name`,
          [
            data.full_name.trim(),
            data.subject || null,
            data.phone || null,
            data.email || null,
            data.gender || null,
            data.qualification || null,
            data.join_date || null,
            data.status || 'active',
            data.address || null,
          ]
        );
        const teacher  = ins[0];
        const base     = (teacher.full_name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5).padEnd(3, 'x');
        const username = `tch_${base}${teacher.id}`;
        const rawPw    = `Tch@${teacher.id}`;
        const hashed   = await bcrypt.hash(rawPw, 10);
        await client.query(
          `INSERT INTO users (username, password, role, name, entity_id)
           VALUES ($1,$2,'teacher',$3,$4) ON CONFLICT (username) DO NOTHING`,
          [username, hashed, teacher.full_name, teacher.id]
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
    success: true,
    imported,
    failed:  errors.length,
    errors,
    message: `Import complete. ${imported} teacher(s) imported, ${errors.length} failed.`,
  });
};

// ── GET /api/teachers/export?format=xlsx ─────────────────────────
const exportTeachers = async (req, res, next) => {
  try {
    const { format = 'csv', status } = req.query;
    const params = [];
    let where = 'WHERE t.deleted_at IS NULL';
    if (status) { params.push(status); where += ` AND t.status = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT t.full_name, t.email, t.phone, t.gender, t.subject, t.qualification,
              t.join_date, t.status, t.address,
              COUNT(DISTINCT tc.class_id)::int AS class_count
       FROM teachers t LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id
       ${where} GROUP BY t.id ORDER BY t.full_name`,
      params
    );

    if (format === 'xlsx') {
      const wb = await buildWorkbook({
        title: 'Teacher List', sheetName: 'Teachers',
        subtitle: `Total: ${rows.length} teachers | Exported: ${new Date().toLocaleDateString('en-PK')}`,
        columns: [
          { key: 'full_name',     header: 'Full Name',      width: 22 },
          { key: 'subject',       header: 'Subject',        width: 18 },
          { key: 'email',         header: 'Email',          width: 24 },
          { key: 'phone',         header: 'Phone',          width: 14 },
          { key: 'gender',        header: 'Gender',         width: 10 },
          { key: 'qualification', header: 'Qualification',  width: 20 },
          { key: 'join_date',     header: 'Join Date',      width: 12 },
          { key: 'class_count',   header: 'Classes',        width: 10 },
          { key: 'status',        header: 'Status',         width: 10 },
          { key: 'address',       header: 'Address',        width: 26 },
        ],
        rows,
      });
      return sendWorkbook(res, wb, `teachers_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hdr = ['Full Name','Subject','Email','Phone','Gender','Qualification','Join Date','Classes','Status'];
    const csv = [hdr, ...rows.map(r => [
      r.full_name, r.subject, r.email, r.phone, r.gender,
      r.qualification, r.join_date?.toString().slice(0,10), r.class_count, r.status,
    ].map(q))].map(row => row.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="teachers_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTeachers, getTeacher, getTeacherClasses, getTeacherStudents,
  createTeacher, updateTeacher, deleteTeacher,
  getDeletedTeachers, restoreTeacher,
  assignTeacherToClass, removeTeacherFromClass,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument,
  getImportTemplate, importTeachers, exportTeachers,
  resetTeacherCredentials, getTeacherCredentials,
};
