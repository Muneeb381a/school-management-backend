const pool = require('../db');
const { serverErr } = require('../utils/serverErr');

// ── GET /api/study-planner/student/:studentId ─────────────────────────────────
// Returns teacher-assigned topics + auto-suggestions from weak subjects
const getStudentPlan = async (req, res) => {
  const { studentId } = req.params;
  try {
    const { rows: [student] } = await pool.query(
      `SELECT s.id, s.class_id, c.name AS class_name
       FROM students s LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.id = $1`,
      [studentId]
    );
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const [assignedRes, weakRes] = await Promise.all([
      // Teacher-assigned topics for this student OR their whole class
      pool.query(
        `SELECT spt.*, sub.name AS subject_name, t.full_name AS assigned_by_name
         FROM study_plan_topics spt
         LEFT JOIN subjects sub ON sub.id = spt.subject_id
         LEFT JOIN teachers t   ON t.id   = spt.assigned_by
         WHERE (spt.student_id = $1 OR (spt.class_id = $2 AND spt.student_id IS NULL))
           AND spt.is_completed = FALSE
         ORDER BY spt.priority ASC, spt.created_at DESC`,
        [studentId, student.class_id]
      ),
      // Weak subjects: avg score below passing threshold
      pool.query(
        `SELECT
           sub.id   AS subject_id,
           sub.name AS subject_name,
           ROUND(AVG(sm.obtained_marks::numeric / NULLIF(es.total_marks,0) * 100), 1) AS avg_pct,
           ROUND(AVG(es.passing_marks::numeric / NULLIF(es.total_marks,0) * 100), 1) AS passing_pct
         FROM student_marks sm
         JOIN exam_subjects es
           ON es.exam_id    = sm.exam_id
          AND es.subject_id = sm.subject_id
          AND es.class_id   = $2
         JOIN subjects sub ON sub.id = sm.subject_id
         WHERE sm.student_id = $1 AND sm.is_absent = FALSE
         GROUP BY sub.id, sub.name
         HAVING AVG(sm.obtained_marks::numeric / NULLIF(es.total_marks,0) * 100) <
                AVG(es.passing_marks::numeric / NULLIF(es.total_marks,0) * 100)
         ORDER BY avg_pct ASC
         LIMIT 3`,
        [studentId, student.class_id]
      ),
    ]);

    // For each weak subject, pull its 2 most upcoming incomplete syllabus topics
    const suggestions = await Promise.all(
      weakRes.rows.map(sub =>
        pool.query(
          `SELECT st.id, st.topic, st.description, st.order_no
           FROM syllabus_topics st
           WHERE st.subject_id = $1 AND st.class_id = $2 AND st.is_completed = FALSE
           ORDER BY st.order_no ASC
           LIMIT 2`,
          [sub.subject_id, student.class_id]
        ).then(r => ({ ...sub, syllabus_topics: r.rows }))
      )
    );

    res.json({
      success: true,
      data: { assigned: assignedRes.rows, suggestions, student },
    });
  } catch (err) { serverErr(res, err); }
};

// ── POST /api/study-planner ───────────────────────────────────────────────────
// Teacher assigns a focus topic to a student or a whole class
const assignTopic = async (req, res) => {
  const { student_id, class_id, subject_id, topic, description, priority, due_date, academic_year } = req.body;
  if (!topic?.trim()) return res.status(400).json({ success: false, message: 'topic is required' });
  if (!student_id && !class_id) return res.status(400).json({ success: false, message: 'student_id or class_id is required' });

  const assigned_by = req.user?.entity_id || null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO study_plan_topics
         (student_id, class_id, subject_id, topic, description, priority, assigned_by, due_date, academic_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        student_id || null,
        student_id ? null : (class_id || null),
        subject_id || null,
        topic.trim(),
        description?.trim() || null,
        priority || 2,
        assigned_by,
        due_date || null,
        academic_year || '2024-25',
      ]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Topic assigned' });
  } catch (err) { serverErr(res, err); }
};

// ── PATCH /api/study-planner/:id ──────────────────────────────────────────────
const updateTopic = async (req, res) => {
  const { topic, description, priority, due_date } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE study_plan_topics
          SET topic       = COALESCE($1, topic),
              description = COALESCE($2, description),
              priority    = COALESCE($3, priority),
              due_date    = COALESCE($4, due_date)
        WHERE id = $5
        RETURNING *`,
      [topic?.trim() || null, description?.trim() || null, priority || null, due_date || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Topic not found' });
    res.json({ success: true, data: rows[0], message: 'Topic updated' });
  } catch (err) { serverErr(res, err); }
};

// ── PATCH /api/study-planner/:id/complete ────────────────────────────────────
// Student (or teacher) marks a topic as done
const completeTopic = async (req, res) => {
  const done = req.body.is_completed !== false;
  try {
    const { rows } = await pool.query(
      `UPDATE study_plan_topics
          SET is_completed = $1,
              completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END
        WHERE id = $2
        RETURNING *`,
      [done, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Topic not found' });
    res.json({ success: true, data: rows[0], message: done ? 'Marked complete' : 'Marked incomplete' });
  } catch (err) { serverErr(res, err); }
};

// ── DELETE /api/study-planner/:id ─────────────────────────────────────────────
const deleteTopic = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM study_plan_topics WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Topic not found' });
    res.json({ success: true, message: 'Topic removed' });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/study-planner/class/:classId ────────────────────────────────────
// Teacher view: all topics assigned to a class
const getClassPlan = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT spt.*, sub.name AS subject_name,
              s.full_name AS student_name, t.full_name AS assigned_by_name
       FROM study_plan_topics spt
       LEFT JOIN subjects sub ON sub.id = spt.subject_id
       LEFT JOIN students  s  ON s.id   = spt.student_id
       LEFT JOIN teachers  t  ON t.id   = spt.assigned_by
       WHERE spt.class_id = $1 OR spt.student_id IN (
         SELECT id FROM students WHERE class_id = $1 AND status = 'active'
       )
       ORDER BY spt.priority ASC, spt.created_at DESC`,
      [req.params.classId]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getStudentPlan, assignTopic, updateTopic, completeTopic, deleteTopic, getClassPlan };
