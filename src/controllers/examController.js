const pool = require('../db');

// ══════════════════════════════════════════════════════════════
//  HELPER — grade from percentage
// ══════════════════════════════════════════════════════════════
// Pakistani grading scale: A1(90+), A(80+), B(70+), C(60+), D(50+), F(<50)
function gradeFromPct(pct) {
  if (pct >= 90) return 'A1';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  return 'F';
}

// ══════════════════════════════════════════════════════════════
//  EXAMS — CRUD
// ══════════════════════════════════════════════════════════════

// GET /api/exams?academic_year=&status=
const getExams = async (req, res) => {
  try {
    const { academic_year, status } = req.query;
    const conditions = [];
    const values = [];

    if (academic_year) { values.push(academic_year); conditions.push(`academic_year = $${values.length}`); }
    if (status)        { values.push(status);        conditions.push(`status = $${values.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM exams ${where} ORDER BY start_date DESC`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/exams/:id
const getExamById = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM exams WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Exam not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/exams
const createExam = async (req, res) => {
  try {
    const { exam_name, exam_type = 'other', academic_year = '2024-25', start_date, end_date, status = 'scheduled' } = req.body;
    if (!exam_name || !start_date || !end_date)
      return res.status(400).json({ success: false, message: 'exam_name, start_date, and end_date are required' });

    const { rows } = await pool.query(
      `INSERT INTO exams (exam_name, exam_type, academic_year, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [exam_name.trim(), exam_type, academic_year, start_date, end_date, status]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Exam created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/exams/:id
const updateExam = async (req, res) => {
  try {
    const { exam_name, exam_type, academic_year, start_date, end_date, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE exams
       SET exam_name = COALESCE($1, exam_name),
           exam_type = COALESCE($2, exam_type),
           academic_year = COALESCE($3, academic_year),
           start_date = COALESCE($4, start_date),
           end_date = COALESCE($5, end_date),
           status = COALESCE($6, status)
       WHERE id = $7 RETURNING *`,
      [exam_name, exam_type, academic_year, start_date, end_date, status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Exam not found' });
    res.json({ success: true, data: rows[0], message: 'Exam updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/exams/:id/status
const updateExamStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'status is required' });

    const { rows } = await pool.query(
      `UPDATE exams SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Exam not found' });
    res.json({ success: true, data: rows[0], message: 'Exam status updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/exams/:id
const deleteExam = async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM exams WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Exam not found' });
    res.json({ success: true, message: 'Exam deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  EXAM SUBJECTS — configure marks per exam × class × subject
// ══════════════════════════════════════════════════════════════

// GET /api/exams/:examId/subjects?class_id=
const getExamSubjects = async (req, res) => {
  try {
    const { class_id } = req.query;
    const values = [req.params.examId];
    let classFilter = '';
    if (class_id) { values.push(class_id); classFilter = `AND es.class_id = $${values.length}`; }

    const { rows } = await pool.query(
      `SELECT
         es.id,
         es.exam_id,
         es.class_id,
         es.subject_id,
         es.total_marks,
         es.passing_marks,
         c.name        AS class_name,
         c.grade,
         c.section,
         s.name        AS subject_name,
         s.code        AS subject_code
       FROM exam_subjects es
       JOIN classes  c ON c.id = es.class_id
       JOIN subjects s ON s.id = es.subject_id
       WHERE es.exam_id = $1 ${classFilter}
       ORDER BY c.grade, c.section, s.name`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/exams/:examId/subjects
//  body: { class_id, subject_id, total_marks, passing_marks }
//  or bulk: { subjects: [{ class_id, subject_id, total_marks, passing_marks }] }
const addExamSubject = async (req, res) => {
  const client = await pool.connect();
  try {
    const examId = req.params.examId;
    const items = req.body.subjects
      ? req.body.subjects
      : [{ class_id: req.body.class_id, subject_id: req.body.subject_id,
           total_marks: req.body.total_marks, passing_marks: req.body.passing_marks }];

    await client.query('BEGIN');
    const saved = [];
    for (const item of items) {
      const { class_id, subject_id, total_marks, passing_marks } = item;
      if (!class_id || !subject_id || !total_marks || !passing_marks)
        throw new Error('class_id, subject_id, total_marks, and passing_marks are required for each subject');

      const { rows } = await client.query(
        `INSERT INTO exam_subjects (exam_id, class_id, subject_id, total_marks, passing_marks)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (exam_id, class_id, subject_id)
         DO UPDATE SET total_marks = EXCLUDED.total_marks, passing_marks = EXCLUDED.passing_marks
         RETURNING *`,
        [examId, class_id, subject_id, total_marks, passing_marks]
      );
      saved.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: saved, message: `${saved.length} subject(s) configured` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// DELETE /api/exams/subjects/:id
const removeExamSubject = async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM exam_subjects WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Exam subject not found' });
    res.json({ success: true, message: 'Exam subject removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  STUDENT MARKS
// ══════════════════════════════════════════════════════════════

// GET /api/exams/:examId/marks?class_id=&student_id=
const getMarks = async (req, res) => {
  try {
    const { class_id, student_id } = req.query;
    const values = [req.params.examId];
    const filters = [];
    if (class_id)   { values.push(class_id);   filters.push(`sm.class_id = $${values.length}`); }
    if (student_id) { values.push(student_id); filters.push(`sm.student_id = $${values.length}`); }

    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT
         sm.id,
         sm.exam_id,
         sm.student_id,
         sm.subject_id,
         sm.class_id,
         sm.obtained_marks,
         sm.remarks,
         sm.created_at,
         st.full_name      AS student_name,
         st.roll_number,
         s.name            AS subject_name,
         s.code            AS subject_code,
         c.name            AS class_name,
         es.total_marks,
         es.passing_marks,
         CASE WHEN sm.obtained_marks >= es.passing_marks THEN 'pass' ELSE 'fail' END AS subject_status
       FROM student_marks sm
       JOIN students       st ON st.id = sm.student_id
       JOIN subjects       s  ON s.id  = sm.subject_id
       JOIN classes        c  ON c.id  = sm.class_id
       JOIN exam_subjects  es ON es.exam_id    = sm.exam_id
                              AND es.class_id   = sm.class_id
                              AND es.subject_id = sm.subject_id
       WHERE sm.exam_id = $1 ${where}
       ORDER BY st.full_name, s.name`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/exams/:examId/marks
//  body: { marks: [{ student_id, subject_id, class_id, obtained_marks, remarks }] }
const submitMarks = async (req, res) => {
  const client = await pool.connect();
  try {
    const examId = req.params.examId;
    const { marks } = req.body;
    if (!Array.isArray(marks) || marks.length === 0)
      return res.status(400).json({ success: false, message: 'marks array is required' });

    await client.query('BEGIN');
    const saved = [];
    for (const m of marks) {
      const { student_id, subject_id, class_id, obtained_marks, remarks = null } = m;
      if (!student_id || !subject_id || !class_id || obtained_marks == null)
        throw new Error('student_id, subject_id, class_id, and obtained_marks are required for each mark');

      // Validate obtained_marks does not exceed total_marks
      const { rows: config } = await client.query(
        `SELECT total_marks FROM exam_subjects
         WHERE exam_id=$1 AND class_id=$2 AND subject_id=$3`,
        [examId, class_id, subject_id]
      );
      if (!config[0])
        throw new Error(`No exam subject configured for class_id=${class_id}, subject_id=${subject_id}`);
      if (parseFloat(obtained_marks) > parseFloat(config[0].total_marks))
        throw new Error(`obtained_marks (${obtained_marks}) exceeds total_marks (${config[0].total_marks}) for subject_id=${subject_id}`);

      const { rows } = await client.query(
        `INSERT INTO student_marks (exam_id, student_id, subject_id, class_id, obtained_marks, remarks)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (exam_id, student_id, subject_id)
         DO UPDATE SET obtained_marks = EXCLUDED.obtained_marks, remarks = EXCLUDED.remarks
         RETURNING *`,
        [examId, student_id, subject_id, class_id, obtained_marks, remarks]
      );
      saved.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: saved, message: `${saved.length} mark(s) saved` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// DELETE /api/exams/marks/:id
const deleteMark = async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM student_marks WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Mark not found' });
    res.json({ success: true, message: 'Mark deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  RESULTS
// ══════════════════════════════════════════════════════════════

// POST /api/exams/:examId/calculate-results
//  Calculates and upserts result_summary for all students in the exam.
//  Pass only = student passed ALL individual subjects.
const calculateResults = async (req, res) => {
  const client = await pool.connect();
  try {
    const examId = req.params.examId;

    // Check exam exists
    const { rows: exam } = await client.query(`SELECT id FROM exams WHERE id = $1`, [examId]);
    if (!exam[0]) return res.status(404).json({ success: false, message: 'Exam not found' });

    await client.query('BEGIN');

    // Aggregate marks per student
    const { rows: aggregated } = await client.query(
      `SELECT
         sm.student_id,
         sm.class_id,
         SUM(es.total_marks)                                             AS total_marks,
         SUM(sm.obtained_marks)                                          AS obtained_marks,
         ROUND(SUM(sm.obtained_marks) / SUM(es.total_marks) * 100, 2)   AS percentage,
         -- fail if any subject is below passing
         CASE WHEN MIN(sm.obtained_marks - es.passing_marks) >= 0
              THEN 'pass' ELSE 'fail' END                                AS result_status
       FROM student_marks sm
       JOIN exam_subjects es ON es.exam_id    = sm.exam_id
                             AND es.class_id   = sm.class_id
                             AND es.subject_id = sm.subject_id
       WHERE sm.exam_id = $1
       GROUP BY sm.student_id, sm.class_id`,
      [examId]
    );

    if (aggregated.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No marks found for this exam' });
    }

    const upserted = [];
    for (const row of aggregated) {
      const grade = gradeFromPct(parseFloat(row.percentage));
      const { rows } = await client.query(
        `INSERT INTO result_summary
           (student_id, exam_id, class_id, total_marks, obtained_marks, grade, result_status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (student_id, exam_id)
         DO UPDATE SET
           total_marks    = EXCLUDED.total_marks,
           obtained_marks = EXCLUDED.obtained_marks,
           grade          = EXCLUDED.grade,
           result_status  = EXCLUDED.result_status,
           generated_at   = NOW()
         RETURNING *`,
        [row.student_id, examId, row.class_id, row.total_marks, row.obtained_marks, grade, row.result_status]
      );
      upserted.push(rows[0]);
    }

    await client.query('COMMIT');
    res.json({ success: true, data: upserted, message: `Results calculated for ${upserted.length} student(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// GET /api/exams/:examId/results?class_id=
const getResults = async (req, res) => {
  try {
    const { class_id } = req.query;
    const values = [req.params.examId];
    let classFilter = '';
    if (class_id) { values.push(class_id); classFilter = `AND rs.class_id = $${values.length}`; }

    const { rows } = await pool.query(
      `SELECT
         rs.id,
         rs.student_id,
         rs.exam_id,
         rs.class_id,
         rs.total_marks,
         rs.obtained_marks,
         rs.percentage,
         rs.grade,
         rs.result_status,
         rs.generated_at,
         st.full_name   AS student_name,
         st.roll_number,
         c.name         AS class_name,
         c.grade        AS class_grade,
         c.section,
         e.exam_name,
         e.exam_type,
         e.academic_year
       FROM result_summary rs
       JOIN students st ON st.id = rs.student_id
       JOIN classes  c  ON c.id  = rs.class_id
       JOIN exams    e  ON e.id  = rs.exam_id
       WHERE rs.exam_id = $1 ${classFilter}
       ORDER BY rs.percentage DESC`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/exams/:examId/results/student/:studentId  — full report card
const getStudentReportCard = async (req, res) => {
  try {
    const { examId, studentId } = req.params;

    // Subject-wise marks
    const { rows: subjects } = await pool.query(
      `SELECT
         s.name                AS subject_name,
         s.code                AS subject_code,
         es.total_marks,
         es.passing_marks,
         sm.obtained_marks,
         ROUND(sm.obtained_marks / NULLIF(es.total_marks,0) * 100, 2)   AS subject_percentage,
         calculate_grade(
           ROUND(sm.obtained_marks / NULLIF(es.total_marks,0) * 100, 2)
         )                                                               AS subject_grade,
         CASE WHEN sm.obtained_marks >= es.passing_marks
              THEN 'pass' ELSE 'fail' END                               AS subject_status,
         sm.remarks
       FROM student_marks sm
       JOIN subjects      s  ON s.id  = sm.subject_id
       JOIN exam_subjects es ON es.exam_id    = sm.exam_id
                             AND es.class_id   = sm.class_id
                             AND es.subject_id = sm.subject_id
       WHERE sm.exam_id = $1 AND sm.student_id = $2
       ORDER BY s.name`,
      [examId, studentId]
    );

    if (subjects.length === 0)
      return res.status(404).json({ success: false, message: 'No marks found for this student in this exam' });

    // Overall result + rank/position
    const { rows: summary } = await pool.query(
      `SELECT
         rs.*,
         st.full_name, st.roll_number, st.father_name,
         c.name AS class_name, c.grade, c.section,
         e.exam_name, e.exam_type, e.academic_year, e.start_date, e.end_date,
         (SELECT COUNT(*)::int FROM result_summary
          WHERE exam_id = $1 AND class_id = rs.class_id)               AS total_students,
         (SELECT COUNT(*)::int + 1 FROM result_summary
          WHERE exam_id = $1 AND class_id = rs.class_id
            AND percentage > rs.percentage)                             AS position
       FROM result_summary rs
       JOIN students st ON st.id = rs.student_id
       JOIN classes  c  ON c.id  = rs.class_id
       JOIN exams    e  ON e.id  = rs.exam_id
       WHERE rs.exam_id = $1 AND rs.student_id = $2`,
      [examId, studentId]
    );

    // School settings for header
    const { rows: settingsRows } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
       ('school_name','school_address','school_phone','school_email','school_logo','currency')`
    );
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });

    res.json({
      success: true,
      data: { summary: summary[0] || null, subjects, settings },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/exams/:examId/results/class/:classId/ranking
const getClassRanking = async (req, res) => {
  try {
    const { examId, classId } = req.params;

    const { rows } = await pool.query(
      `SELECT
         RANK() OVER (ORDER BY rs.percentage DESC)   AS rank,
         rs.student_id,
         st.full_name,
         st.roll_number,
         rs.total_marks,
         rs.obtained_marks,
         rs.percentage,
         rs.grade,
         rs.result_status,
         -- subjects failed count
         COUNT(*) FILTER (
           WHERE sm.obtained_marks < es.passing_marks
         )                                            AS subjects_failed,
         -- subjects passed count
         COUNT(*) FILTER (
           WHERE sm.obtained_marks >= es.passing_marks
         )                                            AS subjects_passed
       FROM result_summary rs
       JOIN students      st ON st.id = rs.student_id
       JOIN student_marks sm ON sm.student_id = rs.student_id AND sm.exam_id = rs.exam_id
       JOIN exam_subjects es ON es.exam_id    = sm.exam_id
                             AND es.class_id   = sm.class_id
                             AND es.subject_id = sm.subject_id
       WHERE rs.exam_id  = $1
         AND rs.class_id = $2
       GROUP BY
         st.full_name, st.roll_number,
         rs.total_marks, rs.obtained_marks, rs.percentage,
         rs.grade, rs.result_status, rs.student_id
       ORDER BY rs.percentage DESC`,
      [examId, classId]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: 'No results found for this class/exam' });

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/exams/:examId/results/class/:classId/report-cards
//  Returns full report-card data (summary + subjects) for every student in the class.
const getClassReportCards = async (req, res) => {
  try {
    const { examId, classId } = req.params;

    // Exam info
    const { rows: examRows } = await pool.query(
      `SELECT exam_name, exam_type, academic_year, start_date, end_date FROM exams WHERE id = $1`,
      [examId]
    );
    if (!examRows[0]) return res.status(404).json({ success: false, message: 'Exam not found' });

    // Results with rank + student info (ordered by rank)
    const { rows: results } = await pool.query(
      `SELECT
         rs.student_id,
         rs.total_marks, rs.obtained_marks, rs.percentage, rs.grade, rs.result_status,
         RANK() OVER (ORDER BY rs.percentage DESC)                                          AS position,
         (SELECT COUNT(*)::int FROM result_summary WHERE exam_id=$1 AND class_id=$2)        AS total_students,
         st.full_name, st.roll_number, st.father_name,
         c.name AS class_name, c.grade AS class_grade, c.section
       FROM result_summary rs
       JOIN students st ON st.id = rs.student_id
       JOIN classes  c  ON c.id  = rs.class_id
       WHERE rs.exam_id = $1 AND rs.class_id = $2
       ORDER BY rs.percentage DESC`,
      [examId, classId]
    );

    if (results.length === 0) return res.json({ success: true, data: [] });

    // All subject-wise marks for this exam + class in one query
    const { rows: allMarks } = await pool.query(
      `SELECT
         sm.student_id,
         s.name  AS subject_name,
         s.code  AS subject_code,
         es.total_marks, es.passing_marks,
         sm.obtained_marks, sm.remarks,
         ROUND(sm.obtained_marks / NULLIF(es.total_marks,0) * 100, 2)              AS subject_percentage,
         calculate_grade(
           ROUND(sm.obtained_marks / NULLIF(es.total_marks,0) * 100, 2)
         )                                                                          AS subject_grade,
         CASE WHEN sm.obtained_marks >= es.passing_marks THEN 'pass' ELSE 'fail' END AS subject_status
       FROM student_marks sm
       JOIN subjects      s  ON s.id  = sm.subject_id
       JOIN exam_subjects es ON es.exam_id    = sm.exam_id
                             AND es.class_id   = sm.class_id
                             AND es.subject_id = sm.subject_id
       WHERE sm.exam_id = $1 AND sm.class_id = $2
       ORDER BY sm.student_id, s.name`,
      [examId, classId]
    );

    // Group marks by student
    const marksMap = {};
    allMarks.forEach(m => {
      if (!marksMap[m.student_id]) marksMap[m.student_id] = [];
      marksMap[m.student_id].push(m);
    });

    // School settings
    const { rows: settingsRows } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
       ('school_name','school_address','school_phone','school_email','school_logo','currency')`
    );
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });

    const data = results.map(r => ({
      summary: {
        ...r,
        exam_name:     examRows[0].exam_name,
        exam_type:     examRows[0].exam_type,
        academic_year: examRows[0].academic_year,
        start_date:    examRows[0].start_date,
        end_date:      examRows[0].end_date,
      },
      subjects: marksMap[r.student_id] || [],
      settings,
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  STUDENT PERFORMANCE  (longitudinal view across all exams)
// ══════════════════════════════════════════════════════════════

// GET /api/exams/student/:studentId/performance
const getStudentPerformance = async (req, res) => {
  try {
    const { studentId } = req.params;

    // Student info
    const { rows: studentRows } = await pool.query(
      `SELECT s.id, s.full_name, s.roll_number, s.father_name, s.gender, s.status,
              c.name AS class_name, c.grade, c.section
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.id = $1`,
      [studentId]
    );
    if (!studentRows[0])
      return res.status(404).json({ success: false, message: 'Student not found' });

    // All result summaries for this student, with per-exam class rank
    const { rows: results } = await pool.query(
      `SELECT
         rs.exam_id,
         rs.class_id,
         rs.total_marks,
         rs.obtained_marks,
         rs.percentage,
         rs.grade,
         rs.result_status,
         rs.generated_at,
         e.exam_name,
         e.exam_type,
         e.academic_year,
         e.start_date,
         c.name AS class_name,
         (SELECT COUNT(*)::int + 1 FROM result_summary r2
          WHERE r2.exam_id = rs.exam_id AND r2.class_id = rs.class_id
            AND r2.percentage > rs.percentage)   AS rank,
         (SELECT COUNT(*)::int FROM result_summary r3
          WHERE r3.exam_id = rs.exam_id AND r3.class_id = rs.class_id) AS total_in_class
       FROM result_summary rs
       JOIN exams   e ON e.id = rs.exam_id
       JOIN classes c ON c.id = rs.class_id
       WHERE rs.student_id = $1
       ORDER BY e.start_date ASC`,
      [studentId]
    );

    // Subject-wise marks across all exams (for trend graph)
    const { rows: marks } = await pool.query(
      `SELECT
         sm.exam_id,
         sm.obtained_marks,
         es.total_marks,
         es.passing_marks,
         ROUND(sm.obtained_marks / NULLIF(es.total_marks,0) * 100, 2) AS subject_percentage,
         s.name       AS subject_name,
         s.code       AS subject_code,
         e.exam_name,
         e.start_date
       FROM student_marks sm
       JOIN subjects      s  ON s.id  = sm.subject_id
       JOIN exam_subjects es ON es.exam_id    = sm.exam_id
                             AND es.class_id   = sm.class_id
                             AND es.subject_id = sm.subject_id
       JOIN exams         e  ON e.id  = sm.exam_id
       WHERE sm.student_id = $1
       ORDER BY s.name, e.start_date ASC`,
      [studentId]
    );

    // Group marks by subject name
    const subjectMap = {};
    marks.forEach(m => {
      if (!subjectMap[m.subject_name])
        subjectMap[m.subject_name] = { subject_name: m.subject_name, subject_code: m.subject_code, exams: [] };
      subjectMap[m.subject_name].exams.push({
        exam_id:            m.exam_id,
        exam_name:          m.exam_name,
        start_date:         m.start_date,
        obtained_marks:     parseFloat(m.obtained_marks),
        total_marks:        parseFloat(m.total_marks),
        passing_marks:      parseFloat(m.passing_marks),
        subject_percentage: parseFloat(m.subject_percentage),
      });
    });

    res.json({
      success: true,
      data: {
        student:  studentRows[0],
        results,
        subjects: Object.values(subjectMap),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  // Exams
  getExams,
  getExamById,
  createExam,
  updateExam,
  updateExamStatus,
  deleteExam,
  // Exam Subjects
  getExamSubjects,
  addExamSubject,
  removeExamSubject,
  // Marks
  getMarks,
  submitMarks,
  deleteMark,
  // Results
  calculateResults,
  getResults,
  getStudentReportCard,
  getClassRanking,
  getClassReportCards,
  getStudentPerformance,
};
