const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[QUIZ]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// GET /quizzes?class_id&subject_id&status
const getQuizzes = async (req, res) => {
  try {
    const { class_id, subject_id, status, academic_year } = req.query;
    let q = `
      SELECT qz.*, c.name AS class_name, s.name AS subject_name, t.full_name AS teacher_name
      FROM quizzes qz
      LEFT JOIN classes  c ON c.id = qz.class_id
      LEFT JOIN subjects s ON s.id = qz.subject_id
      LEFT JOIN teachers t ON t.id = qz.teacher_id
      WHERE 1=1
    `;
    const p = [];
    if (class_id)      { p.push(class_id);      q += ` AND qz.class_id=$${p.length}`; }
    if (subject_id)    { p.push(subject_id);    q += ` AND qz.subject_id=$${p.length}`; }
    if (status)        { p.push(status);        q += ` AND qz.status=$${p.length}`; }
    if (academic_year) { p.push(academic_year); q += ` AND qz.academic_year=$${p.length}`; }
    q += ' ORDER BY qz.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /quizzes/:id
const getQuizById = async (req, res) => {
  try {
    const isStudent = req.user?.role === 'student';

    const { rows: quizRows } = await pool.query(
      `SELECT qz.*, c.name AS class_name, s.name AS subject_name, t.full_name AS teacher_name
       FROM quizzes qz
       LEFT JOIN classes  c ON c.id = qz.class_id
       LEFT JOIN subjects s ON s.id = qz.subject_id
       LEFT JOIN teachers t ON t.id = qz.teacher_id
       WHERE qz.id=$1`,
      [req.params.id],
    );
    if (!quizRows[0]) return res.status(404).json({ success: false, message: 'Quiz not found' });

    // Exclude correct_option for students
    const questionSelect = isStudent
      ? 'id, quiz_id, question_text, question_type, marks, options, order_no, created_at'
      : 'id, quiz_id, question_text, question_type, marks, options, correct_option, order_no, created_at';

    const { rows: questions } = await pool.query(
      `SELECT ${questionSelect} FROM quiz_questions WHERE quiz_id=$1 ORDER BY order_no`,
      [req.params.id],
    );

    res.json({ success: true, data: { ...quizRows[0], questions } });
  } catch (err) { serverErr(res, err); }
};

// POST /quizzes
const createQuiz = async (req, res) => {
  try {
    const {
      title, class_id, subject_id, teacher_id, instructions,
      duration_min, total_marks, pass_marks, status, open_from, open_until, academic_year,
    } = req.body;

    if (!title) return res.status(400).json({ success: false, message: 'title is required' });

    const { rows } = await pool.query(
      `INSERT INTO quizzes
         (title, class_id, subject_id, teacher_id, instructions, duration_min,
          total_marks, pass_marks, status, open_from, open_until, academic_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [title, class_id || null, subject_id || null, teacher_id || null,
       instructions || null, duration_min || 30,
       total_marks || null, pass_marks || null,
       status || 'draft', open_from || null, open_until || null,
       academic_year || '2024-25'],
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Quiz created' });
  } catch (err) { serverErr(res, err); }
};

// PUT /quizzes/:id
const updateQuiz = async (req, res) => {
  try {
    const {
      title, class_id, subject_id, teacher_id, instructions,
      duration_min, total_marks, pass_marks, status, open_from, open_until, academic_year,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE quizzes SET
         title         = COALESCE($1, title),
         class_id      = COALESCE($2, class_id),
         subject_id    = COALESCE($3, subject_id),
         teacher_id    = COALESCE($4, teacher_id),
         instructions  = COALESCE($5, instructions),
         duration_min  = COALESCE($6, duration_min),
         total_marks   = COALESCE($7, total_marks),
         pass_marks    = COALESCE($8, pass_marks),
         status        = COALESCE($9, status),
         open_from     = COALESCE($10, open_from),
         open_until    = COALESCE($11, open_until),
         academic_year = COALESCE($12, academic_year),
         updated_at    = NOW()
       WHERE id=$13 RETURNING *`,
      [title || null, class_id !== undefined ? class_id : null,
       subject_id !== undefined ? subject_id : null,
       teacher_id !== undefined ? teacher_id : null,
       instructions || null, duration_min || null,
       total_marks !== undefined ? total_marks : null,
       pass_marks !== undefined ? pass_marks : null,
       status || null, open_from || null, open_until || null,
       academic_year || null, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Quiz not found' });
    res.json({ success: true, data: rows[0], message: 'Quiz updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /quizzes/:id
const deleteQuiz = async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM quizzes WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Quiz not found' });
    res.json({ success: true, message: 'Quiz deleted', data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// POST /quizzes/:id/questions
const addQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    const { question_text, question_type, marks, options, correct_option, order_no } = req.body;

    if (!question_text || !question_type) {
      return res.status(400).json({ success: false, message: 'question_text and question_type are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO quiz_questions (quiz_id, question_text, question_type, marks, options, correct_option, order_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, question_text, question_type, marks || 1,
       options ? JSON.stringify(options) : null,
       correct_option || null, order_no || 1],
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Question added' });
  } catch (err) { serverErr(res, err); }
};

// PUT /quizzes/questions/:question_id
const updateQuestion = async (req, res) => {
  try {
    const { question_text, question_type, marks, options, correct_option, order_no } = req.body;
    const { rows } = await pool.query(
      `UPDATE quiz_questions SET
         question_text  = COALESCE($1, question_text),
         question_type  = COALESCE($2, question_type),
         marks          = COALESCE($3, marks),
         options        = COALESCE($4, options),
         correct_option = COALESCE($5, correct_option),
         order_no       = COALESCE($6, order_no)
       WHERE id=$7 RETURNING *`,
      [question_text || null, question_type || null, marks || null,
       options ? JSON.stringify(options) : null,
       correct_option || null, order_no || null, req.params.question_id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Question not found' });
    res.json({ success: true, data: rows[0], message: 'Question updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /quizzes/questions/:question_id
const deleteQuestion = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM quiz_questions WHERE id=$1 RETURNING *', [req.params.question_id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Question not found' });
    res.json({ success: true, message: 'Question deleted', data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// POST /quizzes/:id/start
const startAttempt = async (req, res) => {
  try {
    const { id } = req.params;
    const studentId = req.body.student_id || req.user?.studentId;

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'student_id is required' });
    }

    const { rows: quizRows } = await pool.query(
      'SELECT * FROM quizzes WHERE id=$1', [id],
    );
    if (!quizRows[0]) return res.status(404).json({ success: false, message: 'Quiz not found' });

    const quiz = quizRows[0];
    if (quiz.status !== 'published') {
      return res.status(400).json({ success: false, message: 'Quiz is not published' });
    }

    const now = new Date();
    if (quiz.open_from && new Date(quiz.open_from) > now) {
      return res.status(400).json({ success: false, message: 'Quiz has not started yet' });
    }
    if (quiz.open_until && new Date(quiz.open_until) < now) {
      return res.status(400).json({ success: false, message: 'Quiz has ended' });
    }

    // Check for existing attempt
    const { rows: existing } = await pool.query(
      'SELECT * FROM quiz_attempts WHERE quiz_id=$1 AND student_id=$2', [id, studentId],
    );
    if (existing[0]) {
      return res.status(409).json({ success: false, message: 'Attempt already started', data: existing[0] });
    }

    const { rows: attemptRows } = await pool.query(
      `INSERT INTO quiz_attempts (quiz_id, student_id, total_marks, status)
       VALUES ($1,$2,$3,'in_progress') RETURNING *`,
      [id, studentId, quiz.total_marks],
    );

    // Return quiz with questions — correct_option EXCLUDED for student
    const { rows: questions } = await pool.query(
      `SELECT id, quiz_id, question_text, question_type, marks, options, order_no
       FROM quiz_questions WHERE quiz_id=$1 ORDER BY order_no`,
      [id],
    );

    res.status(201).json({
      success: true,
      data: {
        attempt: attemptRows[0],
        quiz: { ...quiz, questions },
      },
      message: 'Attempt started',
    });
  } catch (err) { serverErr(res, err); }
};

// POST /quizzes/:id/submit
// Body: {student_id, answers:[{question_id, answer_text}]}
const submitAttempt = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const studentId = req.body.student_id || req.user?.studentId;
    const { answers } = req.body;

    if (!studentId) return res.status(400).json({ success: false, message: 'student_id is required' });
    if (!Array.isArray(answers)) return res.status(400).json({ success: false, message: 'answers array is required' });

    await client.query('BEGIN');

    const { rows: attemptRows } = await client.query(
      `SELECT * FROM quiz_attempts WHERE quiz_id=$1 AND student_id=$2 FOR UPDATE`,
      [id, studentId],
    );
    if (!attemptRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'No active attempt found' });
    }
    if (attemptRows[0].status !== 'in_progress') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Attempt already submitted' });
    }

    const attempt = attemptRows[0];
    let totalScored = 0;

    for (const ans of answers) {
      const { question_id, answer_text } = ans;

      // Fetch the question for type + correct_option + marks
      const { rows: qRows } = await client.query(
        'SELECT * FROM quiz_questions WHERE id=$1', [question_id],
      );
      if (!qRows[0]) continue;
      const question = qRows[0];

      let isCorrect = null;
      let marksAwarded = null;

      if (question.question_type === 'mcq') {
        isCorrect = answer_text === question.correct_option;
        marksAwarded = isCorrect ? parseFloat(question.marks) : 0;
        totalScored += marksAwarded;
      }
      // short_answer: leave isCorrect=NULL, marksAwarded=NULL (needs teacher grading)

      await client.query(
        `INSERT INTO quiz_answers (attempt_id, question_id, answer_text, is_correct, marks_awarded)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (attempt_id, question_id) DO UPDATE SET
           answer_text   = EXCLUDED.answer_text,
           is_correct    = EXCLUDED.is_correct,
           marks_awarded = EXCLUDED.marks_awarded,
           updated_at    = NOW()`,
        [attempt.id, question_id, answer_text || null, isCorrect, marksAwarded],
      );
    }

    // Check if there are any short_answer questions — if so, not fully auto-graded
    const { rows: saCount } = await client.query(
      `SELECT COUNT(*) AS cnt FROM quiz_questions WHERE quiz_id=$1 AND question_type='short_answer'`,
      [id],
    );
    const hasShortAnswer = parseInt(saCount[0].cnt, 10) > 0;

    await client.query(
      `UPDATE quiz_attempts SET
         submitted_at = NOW(),
         scored_marks = $1,
         status       = 'submitted',
         is_graded    = $2
       WHERE id=$3`,
      [totalScored, !hasShortAnswer, attempt.id],
    );

    await client.query('COMMIT');

    const { rows: finalAttempt } = await pool.query(
      'SELECT * FROM quiz_attempts WHERE id=$1', [attempt.id],
    );

    res.json({ success: true, data: finalAttempt[0], message: 'Quiz submitted' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// PUT /quizzes/attempts/:attempt_id/grade
// Body: {grades:[{question_id, marks_awarded, teacher_feedback}]}
const gradeShortAnswers = async (req, res) => {
  const client = await pool.connect();
  try {
    const { attempt_id } = req.params;
    const { grades } = req.body;

    if (!Array.isArray(grades)) {
      return res.status(400).json({ success: false, message: 'grades array is required' });
    }

    await client.query('BEGIN');

    for (const grade of grades) {
      const { question_id, marks_awarded, teacher_feedback } = grade;
      await client.query(
        `UPDATE quiz_answers SET
           marks_awarded    = $1,
           teacher_feedback = $2,
           is_correct       = CASE WHEN $1 > 0 THEN TRUE ELSE FALSE END,
           updated_at       = NOW()
         WHERE attempt_id=$3 AND question_id=$4`,
        [marks_awarded || 0, teacher_feedback || null, attempt_id, question_id],
      );
    }

    // Recalculate total scored_marks
    const { rows: scoreRows } = await client.query(
      `SELECT COALESCE(SUM(marks_awarded), 0) AS total
       FROM quiz_answers WHERE attempt_id=$1`,
      [attempt_id],
    );

    await client.query(
      `UPDATE quiz_attempts SET
         scored_marks = $1,
         is_graded    = TRUE,
         status       = 'graded',
         updated_at   = NOW()
       WHERE id=$2`,
      [scoreRows[0].total, attempt_id],
    );

    await client.query('COMMIT');

    const { rows: finalAttempt } = await pool.query(
      'SELECT * FROM quiz_attempts WHERE id=$1', [attempt_id],
    );

    res.json({ success: true, data: finalAttempt[0], message: 'Grading saved' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// GET /quizzes/attempts/:id
const getAttemptResults = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: attemptRows } = await pool.query(
      `SELECT qa.*, s.full_name AS student_name
       FROM quiz_attempts qa
       LEFT JOIN students s ON s.id = qa.student_id
       WHERE qa.id=$1`,
      [id],
    );
    if (!attemptRows[0]) return res.status(404).json({ success: false, message: 'Attempt not found' });

    const { rows: answers } = await pool.query(
      `SELECT qan.*, qq.question_text, qq.question_type, qq.marks AS max_marks,
              qq.correct_option, qq.options
       FROM quiz_answers qan
       JOIN quiz_questions qq ON qq.id = qan.question_id
       WHERE qan.attempt_id=$1
       ORDER BY qq.order_no`,
      [id],
    );

    res.json({ success: true, data: { ...attemptRows[0], answers } });
  } catch (err) { serverErr(res, err); }
};

// GET /quizzes/:id/results
const getQuizResults = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT qa.*,
              s.full_name AS student_name, s.roll_number, s.admission_number
       FROM quiz_attempts qa
       JOIN students s ON s.id = qa.student_id
       WHERE qa.quiz_id=$1
       ORDER BY qa.scored_marks DESC NULLS LAST, s.full_name`,
      [id],
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getQuizzes, getQuizById, createQuiz, updateQuiz, deleteQuiz,
  addQuestion, updateQuestion, deleteQuestion,
  startAttempt, submitAttempt, gradeShortAnswers,
  getAttemptResults, getQuizResults,
};
