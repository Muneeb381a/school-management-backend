const pool = require('../db');

const err = (res, e, code = 500) => {
  console.error('[PAPERS]', e.message);
  res.status(code).json({ success: false, message: e.message });
};

// ── Helper: fetch full paper (sections + questions nested) ────────────────────
async function fetchFullPaper(id) {
  const { rows: [paper] } = await pool.query(
    `SELECT p.*,
            u.name AS created_by_name
     FROM exam_papers p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.id = $1`,
    [id]
  );
  if (!paper) return null;

  const { rows: sections } = await pool.query(
    `SELECT * FROM paper_sections WHERE paper_id = $1 ORDER BY sort_order`,
    [id]
  );

  const { rows: questions } = await pool.query(
    `SELECT * FROM paper_questions
     WHERE section_id = ANY($1::int[])
     ORDER BY section_id, sort_order`,
    [sections.map(s => s.id)]
  );

  paper.sections = sections.map(sec => ({
    ...sec,
    questions: questions.filter(q => q.section_id === sec.id),
  }));

  // Compute total marks from questions
  paper.computed_total = questions.reduce((sum, q) => {
    if (q.sub_parts && Array.isArray(q.sub_parts) && q.sub_parts.length > 0) {
      return sum + q.sub_parts.reduce((s, p) => s + Number(p.marks || 0), 0);
    }
    return sum + Number(q.marks || 0);
  }, 0);

  return paper;
}

// ── Ownership guard helper ─────────────────────────────────────────────────────
// Returns true if the user is allowed to access this paper
function ownsOrAdmin(req, paper) {
  if (req.user?.role === 'admin') return true;
  return String(paper.created_by) === String(req.user?.id);
}

// ── GET /api/papers ───────────────────────────────────────────────────────────
async function getPapers(req, res) {
  try {
    const { academic_year, class_name, subject, exam_id } = req.query;
    let q = `SELECT p.*, u.name AS created_by_name,
               e.exam_name,
               COUNT(pq.id)::INT AS question_count
             FROM exam_papers p
             LEFT JOIN users u ON u.id = p.created_by
             LEFT JOIN exams e ON e.id = p.exam_id
             LEFT JOIN paper_sections ps ON ps.paper_id = p.id
             LEFT JOIN paper_questions pq ON pq.section_id = ps.id
             WHERE 1=1`;
    const vals = [];
    const push = v => { vals.push(v); return `$${vals.length}`; };

    // Teachers only see their own papers
    if (req.user?.role === 'teacher') q += ` AND p.created_by = ${push(req.user.id)}`;

    if (academic_year) q += ` AND p.academic_year = ${push(academic_year)}`;
    if (class_name)    q += ` AND p.class_name ILIKE ${push(`%${class_name}%`)}`;
    if (subject)       q += ` AND p.subject ILIKE ${push(`%${subject}%`)}`;
    if (exam_id)       q += ` AND p.exam_id = ${push(Number(exam_id))}`;

    q += ' GROUP BY p.id, u.name, e.exam_name ORDER BY p.created_at DESC';

    const { rows } = await pool.query(q, vals);
    res.json({ success: true, data: rows });
  } catch (e) { err(res, e); }
}

// ── POST /api/papers ──────────────────────────────────────────────────────────
async function createPaper(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      title, subject = '', class_name = '', exam_id = null,
      academic_year = '2025-26', total_marks = 100, duration_mins = 180,
      paper_date = null, instructions = '', note = '',
      school_name_override = null,
      teacher_user_id = null,   // admin can assign paper to a specific teacher
    } = req.body;

    if (!title?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'title is required' });
    }

    // Admin can assign paper to a specific teacher; otherwise default to creator
    const authorId = (req.user?.role === 'admin' && teacher_user_id)
      ? Number(teacher_user_id)
      : (req.user?.id || null);

    const { rows: [paper] } = await client.query(
      `INSERT INTO exam_papers
         (title, subject, class_name, exam_id, academic_year,
          total_marks, duration_mins, paper_date, instructions, note,
          school_name_override, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        title.trim(), subject, class_name, exam_id ? Number(exam_id) : null,
        academic_year, Number(total_marks), Number(duration_mins),
        paper_date || null, instructions, note,
        school_name_override || null, authorId,
      ]
    );

    // Auto-create the three standard sections
    const defaultSections = [
      { type: 'mcq',   title: 'SECTION A: MULTIPLE CHOICE QUESTIONS', instructions: 'Choose the correct answer.',        marks_per_q: 1, order: 1 },
      { type: 'short', title: 'SECTION B: SHORT ANSWER QUESTIONS',    instructions: 'Attempt any 6 of the following.',   marks_per_q: 5, order: 2 },
      { type: 'long',  title: 'SECTION C: LONG ANSWER QUESTIONS',     instructions: 'Attempt any 3 of the following.',   marks_per_q: 10, order: 3 },
    ];

    for (const s of defaultSections) {
      await client.query(
        `INSERT INTO paper_sections (paper_id, section_type, title, instructions, marks_per_q, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [paper.id, s.type, s.title, s.instructions, s.marks_per_q, s.order]
      );
    }

    await client.query('COMMIT');

    const full = await fetchFullPaper(paper.id);
    res.status(201).json({ success: true, data: full, message: 'Paper created' });
  } catch (e) {
    await client.query('ROLLBACK');
    err(res, e);
  } finally { client.release(); }
}

// ── GET /api/papers/:id ───────────────────────────────────────────────────────
async function getPaper(req, res) {
  try {
    const paper = await fetchFullPaper(req.params.id);
    if (!paper) return res.status(404).json({ success: false, message: 'Paper not found' });
    if (!ownsOrAdmin(req, paper)) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, data: paper });
  } catch (e) { err(res, e); }
}

// ── PUT /api/papers/:id ───────────────────────────────────────────────────────
async function updatePaper(req, res) {
  try {
    const { rows: [existing] } = await pool.query('SELECT created_by FROM exam_papers WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, message: 'Paper not found' });
    if (!ownsOrAdmin(req, existing)) return res.status(403).json({ success: false, message: 'Access denied' });

    const {
      title, subject, class_name, exam_id, academic_year,
      total_marks, duration_mins, paper_date, instructions, note,
      school_name_override,
    } = req.body;

    // exam_id: frontend sends explicit null to unlink, or a number to link
    const examIdValue = 'exam_id' in req.body
      ? (req.body.exam_id ? Number(req.body.exam_id) : null)
      : undefined;

    const { rows: [p] } = await pool.query(
      `UPDATE exam_papers SET
         title                = COALESCE($1, title),
         subject              = COALESCE($2, subject),
         class_name           = COALESCE($3, class_name),
         exam_id              = CASE WHEN $4::boolean THEN $5::int ELSE exam_id END,
         academic_year        = COALESCE($6, academic_year),
         total_marks          = COALESCE($7, total_marks),
         duration_mins        = COALESCE($8, duration_mins),
         paper_date           = COALESCE($9, paper_date),
         instructions         = COALESCE($10, instructions),
         note                 = COALESCE($11, note),
         school_name_override = COALESCE($12, school_name_override),
         updated_at           = NOW()
       WHERE id = $13 RETURNING id`,
      [
        title?.trim() || null, subject || null, class_name || null,
        examIdValue !== undefined,                          // $4: whether to update exam_id
        examIdValue !== undefined ? examIdValue : null,    // $5: the new value (null = unlink)
        academic_year || null,
        total_marks ? Number(total_marks) : null,
        duration_mins ? Number(duration_mins) : null,
        paper_date || null, instructions ?? null, note ?? null,
        school_name_override ?? null,
        req.params.id,
      ]
    );
    const full = await fetchFullPaper(p.id);
    res.json({ success: true, data: full, message: 'Paper updated' });
  } catch (e) { err(res, e); }
}

// ── DELETE /api/papers/:id ────────────────────────────────────────────────────
async function deletePaper(req, res) {
  try {
    // Admin only — enforced in route, but double-check
    const { rows: [p] } = await pool.query(
      'DELETE FROM exam_papers WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!p) return res.status(404).json({ success: false, message: 'Paper not found' });
    res.json({ success: true, message: 'Paper deleted' });
  } catch (e) { err(res, e); }
}

// ── PUT /api/papers/sections/:id ──────────────────────────────────────────────
async function updateSection(req, res) {
  try {
    const { rows: [sec] } = await pool.query(
      'SELECT ps.id, p.created_by FROM paper_sections ps JOIN exam_papers p ON p.id = ps.paper_id WHERE ps.id=$1',
      [req.params.id]
    );
    if (!sec) return res.status(404).json({ success: false, message: 'Section not found' });
    if (!ownsOrAdmin(req, sec)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { title, instructions, marks_per_q } = req.body;
    const { rows: [s] } = await pool.query(
      `UPDATE paper_sections SET
         title        = COALESCE($1, title),
         instructions = COALESCE($2, instructions),
         marks_per_q  = COALESCE($3, marks_per_q)
       WHERE id = $4 RETURNING id, paper_id`,
      [title || null, instructions ?? null, marks_per_q != null ? Number(marks_per_q) : null, req.params.id]
    );
    const full = await fetchFullPaper(s.paper_id);
    res.json({ success: true, data: full });
  } catch (e) { err(res, e); }
}

// ── POST /api/papers/sections/:sectionId/questions ────────────────────────────
async function addQuestion(req, res) {
  try {
    const { rows: [secRow] } = await pool.query(
      'SELECT ps.id, ps.paper_id, p.created_by FROM paper_sections ps JOIN exam_papers p ON p.id = ps.paper_id WHERE ps.id=$1',
      [req.params.sectionId]
    );
    if (!secRow) return res.status(404).json({ success: false, message: 'Section not found' });
    if (!ownsOrAdmin(req, secRow)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { question_text, marks = 1, options = null, sub_parts = null, sort_order = 0 } = req.body;
    if (!question_text?.trim()) return res.status(400).json({ success: false, message: 'question_text is required' });

    await pool.query(
      `INSERT INTO paper_questions (section_id, question_text, marks, options, sub_parts, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        req.params.sectionId, question_text.trim(), Number(marks),
        options ? JSON.stringify(options) : null,
        sub_parts ? JSON.stringify(sub_parts) : null,
        Number(sort_order),
      ]
    );

    const full = await fetchFullPaper(secRow.paper_id);
    res.status(201).json({ success: true, data: full, message: 'Question added' });
  } catch (e) { err(res, e); }
}

// ── PUT /api/papers/questions/:id ─────────────────────────────────────────────
async function updateQuestion(req, res) {
  try {
    const { rows: [qInfo] } = await pool.query(
      `SELECT p.id AS paper_id, p.created_by FROM paper_questions pq
       JOIN paper_sections ps ON ps.id = pq.section_id
       JOIN exam_papers p ON p.id = ps.paper_id
       WHERE pq.id=$1`,
      [req.params.id]
    );
    if (!qInfo) return res.status(404).json({ success: false, message: 'Question not found' });
    if (!ownsOrAdmin(req, qInfo)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { question_text, marks, options, sub_parts, sort_order } = req.body;
    await pool.query(
      `UPDATE paper_questions SET
         question_text = COALESCE($1, question_text),
         marks         = COALESCE($2, marks),
         options       = COALESCE($3, options),
         sub_parts     = COALESCE($4, sub_parts),
         sort_order    = COALESCE($5, sort_order)
       WHERE id = $6`,
      [
        question_text?.trim() || null,
        marks != null ? Number(marks) : null,
        options !== undefined ? (options ? JSON.stringify(options) : null) : undefined,
        sub_parts !== undefined ? (sub_parts ? JSON.stringify(sub_parts) : null) : undefined,
        sort_order != null ? Number(sort_order) : null,
        req.params.id,
      ]
    );
    const full = await fetchFullPaper(qInfo.paper_id);
    res.json({ success: true, data: full });
  } catch (e) { err(res, e); }
}

// ── DELETE /api/papers/questions/:id ─────────────────────────────────────────
async function deleteQuestion(req, res) {
  try {
    const { rows: [qInfo] } = await pool.query(
      `SELECT p.id AS paper_id, p.created_by FROM paper_questions pq
       JOIN paper_sections ps ON ps.id = pq.section_id
       JOIN exam_papers p ON p.id = ps.paper_id
       WHERE pq.id=$1`,
      [req.params.id]
    );
    if (!qInfo) return res.status(404).json({ success: false, message: 'Question not found' });
    if (!ownsOrAdmin(req, qInfo)) return res.status(403).json({ success: false, message: 'Access denied' });

    await pool.query('DELETE FROM paper_questions WHERE id=$1', [req.params.id]);
    const full = await fetchFullPaper(qInfo.paper_id);
    res.json({ success: true, data: full });
  } catch (e) { err(res, e); }
}

// ── GET /api/papers/teacher-users ─────────────────────────────────────────────
// Returns users with role='teacher' for the assign-teacher dropdown (admin only)
async function getTeacherUsers(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name,
              COALESCE(t.full_name, u.name) AS display_name,
              t.subject
       FROM users u
       LEFT JOIN teachers t ON t.id = u.entity_id
       WHERE u.role = 'teacher'
       ORDER BY display_name`
    );
    res.json({ success: true, data: rows });
  } catch (e) { err(res, e); }
}

module.exports = {
  getPapers, createPaper, getPaper, updatePaper, deletePaper,
  updateSection,
  addQuestion, updateQuestion, deleteQuestion,
  getTeacherUsers,
};
