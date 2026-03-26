const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// GET /alumni?graduation_year&search
const getAlumni = async (req, res) => {
  try {
    const { graduation_year, search } = req.query;
    let q = `
      SELECT a.*, s.full_name, s.admission_number, s.photo_url
      FROM alumni a
      JOIN students s ON s.id = a.student_id
      WHERE 1=1
    `;
    const p = [];
    if (graduation_year) { p.push(graduation_year); q += ` AND a.graduation_year=$${p.length}`; }
    if (search) {
      p.push(`%${search}%`);
      q += ` AND (s.full_name ILIKE $${p.length} OR s.admission_number ILIKE $${p.length} OR a.batch_label ILIKE $${p.length})`;
    }
    q += ' ORDER BY a.graduation_year DESC, s.full_name';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /alumni
// Body: {student_id, graduation_year, batch_label, university, program, university_year,
//        current_city, current_country, contact_email, contact_phone, notes}
// Transaction: UPDATE students status='graduated', INSERT alumni ON CONFLICT DO UPDATE
const graduateStudent = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      student_id, graduation_year, batch_label, final_class,
      university, program, university_year,
      current_city, current_country, contact_email, contact_phone, notes,
    } = req.body;

    if (!student_id || !graduation_year || !batch_label) {
      return res.status(400).json({
        success: false,
        message: 'student_id, graduation_year and batch_label are required',
      });
    }

    await client.query('BEGIN');

    // 1) Update student status
    await client.query(
      `UPDATE students SET status='graduated', graduation_year=$1 WHERE id=$2`,
      [graduation_year, student_id],
    );

    // 2) Upsert alumni record
    const { rows } = await client.query(
      `INSERT INTO alumni
         (student_id, graduation_year, batch_label, final_class, university, program,
          university_year, current_city, current_country, contact_email, contact_phone, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (student_id) DO UPDATE SET
         graduation_year = EXCLUDED.graduation_year,
         batch_label     = EXCLUDED.batch_label,
         final_class     = EXCLUDED.final_class,
         university      = EXCLUDED.university,
         program         = EXCLUDED.program,
         university_year = EXCLUDED.university_year,
         current_city    = EXCLUDED.current_city,
         current_country = EXCLUDED.current_country,
         contact_email   = EXCLUDED.contact_email,
         contact_phone   = EXCLUDED.contact_phone,
         notes           = EXCLUDED.notes,
         updated_at      = NOW()
       RETURNING *`,
      [student_id, graduation_year, batch_label, final_class || null,
       university || null, program || null, university_year || null,
       current_city || null, current_country || 'Pakistan',
       contact_email || null, contact_phone || null, notes || null],
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: rows[0], message: 'Student graduated and alumni record created' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// PUT /alumni/:id
const updateAlumni = async (req, res) => {
  try {
    const {
      graduation_year, batch_label, final_class, university, program,
      university_year, current_city, current_country, contact_email, contact_phone, notes,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE alumni SET
         graduation_year = COALESCE($1, graduation_year),
         batch_label     = COALESCE($2, batch_label),
         final_class     = COALESCE($3, final_class),
         university      = COALESCE($4, university),
         program         = COALESCE($5, program),
         university_year = COALESCE($6, university_year),
         current_city    = COALESCE($7, current_city),
         current_country = COALESCE($8, current_country),
         contact_email   = COALESCE($9, contact_email),
         contact_phone   = COALESCE($10, contact_phone),
         notes           = COALESCE($11, notes),
         updated_at      = NOW()
       WHERE id=$12 RETURNING *`,
      [graduation_year || null, batch_label || null, final_class || null,
       university || null, program || null, university_year || null,
       current_city || null, current_country || null,
       contact_email || null, contact_phone || null, notes || null,
       req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Alumni record not found' });
    res.json({ success: true, data: rows[0], message: 'Alumni updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /alumni/:id
const deleteAlumni = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM alumni WHERE id=$1 RETURNING *', [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Alumni record not found' });
    res.json({ success: true, message: 'Alumni record deleted', data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getAlumni, graduateStudent, updateAlumni, deleteAlumni };
