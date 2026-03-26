const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// ── GET /api/board-exams ──────────────────────────────────────
// Query: exam_year, exam_level, board_name, status, class_id, search
const getRegistrations = async (req, res) => {
  try {
    const { exam_year, exam_level, board_name, status, class_id, search } = req.query;

    let q = `
      SELECT
        ber.id, ber.student_id, ber.academic_year,
        ber.board_name, ber.exam_level, ber.exam_group, ber.exam_year,
        ber.registration_no, ber.board_roll_no,
        ber.centre_no, ber.centre_name,
        ber.registration_date, ber.fee_paid, ber.fee_amount,
        ber.status, ber.total_marks, ber.obtained_marks, ber.grade,
        ber.remarks, ber.created_at, ber.updated_at,
        s.full_name   AS student_name,
        s.roll_number AS school_roll,
        s.father_name,
        s.b_form_no,
        c.name        AS class_name,
        c.grade       AS class_grade,
        c.section
      FROM board_exam_registrations ber
      JOIN students s ON s.id = ber.student_id
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE 1=1
    `;
    const p = [];

    if (exam_year)  { p.push(exam_year);  q += ` AND ber.exam_year = $${p.length}`; }
    if (exam_level) { p.push(exam_level); q += ` AND ber.exam_level = $${p.length}`; }
    if (board_name) { p.push(board_name); q += ` AND ber.board_name = $${p.length}`; }
    if (status)     { p.push(status);     q += ` AND ber.status = $${p.length}`; }
    if (class_id)   { p.push(class_id);   q += ` AND s.class_id = $${p.length}`; }
    if (search)     {
      p.push(`%${search}%`);
      q += ` AND (s.full_name ILIKE $${p.length} OR ber.board_roll_no ILIKE $${p.length} OR ber.registration_no ILIKE $${p.length})`;
    }

    q += ' ORDER BY ber.exam_year DESC, s.full_name';

    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/board-exams/:id ──────────────────────────────────
const getRegistration = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ber.*, s.full_name AS student_name, s.roll_number AS school_roll,
              s.father_name, s.b_form_no,
              c.name AS class_name, c.grade AS class_grade, c.section
       FROM board_exam_registrations ber
       JOIN students s ON s.id = ber.student_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE ber.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Registration not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ── POST /api/board-exams ─────────────────────────────────────
const createRegistration = async (req, res) => {
  try {
    const {
      student_id, academic_year, board_name, exam_level, exam_group,
      exam_year, registration_no, board_roll_no, centre_no, centre_name,
      registration_date, fee_paid, fee_amount, status, remarks,
    } = req.body;

    if (!student_id || !board_name || !exam_level || !exam_year)
      return res.status(400).json({ success: false, message: 'student_id, board_name, exam_level, exam_year are required' });

    const { rows } = await pool.query(
      `INSERT INTO board_exam_registrations
         (student_id, academic_year, board_name, exam_level, exam_group,
          exam_year, registration_no, board_roll_no, centre_no, centre_name,
          registration_date, fee_paid, fee_amount, status, remarks, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       RETURNING *`,
      [
        student_id, academic_year || null, board_name, exam_level, exam_group || null,
        exam_year, registration_no || null, board_roll_no || null,
        centre_no || null, centre_name || null,
        registration_date || null, fee_paid ?? false, fee_amount || null,
        status || 'registered', remarks || null,
      ]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Registration created' });
  } catch (err) { serverErr(res, err); }
};

// ── PUT /api/board-exams/:id ──────────────────────────────────
const updateRegistration = async (req, res) => {
  try {
    const {
      academic_year, board_name, exam_level, exam_group,
      exam_year, registration_no, board_roll_no, centre_no, centre_name,
      registration_date, fee_paid, fee_amount, status,
      total_marks, obtained_marks, grade, remarks,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE board_exam_registrations SET
         academic_year=$1, board_name=$2, exam_level=$3, exam_group=$4,
         exam_year=$5, registration_no=$6, board_roll_no=$7,
         centre_no=$8, centre_name=$9, registration_date=$10,
         fee_paid=$11, fee_amount=$12, status=$13,
         total_marks=$14, obtained_marks=$15, grade=$16,
         remarks=$17, updated_at=NOW()
       WHERE id=$18 RETURNING *`,
      [
        academic_year || null, board_name, exam_level, exam_group || null,
        exam_year, registration_no || null, board_roll_no || null,
        centre_no || null, centre_name || null, registration_date || null,
        fee_paid ?? false, fee_amount || null, status || 'registered',
        total_marks || null, obtained_marks || null, grade || null,
        remarks || null, req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Registration not found' });
    res.json({ success: true, data: rows[0], message: 'Registration updated' });
  } catch (err) { serverErr(res, err); }
};

// ── DELETE /api/board-exams/:id ───────────────────────────────
const deleteRegistration = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM board_exam_registrations WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Registration not found' });
    res.json({ success: true, message: 'Registration deleted' });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/board-exams/stats ────────────────────────────────
const getStats = async (req, res) => {
  try {
    const { exam_year } = req.query;
    const p = exam_year ? [exam_year] : [];
    const yearFilter = exam_year ? 'WHERE exam_year = $1' : '';

    const [totals, byLevel, byStatus, byBoard] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='passed')::int AS passed,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed,
        COUNT(*) FILTER (WHERE status='registered')::int AS registered,
        COUNT(*) FILTER (WHERE status='appeared')::int AS appeared,
        COUNT(*) FILTER (WHERE status='result_awaited')::int AS result_awaited,
        COUNT(*) FILTER (WHERE fee_paid=TRUE)::int AS fee_paid_count
        FROM board_exam_registrations ${yearFilter}`, p),
      pool.query(`SELECT exam_level, COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE status='passed')::int AS passed,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed
        FROM board_exam_registrations ${yearFilter}
        GROUP BY exam_level ORDER BY exam_level`, p),
      pool.query(`SELECT status, COUNT(*)::int AS count
        FROM board_exam_registrations ${yearFilter}
        GROUP BY status ORDER BY count DESC`, p),
      pool.query(`SELECT board_name, COUNT(*)::int AS count
        FROM board_exam_registrations ${yearFilter}
        GROUP BY board_name ORDER BY count DESC`, p),
    ]);

    res.json({
      success: true,
      data: {
        totals:   totals.rows[0],
        byLevel:  byLevel.rows,
        byStatus: byStatus.rows,
        byBoard:  byBoard.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getRegistrations, getRegistration,
  createRegistration, updateRegistration, deleteRegistration,
  getStats,
};
