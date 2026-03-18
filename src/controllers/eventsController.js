const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[EVENTS]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

const getEvents = async (req, res) => {
  try {
    const { academic_year, type, month, is_holiday } = req.query;
    let q = 'SELECT * FROM events WHERE 1=1';
    const p = [];
    if (academic_year) { p.push(academic_year); q += ` AND academic_year=$${p.length}`; }
    if (type)          { p.push(type);          q += ` AND type=$${p.length}`; }
    if (is_holiday !== undefined) { p.push(is_holiday); q += ` AND is_holiday=$${p.length}`; }
    if (month) {
      // month = 'YYYY-MM'
      const [y, m] = month.split('-');
      const first = `${y}-${m}-01`;
      const last  = new Date(parseInt(y), parseInt(m), 0).toISOString().slice(0, 10);
      p.push(first); q += ` AND start_date >= $${p.length}`;
      p.push(last);  q += ` AND start_date <= $${p.length}`;
    }
    q += ' ORDER BY start_date ASC, created_at ASC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const getEventById = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Event not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const createEvent = async (req, res) => {
  try {
    const { title, description, start_date, end_date, type, color, is_holiday, academic_year } = req.body;
    if (!title || !start_date) return res.status(400).json({ success: false, message: 'title and start_date required' });
    const { rows } = await pool.query(`
      INSERT INTO events (title, description, start_date, end_date, type, color, is_holiday, academic_year)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [title.trim(), description||null, start_date, end_date||null,
        type||'general', color||'#6366f1', is_holiday||false, academic_year||'2024-25']);
    res.status(201).json({ success: true, data: rows[0], message: 'Event created' });
  } catch (err) { serverErr(res, err); }
};

const updateEvent = async (req, res) => {
  try {
    const { title, description, start_date, end_date, type, color, is_holiday } = req.body;
    const { rows } = await pool.query(`
      UPDATE events SET title=$1, description=$2, start_date=$3, end_date=$4,
        type=$5, color=$6, is_holiday=$7, updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [title, description||null, start_date, end_date||null,
        type||'general', color||'#6366f1', is_holiday||false, req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Event not found' });
    res.json({ success: true, data: rows[0], message: 'Event updated' });
  } catch (err) { serverErr(res, err); }
};

const deleteEvent = async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM events WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Event not found' });
    res.json({ success: true, message: 'Event deleted' });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getEvents, getEventById, createEvent, updateEvent, deleteEvent };
