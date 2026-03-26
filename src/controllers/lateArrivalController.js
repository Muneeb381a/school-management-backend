const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// POST /late-arrivals
// Upsert late_arrivals; also upsert attendance status='late'
const recordLate = async (req, res) => {
  try {
    const {
      student_id, class_id, date, arrival_time, reason, recorded_by, academic_year,
    } = req.body;

    if (!student_id || !arrival_time) {
      return res.status(400).json({ success: false, message: 'student_id and arrival_time are required' });
    }

    const useDate = date || new Date().toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `INSERT INTO late_arrivals (student_id, class_id, date, arrival_time, reason, recorded_by, academic_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (student_id, date) DO UPDATE SET
         arrival_time  = EXCLUDED.arrival_time,
         class_id      = EXCLUDED.class_id,
         reason        = EXCLUDED.reason,
         recorded_by   = EXCLUDED.recorded_by,
         academic_year = EXCLUDED.academic_year
       RETURNING *`,
      [student_id, class_id || null, useDate, arrival_time, reason || null,
       recorded_by || null, academic_year || '2024-25'],
    );

    // Upsert attendance as 'late' for the same student/date
    await pool.query(
      `INSERT INTO attendance (entity_type, entity_id, date, status, marked_by)
       VALUES ('student', $1, $2, 'late', $3)
       ON CONFLICT (entity_type, entity_id, date) WHERE period_id IS NULL
       DO UPDATE SET status = 'late', marked_by = EXCLUDED.marked_by, updated_at = NOW()`,
      [student_id, useDate, recorded_by || null],
    );

    // Fetch with student name
    const { rows: full } = await pool.query(
      `SELECT la.*, s.full_name, s.roll_number, c.name AS class_name
       FROM late_arrivals la
       JOIN students s ON s.id = la.student_id
       LEFT JOIN classes c ON c.id = la.class_id
       WHERE la.id = $1`,
      [rows[0].id],
    );

    res.status(201).json({ success: true, data: full[0], message: 'Late arrival recorded' });
  } catch (err) { serverErr(res, err); }
};

// GET /late-arrivals?class_id&date&month&student_id&academic_year
const getLateArrivals = async (req, res) => {
  try {
    const { class_id, date, month, student_id, academic_year } = req.query;
    let q = `
      SELECT la.*, s.full_name, s.roll_number, c.name AS class_name
      FROM late_arrivals la
      JOIN students s ON s.id = la.student_id
      LEFT JOIN classes c ON c.id = la.class_id
      WHERE 1=1
    `;
    const p = [];
    if (class_id)      { p.push(class_id);      q += ` AND la.class_id=$${p.length}`; }
    if (date)          { p.push(date);           q += ` AND la.date=$${p.length}`; }
    if (month)         { p.push(month);          q += ` AND TO_CHAR(la.date,'YYYY-MM')=$${p.length}`; }
    if (student_id)    { p.push(student_id);     q += ` AND la.student_id=$${p.length}`; }
    if (academic_year) { p.push(academic_year);  q += ` AND la.academic_year=$${p.length}`; }
    q += ' ORDER BY la.date DESC, la.arrival_time';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /late-arrivals/register?class_id&month
const getMonthlyRegister = async (req, res) => {
  try {
    const { class_id, month } = req.query;
    if (!class_id || !month) {
      return res.status(400).json({ success: false, message: 'class_id and month (YYYY-MM) are required' });
    }

    const { rows: classRows } = await pool.query(
      'SELECT * FROM classes WHERE id=$1', [class_id],
    );
    if (!classRows[0]) return res.status(404).json({ success: false, message: 'Class not found' });

    const { rows: students } = await pool.query(
      `SELECT s.id, s.full_name, s.roll_number,
              COALESCE(
                JSON_AGG(la.date ORDER BY la.date) FILTER (WHERE la.date IS NOT NULL),
                '[]'
              ) AS late_dates
       FROM students s
       LEFT JOIN late_arrivals la
         ON la.student_id = s.id
        AND TO_CHAR(la.date,'YYYY-MM') = $2
       WHERE s.class_id = $1
         AND s.deleted_at IS NULL
         AND s.status = 'active'
       GROUP BY s.id, s.full_name, s.roll_number
       ORDER BY s.roll_number NULLS LAST, s.full_name`,
      [class_id, month],
    );

    res.json({
      success: true,
      data: {
        class: classRows[0],
        month,
        students,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// DELETE /late-arrivals/:id  (admin only)
const deleteLate = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM late_arrivals WHERE id=$1 RETURNING *', [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, message: 'Late arrival record deleted', data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

module.exports = { recordLate, getLateArrivals, getMonthlyRegister, deleteLate };
