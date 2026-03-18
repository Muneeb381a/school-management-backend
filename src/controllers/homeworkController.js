const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[HOMEWORK]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

const getHomework = async (req, res) => {
  try {
    const { class_id, subject_id, teacher_id, status, academic_year, due_from, due_to } = req.query;
    let q = `
      SELECT h.*, c.name AS class_name, c.grade, c.section,
             s.name AS subject_name, t.full_name AS teacher_name
      FROM homework h
      LEFT JOIN classes  c ON c.id = h.class_id
      LEFT JOIN subjects s ON s.id = h.subject_id
      LEFT JOIN teachers t ON t.id = h.teacher_id
      WHERE 1=1
    `;
    const p = [];
    if (class_id)      { p.push(class_id);      q += ` AND h.class_id=$${p.length}`; }
    if (subject_id)    { p.push(subject_id);    q += ` AND h.subject_id=$${p.length}`; }
    if (teacher_id)    { p.push(teacher_id);    q += ` AND h.teacher_id=$${p.length}`; }
    if (status)        { p.push(status);        q += ` AND h.status=$${p.length}`; }
    if (academic_year) { p.push(academic_year); q += ` AND h.academic_year=$${p.length}`; }
    if (due_from)      { p.push(due_from);      q += ` AND h.due_date >= $${p.length}`; }
    if (due_to)        { p.push(due_to);        q += ` AND h.due_date <= $${p.length}`; }
    q += ' ORDER BY h.due_date DESC, h.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const getHomeworkById = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.*, c.name AS class_name, s.name AS subject_name, t.full_name AS teacher_name
      FROM homework h
      LEFT JOIN classes c ON c.id = h.class_id
      LEFT JOIN subjects s ON s.id = h.subject_id
      LEFT JOIN teachers t ON t.id = h.teacher_id
      WHERE h.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Homework not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const createHomework = async (req, res) => {
  try {
    const { class_id, subject_id, teacher_id, title, description, due_date, academic_year } = req.body;
    if (!title || !due_date) return res.status(400).json({ success: false, message: 'title and due_date required' });
    const { rows } = await pool.query(`
      INSERT INTO homework (class_id, subject_id, teacher_id, title, description, due_date, academic_year)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [class_id||null, subject_id||null, teacher_id||null, title.trim(),
        description||null, due_date, academic_year||'2024-25']);
    res.status(201).json({ success: true, data: rows[0], message: 'Homework assigned' });
  } catch (err) { serverErr(res, err); }
};

const updateHomework = async (req, res) => {
  try {
    const { class_id, subject_id, teacher_id, title, description, due_date, status } = req.body;
    const { rows } = await pool.query(`
      UPDATE homework SET
        class_id=$1, subject_id=$2, teacher_id=$3, title=$4, description=$5,
        due_date=$6, status=$7, updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [class_id||null, subject_id||null, teacher_id||null, title,
        description||null, due_date, status||'active', req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Homework not found' });
    res.json({ success: true, data: rows[0], message: 'Homework updated' });
  } catch (err) { serverErr(res, err); }
};

const deleteHomework = async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM homework WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Homework not found' });
    res.json({ success: true, message: 'Homework deleted' });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getHomework, getHomeworkById, createHomework, updateHomework, deleteHomework };
