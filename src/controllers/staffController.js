const pool = require('../db');
const { serverErr } = require('../utils/serverErr');

/* ─── GET /api/staff ─────────────────────────────────────────────────── */
const getStaff = async (req, res) => {
  try {
    const { status, department } = req.query;
    let q = `SELECT * FROM staff WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND status = $${params.length}`; }
    if (department) { params.push(department); q += ` AND department = $${params.length}`; }
    q += ' ORDER BY full_name';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { serverErr(res, err); }
};

/* ─── GET /api/staff/:id ─────────────────────────────────────────────── */
const getStaffById = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Staff member not found.' });
    res.json(rows[0]);
  } catch (err) { serverErr(res, err); }
};

/* ─── POST /api/staff ────────────────────────────────────────────────── */
const createStaff = async (req, res) => {
  try {
    const { full_name, designation, department, phone, email, cnic, base_salary, join_date, status, photo_url, notes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO staff (full_name,designation,department,phone,email,cnic,base_salary,join_date,status,photo_url,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [full_name, designation, department, phone, email, cnic, base_salary ?? 0, join_date, status ?? 'active', photo_url, notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) { serverErr(res, err); }
};

/* ─── PUT /api/staff/:id ─────────────────────────────────────────────── */
const updateStaff = async (req, res) => {
  try {
    const { full_name, designation, department, phone, email, cnic, base_salary, join_date, status, photo_url, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE staff SET
        full_name=$1, designation=$2, department=$3, phone=$4, email=$5, cnic=$6,
        base_salary=$7, join_date=$8, status=$9, photo_url=$10, notes=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [full_name, designation, department, phone, email, cnic, base_salary, join_date, status, photo_url, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Staff member not found.' });
    res.json(rows[0]);
  } catch (err) { serverErr(res, err); }
};

/* ─── DELETE /api/staff/:id ──────────────────────────────────────────── */
const deleteStaff = async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ message: 'Staff member not found.' });
    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

/* ─── GET /api/staff/:id/attendance ──────────────────────────────────── */
const getAttendance = async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = `SELECT * FROM staff_attendance WHERE staff_id=$1`;
    const params = [req.params.id];
    if (month && year) {
      params.push(year, month);
      q += ` AND EXTRACT(YEAR FROM date)=$${params.length - 1} AND EXTRACT(MONTH FROM date)=$${params.length}`;
    }
    q += ' ORDER BY date';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { serverErr(res, err); }
};

/* ─── POST /api/staff/attendance/bulk ───────────────────────────────── */
// Body: { date: 'YYYY-MM-DD', records: [{ staff_id, status, note }] }
const bulkAttendance = async (req, res) => {
  const { date, records } = req.body;
  if (!date || !Array.isArray(records) || !records.length) {
    return res.status(400).json({ message: 'date and records[] required.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      await client.query(
        `INSERT INTO staff_attendance (staff_id, date, status, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (staff_id, date) DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note`,
        [r.staff_id, date, r.status ?? 'present', r.note ?? null]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: records.length });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

/* ─── GET /api/staff/salary ─────────────────────────────────────────── */
const getSalaryPayments = async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = `
      SELECT ssp.*, s.full_name, s.designation, s.department
      FROM staff_salary_payments ssp
      JOIN staff s ON s.id = ssp.staff_id WHERE 1=1`;
    const params = [];
    if (month) { params.push(month); q += ` AND ssp.month=$${params.length}`; }
    if (year)  { params.push(year);  q += ` AND ssp.year=$${params.length}`; }
    q += ' ORDER BY s.full_name';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { serverErr(res, err); }
};

/* ─── POST /api/staff/salary/generate ───────────────────────────────── */
// Generates salary records for all active staff for a given month/year
const generateSalaries = async (req, res) => {
  const { month, year } = req.body;
  if (!month || !year) return res.status(400).json({ message: 'month and year required.' });

  try {
    // Get all active staff
    const { rows: staffList } = await pool.query(`SELECT id, base_salary FROM staff WHERE status='active'`);
    if (!staffList.length) return res.json({ success: true, count: 0 });

    // Count absent & late per staff for the month
    const { rows: attRows } = await pool.query(
      `SELECT staff_id,
              COUNT(*) FILTER (WHERE status='absent')  AS absent_days,
              COUNT(*) FILTER (WHERE status='late')    AS late_days
       FROM staff_attendance
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2
       GROUP BY staff_id`,
      [month, year]
    );
    const attMap = Object.fromEntries(attRows.map(r => [r.staff_id, r]));

    // Policy (reuse teacher salary policy)
    const { rows: pol } = await pool.query(`SELECT * FROM salary_policies WHERE id=1`);
    const policy = pol[0] ?? { allowed_leaves_per_month: 2, late_arrivals_per_leave: 3, working_days_basis: 26 };

    let count = 0;
    for (const s of staffList) {
      const att = attMap[s.id] ?? { absent_days: 0, late_days: 0 };
      const absent = parseInt(att.absent_days) || 0;
      const late   = parseInt(att.late_days) || 0;
      const perDay = parseFloat(s.base_salary) / policy.working_days_basis;
      const leaveDeduction = Math.max(0, absent - policy.allowed_leaves_per_month) * perDay;
      const lateDeduction  = Math.floor(late / policy.late_arrivals_per_leave) * perDay;
      const net = Math.max(0, parseFloat(s.base_salary) - leaveDeduction - lateDeduction);

      await pool.query(
        `INSERT INTO staff_salary_payments
           (staff_id,month,year,base_salary,absent_days,late_days,leave_deduction,late_deduction,net_salary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (staff_id,month,year) DO NOTHING`,
        [s.id, month, year, s.base_salary, absent, late,
         leaveDeduction.toFixed(2), lateDeduction.toFixed(2), net.toFixed(2)]
      );
      count++;
    }
    res.json({ success: true, count });
  } catch (err) { serverErr(res, err); }
};

/* ─── PUT /api/staff/salary/:id ──────────────────────────────────────── */
const updateSalaryPayment = async (req, res) => {
  try {
    const { bonus, other_deduction, status, paid_on, note } = req.body;
    const { rows: existing } = await pool.query(
      'SELECT * FROM staff_salary_payments WHERE id=$1', [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ message: 'Payment not found.' });
    const p = existing[0];
    const net = Math.max(0,
      parseFloat(p.base_salary)
      - parseFloat(p.leave_deduction)
      - parseFloat(p.late_deduction)
      - parseFloat(other_deduction ?? p.other_deduction)
      + parseFloat(bonus ?? p.bonus)
    );
    const { rows } = await pool.query(
      `UPDATE staff_salary_payments
       SET bonus=$1, other_deduction=$2, net_salary=$3, status=$4, paid_on=$5, note=$6
       WHERE id=$7 RETURNING *`,
      [bonus ?? p.bonus, other_deduction ?? p.other_deduction, net.toFixed(2),
       status ?? p.status, paid_on ?? p.paid_on, note ?? p.note, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { serverErr(res, err); }
};

/* ─── GET /api/staff/departments ─────────────────────────────────────── */
const getDepartments = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT department FROM staff WHERE department IS NOT NULL ORDER BY department`
    );
    res.json(rows.map(r => r.department));
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getStaff, getStaffById, createStaff, updateStaff, deleteStaff,
  getAttendance, bulkAttendance,
  getSalaryPayments, generateSalaries, updateSalaryPayment,
  getDepartments,
};
