const pool = require('../db');
const { buildWorkbook, sendWorkbook } = require('../utils/excelExport');
const { serverErr }      = require('../utils/serverErr');
const { fireWebhooks }   = require('../utils/webhookDispatcher');

// ── FBR 2024-25 salaried income tax (progressive slabs) ──────────────────────
// Source: Finance Act 2024, Schedule 1, Part I (Division I – Salary)
function calculateFbrTax(annualSalary) {
  const s = parseFloat(annualSalary) || 0;
  if (s <= 600_000)   return 0;
  if (s <= 1_200_000) return (s - 600_000) * 0.05;
  if (s <= 2_400_000) return 30_000  + (s - 1_200_000) * 0.15;
  if (s <= 3_600_000) return 210_000 + (s - 2_400_000) * 0.25;
  if (s <= 6_000_000) return 510_000 + (s - 3_600_000) * 0.30;
  return                     1_230_000 + (s - 6_000_000) * 0.35;
}


// ── Salary Structures ────────────────────────────────────────

const getSalaryStructures = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ss.*, t.full_name AS teacher_name, t.subject, t.qualification, t.status AS teacher_status
      FROM salary_structures ss
      JOIN teachers t ON t.id = ss.teacher_id
      ORDER BY t.full_name
    `);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const getTeacherSalaryStructure = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ss.*, t.full_name AS teacher_name, t.subject, t.qualification
       FROM salary_structures ss JOIN teachers t ON t.id = ss.teacher_id
       WHERE ss.teacher_id = $1`, [req.params.teacherId]
    );
    res.json({ success: true, data: rows[0] || null });
  } catch (err) { serverErr(res, err); }
};

const upsertSalaryStructure = async (req, res) => {
  try {
    const { teacher_id, base_salary, house_allowance, medical_allowance,
            transport_allowance, other_allowance, income_tax, other_deduction,
            effective_from, notes } = req.body;
    if (!teacher_id) return res.status(400).json({ success: false, message: 'teacher_id required' });

    const { rows } = await pool.query(`
      INSERT INTO salary_structures
        (teacher_id, base_salary, house_allowance, medical_allowance,
         transport_allowance, other_allowance, income_tax, other_deduction, effective_from, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (teacher_id) DO UPDATE SET
        base_salary         = EXCLUDED.base_salary,
        house_allowance     = EXCLUDED.house_allowance,
        medical_allowance   = EXCLUDED.medical_allowance,
        transport_allowance = EXCLUDED.transport_allowance,
        other_allowance     = EXCLUDED.other_allowance,
        income_tax          = EXCLUDED.income_tax,
        other_deduction     = EXCLUDED.other_deduction,
        effective_from      = EXCLUDED.effective_from,
        notes               = EXCLUDED.notes,
        updated_at          = NOW()
      RETURNING *
    `, [teacher_id, base_salary||0, house_allowance||0, medical_allowance||0,
        transport_allowance||0, other_allowance||0, income_tax||0, other_deduction||0,
        effective_from || new Date().toISOString().slice(0,10), notes||null]);
    res.json({ success: true, data: rows[0], message: 'Salary structure saved' });
  } catch (err) { serverErr(res, err); }
};

// ── Salary Payments ──────────────────────────────────────────

const getSalaryPayments = async (req, res) => {
  try {
    const { month, status, teacher_id } = req.query;
    let q = `
      SELECT sp.*, t.full_name AS teacher_name, t.subject, t.qualification, t.phone
      FROM salary_payments sp JOIN teachers t ON t.id = sp.teacher_id WHERE 1=1
    `;
    const p = [];
    if (month)      { p.push(month);      q += ` AND sp.month=$${p.length}`; }
    if (status)     { p.push(status);     q += ` AND sp.status=$${p.length}`; }
    if (teacher_id) { p.push(teacher_id); q += ` AND sp.teacher_id=$${p.length}`; }
    q += ' ORDER BY sp.month DESC, t.full_name';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// Generate salary slips for all active teachers for a given month
// Deductions: leave_deduction (excess absences) + late_deduction (late arrivals converted to leaves)
const generateMonthlySalaries = async (req, res) => {
  const { month } = req.body;
  if (!month) return res.status(400).json({ success: false, message: 'month required (YYYY-MM)' });
  try {
    // Load school-wide payroll policy (seed row id=1 always exists after migration 054)
    const { rows: policyRows } = await pool.query('SELECT * FROM salary_policies WHERE id = 1');
    const policy = policyRows[0] || { allowed_leaves_per_month: 2, late_arrivals_per_leave: 3, working_days_basis: 26 };
    const allowedFree   = parseInt(policy.allowed_leaves_per_month);
    const latesPerLeave = parseInt(policy.late_arrivals_per_leave);
    const workingDays   = parseInt(policy.working_days_basis);

    // Get all active teachers + their salary structures
    const { rows: teachers } = await pool.query(`
      SELECT t.id, t.full_name, ss.*
      FROM teachers t
      LEFT JOIN salary_structures ss ON ss.teacher_id = t.id
      WHERE t.status = 'active'
    `);

    // Single query: count absent + late days per teacher this month
    const startDate = `${month}-01`;
    const endDate   = new Date(new Date(startDate).getFullYear(), new Date(startDate).getMonth() + 1, 0)
      .toISOString().slice(0, 10);

    const { rows: attRows } = await pool.query(
      `SELECT entity_id AS teacher_id,
              COUNT(*) FILTER (WHERE status = 'absent')::int AS absent_days,
              COUNT(*) FILTER (WHERE status = 'late')::int   AS late_days
       FROM attendance
       WHERE entity_type = 'teacher'
         AND date BETWEEN $1 AND $2
         AND period_id IS NULL
       GROUP BY entity_id`,
      [startDate, endDate]
    );
    const attMap = {};
    attRows.forEach(r => { attMap[r.teacher_id] = { absent_days: r.absent_days, late_days: r.late_days }; });

    // Load approved advances with remaining balance for deduction this month
    const { rows: advRows } = await pool.query(
      `SELECT teacher_id, SUM(monthly_deduction) AS advance_deduction
       FROM salary_advances
       WHERE status = 'approved' AND monthly_deduction > 0
         AND total_repaid < amount
       GROUP BY teacher_id`
    );
    const advMap = {};
    advRows.forEach(r => { advMap[r.teacher_id] = parseFloat(r.advance_deduction); });

    // Build arrays for batch UNNEST insert (1 round-trip instead of N)
    const cols = {
      teacherIds: [], months: [],
      baseSalaries: [], houseAllowances: [], medAllowances: [],
      transportAllowances: [], otherAllowances: [], grossSalaries: [],
      incomeTaxes: [], otherDeductions: [], absentDaysArr: [], lateDaysArr: [],
      attDeductions: [], lateDedArr: [], totalDeductions: [], netSalaries: [],
    };

    for (const t of teachers) {
      const base  = parseFloat(t.base_salary        || 0);
      const house = parseFloat(t.house_allowance     || 0);
      const med   = parseFloat(t.medical_allowance   || 0);
      const trns  = parseFloat(t.transport_allowance || 0);
      const other = parseFloat(t.other_allowance     || 0);
      const gross = base + house + med + trns + other;
      // If income_tax is 0 (not set), auto-calculate from FBR 2024-25 slabs
      const storedTax = parseFloat(t.income_tax || 0);
      const tax   = storedTax > 0 ? storedTax : parseFloat((calculateFbrTax(gross * 12) / 12).toFixed(2));
      const otDed   = parseFloat(t.other_deduction || 0);
      const advDedM = parseFloat(advMap[t.id]     || 0); // salary advance monthly instalment

      const att        = attMap[t.id] || { absent_days: 0, late_days: 0 };
      const absentDays = att.absent_days;
      const lateDays   = att.late_days;
      const perDayRate = base > 0 ? base / workingDays : 0;

      // Leave deduction: only excess absences beyond allowed free days
      const leaveDed = Math.max(0, absentDays - allowedFree) * perDayRate;
      // Late deduction: every N late arrivals = 1 day deduction
      const lateDed  = latesPerLeave > 0 ? Math.floor(lateDays / latesPerLeave) * perDayRate : 0;
      const attDed   = parseFloat((leaveDed + lateDed).toFixed(2));
      const lateDedR = parseFloat(lateDed.toFixed(2));

      const totalDed = parseFloat((tax + otDed + attDed + advDedM).toFixed(2));
      const net      = parseFloat((gross - totalDed).toFixed(2));

      cols.teacherIds.push(t.id);
      cols.months.push(month);           // store as YYYY-MM to match VARCHAR(7) column
      cols.baseSalaries.push(base);
      cols.houseAllowances.push(house);
      cols.medAllowances.push(med);
      cols.transportAllowances.push(trns);
      cols.otherAllowances.push(other);
      cols.grossSalaries.push(gross);
      cols.incomeTaxes.push(tax);
      cols.otherDeductions.push(otDed);
      cols.absentDaysArr.push(absentDays);
      cols.lateDaysArr.push(lateDays);
      cols.attDeductions.push(attDed);
      cols.lateDedArr.push(lateDedR);
      cols.totalDeductions.push(totalDed);
      cols.netSalaries.push(net);
    }

    let generated = 0;
    if (cols.teacherIds.length > 0) {
      const { rowCount } = await pool.query(`
        INSERT INTO salary_payments
          (teacher_id, month, base_salary, house_allowance, medical_allowance,
           transport_allowance, other_allowance, gross_salary,
           income_tax, other_deduction, absent_days, late_days,
           attendance_deduction, late_deduction,
           total_deductions, net_salary)
        SELECT * FROM UNNEST(
          $1::int[], $2::varchar[], $3::numeric[], $4::numeric[], $5::numeric[],
          $6::numeric[], $7::numeric[], $8::numeric[],
          $9::numeric[], $10::numeric[], $11::int[], $12::int[],
          $13::numeric[], $14::numeric[],
          $15::numeric[], $16::numeric[]
        ) AS t(teacher_id, month, base_salary, house_allowance, medical_allowance,
               transport_allowance, other_allowance, gross_salary,
               income_tax, other_deduction, absent_days, late_days,
               attendance_deduction, late_deduction,
               total_deductions, net_salary)
        ON CONFLICT (teacher_id, month) DO NOTHING
      `, [
        cols.teacherIds, cols.months,
        cols.baseSalaries, cols.houseAllowances, cols.medAllowances,
        cols.transportAllowances, cols.otherAllowances, cols.grossSalaries,
        cols.incomeTaxes, cols.otherDeductions, cols.absentDaysArr, cols.lateDaysArr,
        cols.attDeductions, cols.lateDedArr,
        cols.totalDeductions, cols.netSalaries,
      ]);
      generated = rowCount;
    }

    if (generated > 0) {
      fireWebhooks('salary.generated', {
        month,
        teachers_count: generated,
        generated_at:   new Date().toISOString(),
      }).catch(() => {});
    }

    res.json({ success: true, generated, message: `Salary slips generated for ${generated} teacher(s) — ${month}` });
  } catch (err) { serverErr(res, err); }
};

const updateSalaryPayment = async (req, res) => {
  try {
    const { advance_deduction, fine_deduction, other_deduction, payment_method,
            payment_date, status, remarks } = req.body;
    const { rows } = await pool.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Payment not found' });
    const p = rows[0];

    const advDed   = parseFloat(advance_deduction ?? p.advance_deduction);
    const fineDed  = parseFloat(fine_deduction    ?? p.fine_deduction);
    const otDed    = parseFloat(other_deduction   ?? p.other_deduction);
    const taxDed   = parseFloat(p.income_tax);
    const attDed   = parseFloat(p.attendance_deduction || 0);
    const lateDed  = parseFloat(p.late_deduction       || 0);
    const totalDed = parseFloat((taxDed + advDed + fineDed + otDed + attDed + lateDed).toFixed(2));
    const net      = parseFloat(p.gross_salary) - totalDed;

    const { rows: updated } = await pool.query(`
      UPDATE salary_payments SET
        advance_deduction=$1, fine_deduction=$2, other_deduction=$3,
        total_deductions=$4, net_salary=$5,
        payment_method=$6, payment_date=$7, status=$8, remarks=$9, updated_at=NOW()
      WHERE id=$10 RETURNING *
    `, [advDed, fineDed, otDed, totalDed, net,
        payment_method || p.payment_method,
        payment_date   || p.payment_date,
        status         || p.status,
        remarks        ?? p.remarks,
        req.params.id]);
    res.json({ success: true, data: updated[0], message: 'Payment updated' });
  } catch (err) { serverErr(res, err); }
};

const markSalaryPaid = async (req, res) => {
  try {
    const { payment_date, payment_method, remarks } = req.body;
    const { rows } = await pool.query(`
      UPDATE salary_payments SET status='paid', payment_date=$1, payment_method=$2, remarks=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [payment_date || new Date().toISOString().slice(0,10), payment_method || 'cash', remarks||null, req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Payment not found' });

    fireWebhooks('salary.paid', {
      salary_payment_id: rows[0].id,
      teacher_id:        rows[0].teacher_id,
      month:             rows[0].month,
      gross_salary:      rows[0].gross_salary,
      net_salary:        rows[0].net_salary,
      payment_method:    rows[0].payment_method,
      payment_date:      rows[0].payment_date,
    }).catch(() => {});

    res.json({ success: true, data: rows[0], message: 'Salary marked as paid' });
  } catch (err) { serverErr(res, err); }
};

const getSalarySlip = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sp.*, t.full_name AS teacher_name, t.subject, t.qualification,
             t.phone, t.email, t.join_date
      FROM salary_payments sp JOIN teachers t ON t.id = sp.teacher_id
      WHERE sp.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Salary slip not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// POST /api/salary/payments/bulk-mark-paid
const bulkMarkSalaryPaid = async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids, payment_date, payment_method } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ success: false, message: 'ids array required' });

    const date   = payment_date   || new Date().toISOString().slice(0, 10);
    const method = payment_method || 'cash';

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE salary_payments
       SET status='paid', payment_date=$1, payment_method=$2, updated_at=NOW()
       WHERE id = ANY($3::int[]) AND status='pending'
       RETURNING id`,
      [date, method, ids]
    );
    await client.query('COMMIT');
    res.json({ success: true, updated: rows.length, message: `${rows.length} salary payment(s) marked as paid` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// ── GET /api/salary/export?month=YYYY-MM&format=xlsx ─────────────
const exportSalary = async (req, res, next) => {
  try {
    const { month, format = 'csv' } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (month) { params.push(month); where += ` AND sp.month = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT t.full_name, t.subject, sp.month,
              sp.base_salary,
              (sp.house_allowance + sp.medical_allowance + sp.transport_allowance + sp.other_allowance) AS allowances,
              sp.absent_days, sp.late_days,
              sp.attendance_deduction, sp.late_deduction,
              sp.total_deductions, sp.net_salary, sp.status,
              sp.payment_date, sp.remarks
       FROM salary_payments sp
       JOIN teachers t ON t.id = sp.teacher_id
       ${where} ORDER BY sp.month DESC, t.full_name`,
      params
    );

    if (format === 'xlsx') {
      const wb = await buildWorkbook({
        title:     `Salary Sheet — ${month || 'All Months'}`,
        sheetName: 'Salary',
        subtitle:  `Total: ${rows.length} records | Net Payable: PKR ${rows.reduce((s,r) => s + Number(r.net_salary || 0), 0).toLocaleString()}`,
        columns: [
          { key: 'full_name',            header: 'Teacher Name',        width: 22 },
          { key: 'subject',              header: 'Subject',             width: 16 },
          { key: 'month',                header: 'Month',               width: 12 },
          { key: 'base_salary',          header: 'Base Salary',         width: 14, numFmt: '#,##0.00' },
          { key: 'allowances',           header: 'Allowances',          width: 13, numFmt: '#,##0.00' },
          { key: 'absent_days',          header: 'Absent Days',         width: 12 },
          { key: 'late_days',            header: 'Late Days',           width: 11 },
          { key: 'attendance_deduction', header: 'Leave Deduction',     width: 16, numFmt: '#,##0.00' },
          { key: 'late_deduction',       header: 'Late Deduction',      width: 15, numFmt: '#,##0.00' },
          { key: 'total_deductions',     header: 'Total Deductions',    width: 16, numFmt: '#,##0.00' },
          { key: 'net_salary',           header: 'Net Salary',          width: 14, numFmt: '#,##0.00' },
          { key: 'status',               header: 'Status',              width: 10 },
          { key: 'payment_date',         header: 'Payment Date',        width: 14 },
          { key: 'remarks',              header: 'Remarks',             width: 20 },
        ],
        rows,
      });
      return sendWorkbook(res, wb, `salary_${month || 'all'}_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hdr = ['Teacher','Subject','Month','Base Salary','Allowances','Absent Days','Late Days',
                 'Leave Deduction','Late Deduction','Total Deductions','Net Salary','Status','Payment Date'];
    const csv = [hdr, ...rows.map(r => [
      r.full_name, r.subject, r.month, r.base_salary,
      r.allowances, r.absent_days, r.late_days,
      r.attendance_deduction, r.late_deduction,
      r.total_deductions, r.net_salary, r.status,
      r.payment_date?.toString().slice(0,10),
    ].map(q))].map(row => row.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="salary_${month || 'all'}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

const getMySlips = async (req, res) => {
  try {
    const teacherId = req.user.entity_id;
    const { rows } = await pool.query(
      `SELECT sp.*, t.full_name AS teacher_name
       FROM salary_payments sp
       JOIN teachers t ON t.id = sp.teacher_id
       WHERE sp.teacher_id = $1
       ORDER BY sp.month DESC
       LIMIT 12`,
      [teacherId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    return serverErr(res, err);
  }
};

// ── Salary Policy ─────────────────────────────────────────────

const getSalaryPolicy = async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM salary_policies WHERE id = 1');
    res.json({ success: true, data: rows[0] || null });
  } catch (err) { serverErr(res, err); }
};

const updateSalaryPolicy = async (req, res) => {
  try {
    const { allowed_leaves_per_month, late_arrivals_per_leave, working_days_basis } = req.body;
    const { rows } = await pool.query(`
      UPDATE salary_policies SET
        allowed_leaves_per_month = COALESCE($1, allowed_leaves_per_month),
        late_arrivals_per_leave  = COALESCE($2, late_arrivals_per_leave),
        working_days_basis       = COALESCE($3, working_days_basis),
        updated_at               = NOW()
      WHERE id = 1 RETURNING *
    `, [allowed_leaves_per_month ?? null, late_arrivals_per_leave ?? null, working_days_basis ?? null]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Policy not found — run migration 054' });
    res.json({ success: true, data: rows[0], message: 'Salary policy updated' });
  } catch (err) { serverErr(res, err); }
};

// ── Salary Advance endpoints ──────────────────────────────────────────────────

// GET /api/salary/advances
const listAdvances = async (req, res) => {
  try {
    const { teacher_id, status } = req.query;
    const p = []; let q = `
      SELECT sa.*, t.full_name AS teacher_name
      FROM salary_advances sa JOIN teachers t ON t.id = sa.teacher_id WHERE 1=1`;
    if (teacher_id) { p.push(teacher_id); q += ` AND sa.teacher_id=$${p.length}`; }
    if (status)     { p.push(status);     q += ` AND sa.status=$${p.length}`; }
    q += ' ORDER BY sa.requested_at DESC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /api/salary/advances — teacher or admin requests an advance
const requestAdvance = async (req, res) => {
  try {
    const { teacher_id, amount, reason, monthly_deduction } = req.body;
    if (!teacher_id || !amount || !monthly_deduction) {
      return res.status(400).json({ success: false, message: 'teacher_id, amount, monthly_deduction required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO salary_advances (teacher_id, amount, reason, monthly_deduction)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [teacher_id, amount, reason || null, monthly_deduction]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// PATCH /api/salary/advances/:id/approve
const approveAdvance = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE salary_advances
       SET status='approved', approved_by=$1, approved_at=NOW(), notes=$2
       WHERE id=$3 AND status='pending' RETURNING *`,
      [req.user.id, req.body.notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Pending advance not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// PATCH /api/salary/advances/:id/reject
const rejectAdvance = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE salary_advances
       SET status='rejected', approved_by=$1, approved_at=NOW(), notes=$2
       WHERE id=$3 AND status='pending' RETURNING *`,
      [req.user.id, req.body.notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Pending advance not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/salary/tax-preview?monthly_gross=X ───────────────────────────────
// Returns FBR 2024-25 tax breakdown for a given monthly gross salary.
const getTaxPreview = (req, res) => {
  const monthly = parseFloat(req.query.monthly_gross);
  if (!monthly || monthly < 0) {
    return res.status(400).json({ success: false, message: 'monthly_gross is required and must be positive' });
  }
  const annual     = monthly * 12;
  const annualTax  = calculateFbrTax(annual);
  const monthlyTax = parseFloat((annualTax / 12).toFixed(2));
  const net        = parseFloat((monthly - monthlyTax).toFixed(2));

  // Build slab breakdown
  const slabs = [
    { range: '0 – 600,000',         rate: '0%',   tax: Math.min(Math.max(0, annualTax - 0), 0) },
    { range: '600,001 – 1,200,000', rate: '5%',   tax: annual > 600_000   ? Math.min((annual - 600_000) * 0.05,   30_000)  : 0 },
    { range: '1,200,001 – 2,400,000', rate: '15%', tax: annual > 1_200_000 ? Math.min((annual - 1_200_000) * 0.15, 180_000) : 0 },
    { range: '2,400,001 – 3,600,000', rate: '25%', tax: annual > 2_400_000 ? Math.min((annual - 2_400_000) * 0.25, 300_000) : 0 },
    { range: '3,600,001 – 6,000,000', rate: '30%', tax: annual > 3_600_000 ? Math.min((annual - 3_600_000) * 0.30, 720_000) : 0 },
    { range: 'Above 6,000,000',       rate: '35%', tax: annual > 6_000_000 ? (annual - 6_000_000) * 0.35 : 0 },
  ].filter(s => s.tax > 0);

  res.json({
    success: true,
    data: {
      monthly_gross:       monthly,
      annual_gross:        annual,
      annual_tax_fbr:      annualTax,
      monthly_tax_fbr:     monthlyTax,
      monthly_net:         net,
      effective_rate_pct:  annual > 0 ? parseFloat(((annualTax / annual) * 100).toFixed(2)) : 0,
      slab_breakdown:      slabs,
      note:                'FBR Finance Act 2024-25 — Salaried persons tax slabs',
    },
  });
};

module.exports = {
  getSalaryStructures, getTeacherSalaryStructure, upsertSalaryStructure,
  getSalaryPayments, generateMonthlySalaries, updateSalaryPayment, markSalaryPaid, getSalarySlip,
  bulkMarkSalaryPaid, exportSalary, getMySlips,
  getSalaryPolicy, updateSalaryPolicy,
  getTaxPreview,
  listAdvances, requestAdvance, approveAdvance, rejectAdvance,
};
