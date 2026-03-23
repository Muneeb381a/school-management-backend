const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[HW_SUBMISSION]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// GET /:homework_id/submissions
// LEFT JOIN all students in the homework's class with their submission row
const getSubmissionsForHomework = async (req, res) => {
  try {
    const { homework_id } = req.params;

    // Get homework to find class_id
    const { rows: hw } = await pool.query('SELECT * FROM homework WHERE id=$1', [homework_id]);
    if (!hw[0]) return res.status(404).json({ success: false, message: 'Homework not found' });

    const { rows } = await pool.query(
      `SELECT s.id AS student_id, s.full_name, s.roll_number,
              hs.id AS submission_id,
              COALESCE(hs.status, 'pending') AS status,
              hs.submitted_at,
              hs.checked_at,
              hs.marks_awarded,
              hs.feedback,
              hs.student_note
       FROM students s
       LEFT JOIN homework_submissions hs
         ON hs.student_id = s.id AND hs.homework_id = $1
       WHERE s.class_id = $2
         AND s.deleted_at IS NULL
         AND s.status = 'active'
       ORDER BY s.roll_number NULLS LAST, s.full_name`,
      [homework_id, hw[0].class_id],
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /:homework_id/submissions
// Body: {student_id, status, student_note}
const upsertSubmission = async (req, res) => {
  try {
    const { homework_id } = req.params;
    const { student_id, status, student_note } = req.body;

    if (!student_id) {
      return res.status(400).json({ success: false, message: 'student_id is required' });
    }

    const submittedAt = status === 'submitted' ? 'NOW()' : 'NULL';

    const { rows } = await pool.query(
      `INSERT INTO homework_submissions (homework_id, student_id, status, student_note, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4, ${submittedAt === 'NOW()' ? 'NOW()' : 'NULL'}, NOW())
       ON CONFLICT (homework_id, student_id) DO UPDATE SET
         status       = EXCLUDED.status,
         student_note = EXCLUDED.student_note,
         submitted_at = CASE WHEN EXCLUDED.status = 'submitted' THEN NOW() ELSE homework_submissions.submitted_at END,
         updated_at   = NOW()
       RETURNING *`,
      [homework_id, student_id, status || 'pending', student_note || null],
    );

    res.status(201).json({ success: true, data: rows[0], message: 'Submission saved' });
  } catch (err) { serverErr(res, err); }
};

// PUT /:homework_id/submissions/:student_id/check
// Body: {marks_awarded, feedback}
const teacherCheck = async (req, res) => {
  try {
    const { homework_id, student_id } = req.params;
    const { marks_awarded, feedback } = req.body;
    const checkedBy = req.user?.teacherId || null;

    const { rows } = await pool.query(
      `UPDATE homework_submissions
       SET status        = 'checked',
           checked_at    = NOW(),
           checked_by    = $1,
           marks_awarded = $2,
           feedback      = $3,
           updated_at    = NOW()
       WHERE homework_id = $4 AND student_id = $5
       RETURNING *`,
      [checkedBy, marks_awarded || null, feedback || null, homework_id, student_id],
    );

    if (!rows[0]) return res.status(404).json({ success: false, message: 'Submission not found' });
    res.json({ success: true, data: rows[0], message: 'Submission checked' });
  } catch (err) { serverErr(res, err); }
};

// POST /:homework_id/submissions/init
// Bulk-init pending rows for all active students in homework's class
const bulkInitSubmissions = async (req, res) => {
  try {
    const { homework_id } = req.params;

    const { rows: hw } = await pool.query('SELECT * FROM homework WHERE id=$1', [homework_id]);
    if (!hw[0]) return res.status(404).json({ success: false, message: 'Homework not found' });
    if (!hw[0].class_id) {
      return res.status(400).json({ success: false, message: 'Homework has no class assigned' });
    }

    const { rows: students } = await pool.query(
      `SELECT id FROM students WHERE class_id=$1 AND deleted_at IS NULL AND status='active'`,
      [hw[0].class_id],
    );

    if (students.length === 0) {
      return res.json({ success: true, message: 'No active students found', inserted: 0 });
    }

    const values = students.map((s, i) =>
      `($1, $${i + 2}, 'pending', NOW(), NOW())`
    ).join(', ');
    const params = [homework_id, ...students.map((s) => s.id)];

    await pool.query(
      `INSERT INTO homework_submissions (homework_id, student_id, status, created_at, updated_at)
       VALUES ${values}
       ON CONFLICT (homework_id, student_id) DO NOTHING`,
      params,
    );

    res.json({ success: true, message: 'Submissions initialised', inserted: students.length });
  } catch (err) { serverErr(res, err); }
};

// GET /pending-summary
// Count pending+submitted (unchecked) per homework for the current teacher
const getPendingForDashboard = async (req, res) => {
  try {
    const teacherId = req.user?.teacherId;
    let q = `
      SELECT h.id AS homework_id, h.title, h.due_date,
             c.name AS class_name,
             COUNT(hs.id) FILTER (WHERE hs.status IN ('pending','submitted')) AS unchecked_count,
             COUNT(hs.id) AS total_count
      FROM homework h
      LEFT JOIN classes c ON c.id = h.class_id
      LEFT JOIN homework_submissions hs ON hs.homework_id = h.id
      WHERE 1=1
    `;
    const p = [];
    if (teacherId) {
      p.push(teacherId);
      q += ` AND h.teacher_id = $${p.length}`;
    }
    q += ' GROUP BY h.id, h.title, h.due_date, c.name ORDER BY h.due_date DESC';

    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /student/:id/history
const getStudentHomeworkHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT hs.*, h.title, h.due_date, h.academic_year,
              c.name AS class_name,
              s.name AS subject_name
       FROM homework_submissions hs
       JOIN homework h ON h.id = hs.homework_id
       LEFT JOIN classes  c ON c.id = h.class_id
       LEFT JOIN subjects s ON s.id = h.subject_id
       WHERE hs.student_id = $1
       ORDER BY h.due_date DESC, hs.updated_at DESC`,
      [id],
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getSubmissionsForHomework,
  upsertSubmission,
  teacherCheck,
  bulkInitSubmissions,
  getPendingForDashboard,
  getStudentHomeworkHistory,
};
