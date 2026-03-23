const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[SCHOLARSHIP]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// GET /scholarships?status&academic_year&student_id
const getApplications = async (req, res) => {
  try {
    const { status, academic_year, student_id } = req.query;
    let q = `
      SELECT sa.*, s.full_name, s.admission_number, c.name AS class_name,
             fh.head_name AS fee_head_name
      FROM scholarship_applications sa
      JOIN students s ON s.id = sa.student_id
      LEFT JOIN classes c ON c.id = s.class_id
      LEFT JOIN fee_heads fh ON fh.id = sa.fee_head_id
      WHERE 1=1
    `;
    const p = [];
    if (status)        { p.push(status);        q += ` AND sa.status=$${p.length}`; }
    if (academic_year) { p.push(academic_year);  q += ` AND sa.academic_year=$${p.length}`; }
    if (student_id)    { p.push(student_id);     q += ` AND sa.student_id=$${p.length}`; }
    q += ' ORDER BY sa.applied_at DESC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /scholarships
const createApplication = async (req, res) => {
  try {
    const { student_id, fee_head_id, discount_type, discount_value, reason, academic_year } = req.body;

    if (!student_id || !discount_type || !discount_value || !reason) {
      return res.status(400).json({
        success: false,
        message: 'student_id, discount_type, discount_value and reason are required',
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO scholarship_applications
         (student_id, fee_head_id, discount_type, discount_value, reason, academic_year)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [student_id, fee_head_id || null, discount_type, discount_value, reason,
       academic_year || '2024-25'],
    );

    res.status(201).json({ success: true, data: rows[0], message: 'Application submitted' });
  } catch (err) { serverErr(res, err); }
};

// PUT /scholarships/:id/review
// Body: {status, admin_note}
// If approved: create student_concession + link back
const reviewApplication = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, admin_note } = req.body;
    const reviewedBy = req.user?.username || 'Admin';

    if (!status) return res.status(400).json({ success: false, message: 'status is required' });

    await client.query('BEGIN');

    const { rows: appRows } = await client.query(
      'SELECT * FROM scholarship_applications WHERE id=$1 FOR UPDATE', [id],
    );
    if (!appRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    const app = appRows[0];

    let concessionId = app.concession_id;

    if (status === 'approved') {
      // Insert into student_concessions
      const { rows: concRows } = await client.query(
        `INSERT INTO student_concessions (student_id, fee_head_id, discount_type, discount_value, reason, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
        [app.student_id, app.fee_head_id, app.discount_type, app.discount_value, app.reason],
      );
      concessionId = concRows[0].id;
    }

    const { rows: updated } = await client.query(
      `UPDATE scholarship_applications SET
         status       = $1,
         admin_note   = $2,
         reviewed_by  = $3,
         reviewed_at  = NOW(),
         concession_id= $4,
         updated_at   = NOW()
       WHERE id=$5 RETURNING *`,
      [status, admin_note || null, reviewedBy, concessionId, id],
    );

    await client.query('COMMIT');
    res.json({ success: true, data: updated[0], message: `Application ${status}` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// DELETE /scholarships/:id  (only if pending)
const deleteApplication = async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      'SELECT status FROM scholarship_applications WHERE id=$1', [req.params.id],
    );
    if (!check[0]) return res.status(404).json({ success: false, message: 'Application not found' });
    if (check[0].status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Only pending applications can be deleted' });
    }
    await pool.query('DELETE FROM scholarship_applications WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Application deleted' });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getApplications, createApplication, reviewApplication, deleteApplication };
