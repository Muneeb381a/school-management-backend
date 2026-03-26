const pool = require('../db');
const { serverErr } = require('../utils/serverErr');
const err500 = (res, err) => { console.error('[SYLLABUS]', err.message); return serverErr(res, err); };

/* ── GET /api/syllabus  (filter by class_id, subject_id, academic_year) ── */
async function getTopics(req, res) {
  try {
    const { class_id, subject_id, academic_year } = req.query;
    let q = `
      SELECT st.*,
             c.name  AS class_name, c.section,
             s.name  AS subject_name,
             t.full_name AS completed_by_name
      FROM syllabus_topics st
      JOIN classes  c ON c.id = st.class_id
      JOIN subjects s ON s.id = st.subject_id
      LEFT JOIN teachers t ON t.id = st.completed_by
      WHERE 1=1`;
    const p = [];
    if (class_id)     { p.push(class_id);     q += ` AND st.class_id=$${p.length}`; }
    if (subject_id)   { p.push(subject_id);   q += ` AND st.subject_id=$${p.length}`; }
    if (academic_year){ p.push(academic_year); q += ` AND st.academic_year=$${p.length}`; }
    q += ' ORDER BY st.subject_id, st.order_no, st.id';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (e) { err500(res, e); }
}

/* ── GET /api/syllabus/stats ── */
async function getStats(req, res) {
  try {
    const { class_id, academic_year } = req.query;
    let q = `
      SELECT st.subject_id, s.name AS subject_name,
             COUNT(*)::int                                            AS total,
             SUM(CASE WHEN st.is_completed THEN 1 ELSE 0 END)::int  AS completed
      FROM syllabus_topics st
      JOIN subjects s ON s.id = st.subject_id
      WHERE 1=1`;
    const p = [];
    if (class_id)     { p.push(class_id);     q += ` AND st.class_id=$${p.length}`; }
    if (academic_year){ p.push(academic_year); q += ` AND st.academic_year=$${p.length}`; }
    q += ' GROUP BY st.subject_id, s.name ORDER BY s.name';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (e) { err500(res, e); }
}

/* ── POST /api/syllabus ── */
async function createTopic(req, res) {
  try {
    const { class_id, subject_id, topic, description, order_no, academic_year } = req.body;
    if (!class_id || !subject_id || !topic?.trim())
      return res.status(400).json({ success: false, message: 'class_id, subject_id and topic are required' });
    const { rows } = await pool.query(
      `INSERT INTO syllabus_topics (class_id, subject_id, topic, description, order_no, academic_year)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [class_id, subject_id, topic.trim(), description || null, order_no || 1, academic_year || '2024-25']
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { err500(res, e); }
}

/* ── PUT /api/syllabus/:id ── */
async function updateTopic(req, res) {
  try {
    const { topic, description, order_no } = req.body;
    const { rows } = await pool.query(
      `UPDATE syllabus_topics SET topic=$1, description=$2, order_no=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [topic?.trim(), description || null, order_no || 1, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Topic not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { err500(res, e); }
}

/* ── PATCH /api/syllabus/:id/complete ── */
async function markComplete(req, res) {
  try {
    const { is_completed } = req.body;
    const done       = !!is_completed;
    const teacherId  = done && req.user?.entity_id ? parseInt(req.user.entity_id, 10) : null;
    const doneDate   = done ? new Date().toISOString().slice(0, 10) : null;
    const { rows } = await pool.query(
      `UPDATE syllabus_topics
       SET is_completed=$1, completed_by=$2, completed_date=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [done, teacherId, doneDate, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Topic not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { err500(res, e); }
}

/* ── DELETE /api/syllabus/:id ── */
async function deleteTopic(req, res) {
  try {
    const { rows } = await pool.query('DELETE FROM syllabus_topics WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Topic not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) { err500(res, e); }
}

module.exports = { getTopics, getStats, createTopic, updateTopic, markComplete, deleteTopic };
