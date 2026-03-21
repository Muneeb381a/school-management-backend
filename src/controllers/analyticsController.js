const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[ANALYTICS]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// ══════════════════════════════════════════════════════════════
//  CLASS ANALYTICS  — GET /api/analytics/class/:id
//  Returns: attendanceByWeek, feeStats, topStudents,
//           bottomStudents, subjectDifficulty
// ══════════════════════════════════════════════════════════════
const getClassAnalytics = async (req, res) => {
  try {
    const classId = req.params.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    // ── Attendance: daily rates for this month ─────────────────
    const { rows: attRows } = await pool.query(`
      SELECT
        a.date,
        COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
        COUNT(*) FILTER (WHERE a.status IN ('absent','late')) AS absent_count,
        COUNT(*) AS total_count
      FROM attendance a
      JOIN students s ON s.id = a.entity_id AND a.entity_type = 'student'
      WHERE s.class_id = $1
        AND a.date BETWEEN $2 AND $3
        AND a.period_id IS NULL
        AND s.deleted_at IS NULL
      GROUP BY a.date
      ORDER BY a.date
    `, [classId, monthStart, monthEnd]);

    // Group into ISO weeks (Mon–Sun)
    const weekMap = {};
    for (const row of attRows) {
      const d = new Date(row.date);
      // ISO week number within the month: ceil(day/7)
      const weekNum = Math.ceil(d.getDate() / 7);
      const key = `W${weekNum}`;
      if (!weekMap[key]) weekMap[key] = { week: key, present: 0, absent: 0, total: 0 };
      weekMap[key].present += parseInt(row.present_count);
      weekMap[key].absent  += parseInt(row.absent_count);
      weekMap[key].total   += parseInt(row.total_count);
    }
    const attendanceByWeek = Object.values(weekMap).map(w => ({
      ...w,
      rate: w.total > 0 ? Math.round((w.present / w.total) * 100) : 0,
    }));

    // Overall attendance rate this month
    const totalPresent = attRows.reduce((s, r) => s + parseInt(r.present_count), 0);
    const totalAtt     = attRows.reduce((s, r) => s + parseInt(r.total_count), 0);
    const attendanceRate = totalAtt > 0 ? Math.round((totalPresent / totalAtt) * 100) : null;

    // ── Fee stats for students in this class ──────────────────
    const { rows: feeRows } = await pool.query(`
      SELECT
        COUNT(DISTINCT s.id) AS total_students,
        COUNT(DISTINCT fi.student_id) FILTER (WHERE fi.status = 'paid') AS paid_students,
        COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0) AS total_billed,
        COALESCE(SUM(fi.paid_amount), 0) AS total_paid,
        COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) FILTER (WHERE fi.status != 'paid' AND fi.status != 'cancelled'), 0) AS total_outstanding
      FROM students s
      LEFT JOIN fee_invoices fi ON fi.student_id = s.id AND fi.status != 'cancelled'
      WHERE s.class_id = $1 AND s.deleted_at IS NULL AND s.status = 'active'
    `, [classId]);

    const feeStats = {
      totalStudents:   parseInt(feeRows[0].total_students),
      paidStudents:    parseInt(feeRows[0].paid_students),
      totalBilled:     parseFloat(feeRows[0].total_billed),
      totalPaid:       parseFloat(feeRows[0].total_paid),
      totalOutstanding: parseFloat(feeRows[0].total_outstanding),
      collectionRate: parseFloat(feeRows[0].total_billed) > 0
        ? Math.round((parseFloat(feeRows[0].total_paid) / parseFloat(feeRows[0].total_billed)) * 100)
        : null,
    };

    // ── Top & Bottom students by avg exam percentage ──────────
    const { rows: rankRows } = await pool.query(`
      SELECT
        s.id,
        s.full_name,
        s.roll_number,
        s.admission_number,
        ROUND(AVG(rs.percentage)::numeric, 1) AS avg_pct,
        COUNT(rs.exam_id) AS exam_count
      FROM students s
      JOIN result_summary rs ON rs.student_id = s.id
      WHERE s.class_id = $1
        AND s.deleted_at IS NULL
        AND s.status = 'active'
        AND rs.percentage IS NOT NULL
      GROUP BY s.id, s.full_name, s.roll_number, s.admission_number
      HAVING COUNT(rs.exam_id) > 0
      ORDER BY avg_pct DESC
    `, [classId]);

    const topStudents    = rankRows.slice(0, 5);
    const bottomStudents = [...rankRows].reverse().slice(0, 5);

    // ── Subject difficulty: avg % and pass rate per subject ───
    const { rows: subjRows } = await pool.query(`
      SELECT
        sub.name AS subject_name,
        sub.code AS subject_code,
        ROUND(AVG(sm.obtained_marks::numeric / NULLIF(es.total_marks, 0) * 100), 1) AS avg_pct,
        ROUND(
          COUNT(*) FILTER (WHERE sm.obtained_marks >= es.passing_marks)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        ) AS pass_rate,
        COUNT(*) AS attempts
      FROM student_marks sm
      JOIN subjects sub ON sub.id = sm.subject_id
      JOIN exam_subjects es ON es.exam_id = sm.exam_id
        AND es.subject_id = sm.subject_id
        AND es.class_id = sm.class_id
      JOIN students s ON s.id = sm.student_id
      WHERE s.class_id = $1
        AND s.deleted_at IS NULL
        AND es.total_marks > 0
      GROUP BY sub.id, sub.name, sub.code
      HAVING COUNT(*) >= 3
      ORDER BY avg_pct ASC
    `, [classId]);

    res.json({
      success: true,
      data: {
        attendanceByWeek,
        attendanceRate,
        feeStats,
        topStudents,
        bottomStudents,
        subjectDifficulty: subjRows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  TEACHER METRICS  — GET /api/analytics/teacher/:id
//  Returns: attendanceMonthly, homeworkWeekly,
//           syllabusCompletion, studentMarksBySubject
// ══════════════════════════════════════════════════════════════
const getTeacherMetrics = async (req, res) => {
  try {
    const teacherId = req.params.id;

    // ── Monthly attendance for last 6 months ──────────────────
    const { rows: attRows } = await pool.query(`
      SELECT
        TO_CHAR(a.date, 'YYYY-MM') AS month,
        COUNT(*) FILTER (WHERE a.status = 'present') AS present_days,
        COUNT(*) FILTER (WHERE a.status = 'absent')  AS absent_days,
        COUNT(*) AS total_days
      FROM attendance a
      WHERE a.entity_type = 'teacher'
        AND a.entity_id = $1
        AND a.date >= NOW() - INTERVAL '6 months'
      GROUP BY TO_CHAR(a.date, 'YYYY-MM')
      ORDER BY month
    `, [teacherId]);

    // ── Homework created per week (last 8 weeks) ─────────────
    const { rows: hwRows } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('week', h.created_at), 'YYYY-MM-DD') AS week_start,
        COUNT(*) AS count
      FROM homework h
      WHERE h.teacher_id = $1
        AND h.created_at >= NOW() - INTERVAL '8 weeks'
      GROUP BY DATE_TRUNC('week', h.created_at)
      ORDER BY week_start
    `, [teacherId]);

    // ── Syllabus completion per subject they teach ────────────
    const { rows: syllRows } = await pool.query(`
      SELECT
        sub.name AS subject_name,
        sub.code AS subject_code,
        COUNT(*) AS total_topics,
        COUNT(*) FILTER (WHERE sy.is_completed = TRUE) AS completed_topics,
        ROUND(
          COUNT(*) FILTER (WHERE sy.is_completed = TRUE)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        ) AS completion_pct
      FROM syllabus sy
      JOIN subjects sub ON sub.id = sy.subject_id
      WHERE sy.teacher_id = $1
      GROUP BY sub.id, sub.name, sub.code
      ORDER BY completion_pct DESC
    `, [teacherId]);

    // ── Student marks in subjects taught by this teacher ─────
    const { rows: markRows } = await pool.query(`
      SELECT
        sub.name AS subject_name,
        sub.code AS subject_code,
        c.name   AS class_name,
        ROUND(AVG(sm.obtained_marks::numeric / NULLIF(es.total_marks, 0) * 100), 1) AS avg_pct,
        ROUND(
          COUNT(*) FILTER (WHERE sm.obtained_marks >= es.passing_marks)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        ) AS pass_rate,
        COUNT(DISTINCT sm.student_id) AS student_count
      FROM student_marks sm
      JOIN subjects sub ON sub.id = sm.subject_id
      JOIN exam_subjects es ON es.exam_id = sm.exam_id
        AND es.subject_id = sm.subject_id
        AND es.class_id = sm.class_id
      JOIN classes c ON c.id = sm.class_id
      JOIN teacher_subject_assignments tsa
        ON tsa.subject_id = sm.subject_id AND tsa.teacher_id = $1
      WHERE es.total_marks > 0
      GROUP BY sub.id, sub.name, sub.code, c.id, c.name
      ORDER BY sub.name, c.name
    `, [teacherId]);

    const monthlyAttendance = attRows.map(r => ({
      month:       r.month,
      presentDays: parseInt(r.present_days),
      absentDays:  parseInt(r.absent_days),
      rate: parseInt(r.total_days) > 0
        ? Math.round((parseInt(r.present_days) / parseInt(r.total_days)) * 100)
        : 0,
    }));

    const homeworkPerWeek = hwRows.map(r => ({
      week:  r.week_start,
      count: parseInt(r.count),
    }));

    res.json({
      success: true,
      data: {
        monthlyAttendance,
        homeworkPerWeek,
        syllabusCompletion: syllRows,
        marksBySubject: markRows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  FINANCIAL ANALYTICS  — GET /api/analytics/financial?year=YYYY
//  Returns: monthlyPL, feeByClass, expenseByCategory, summary
// ══════════════════════════════════════════════════════════════
const getFinancialAnalytics = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const start = `${year}-01-01`;
    const end   = `${year}-12-31`;
    const prevStart = `${year - 1}-01-01`;
    const prevEnd   = `${year - 1}-12-31`;

    // ── Monthly income (from income_entries table) ─────────────
    const { rows: incomeRows } = await pool.query(`
      SELECT
        TO_CHAR(income_date, 'Mon') AS month_label,
        EXTRACT(MONTH FROM income_date)::int AS month_num,
        COALESCE(SUM(amount), 0) AS income
      FROM income_entries
      WHERE income_date BETWEEN $1 AND $2
      GROUP BY month_num, TO_CHAR(income_date, 'Mon')
      ORDER BY month_num
    `, [start, end]);

    // ── Monthly fee collection ─────────────────────────────────
    const { rows: feeRows } = await pool.query(`
      SELECT
        TO_CHAR(fp.payment_date, 'Mon') AS month_label,
        EXTRACT(MONTH FROM fp.payment_date)::int AS month_num,
        COALESCE(SUM(fp.amount), 0) AS fee_collected
      FROM fee_payments fp
      WHERE fp.payment_date BETWEEN $1 AND $2
        AND fp.is_void = FALSE
      GROUP BY month_num, TO_CHAR(fp.payment_date, 'Mon')
      ORDER BY month_num
    `, [start, end]);

    // ── Monthly expenses ───────────────────────────────────────
    const { rows: expRows } = await pool.query(`
      SELECT
        TO_CHAR(e.expense_date, 'Mon') AS month_label,
        EXTRACT(MONTH FROM e.expense_date)::int AS month_num,
        COALESCE(SUM(e.amount), 0) AS expenses
      FROM expenses e
      WHERE e.expense_date BETWEEN $1 AND $2
      GROUP BY month_num, TO_CHAR(e.expense_date, 'Mon')
      ORDER BY month_num
    `, [start, end]);

    // ── Merge into 12-month P&L ────────────────────────────────
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const incomeMap  = Object.fromEntries(incomeRows.map(r => [r.month_num, parseFloat(r.income)]));
    const feeMap     = Object.fromEntries(feeRows.map(r => [r.month_num, parseFloat(r.fee_collected)]));
    const expMap     = Object.fromEntries(expRows.map(r => [r.month_num, parseFloat(r.expenses)]));

    const monthlyPL = MONTHS.map((label, i) => {
      const mn = i + 1;
      const income   = (incomeMap[mn] || 0) + (feeMap[mn] || 0);
      const expenses = expMap[mn] || 0;
      return { month: label, income, expenses, net: income - expenses };
    });

    // ── Fee collection by class ────────────────────────────────
    const { rows: feeByClass } = await pool.query(`
      SELECT
        c.name AS class_name,
        c.grade,
        COUNT(DISTINCT fi.student_id) AS student_count,
        COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0)  AS total_billed,
        COALESCE(SUM(fi.paid_amount), 0) AS total_collected,
        ROUND(
          COALESCE(SUM(fi.paid_amount), 0) / NULLIF(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0) * 100, 1
        ) AS collection_rate
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id AND s.deleted_at IS NULL
      LEFT JOIN fee_invoices fi ON fi.student_id = s.id
        AND fi.status != 'cancelled'
        AND EXTRACT(YEAR FROM fi.created_at) = $1
      WHERE c.status = 'active'
      GROUP BY c.id, c.name, c.grade
      ORDER BY collection_rate ASC NULLS LAST
    `, [year]);

    // ── Expense breakdown by category ─────────────────────────
    const { rows: expByCat } = await pool.query(`
      SELECT
        ec.category_name AS category,
        COALESCE(SUM(e.amount), 0) AS total,
        COUNT(*) AS transactions
      FROM expenses e
      JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.expense_date BETWEEN $1 AND $2
      GROUP BY ec.id, ec.category_name
      ORDER BY total DESC
    `, [start, end]);

    const totalExpenses = expByCat.reduce((s, r) => s + parseFloat(r.total), 0);
    const expenseByCategory = expByCat.map(r => ({
      ...r,
      total: parseFloat(r.total),
      pct:   totalExpenses > 0 ? Math.round((parseFloat(r.total) / totalExpenses) * 100) : 0,
    }));

    // ── Year-over-year summary ─────────────────────────────────
    const { rows: yoyCurrentRows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount), 0) AS income
      FROM income_entries WHERE income_date BETWEEN $1 AND $2
    `, [start, end]);
    const { rows: yoyFeeCurrentRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS fee_collected
      FROM fee_payments WHERE payment_date BETWEEN $1 AND $2 AND is_void = FALSE
    `, [start, end]);
    const { rows: yoyExpCurrentRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS expenses
      FROM expenses WHERE expense_date BETWEEN $1 AND $2
    `, [start, end]);

    const { rows: yoyPrevRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS income
      FROM income_entries WHERE income_date BETWEEN $1 AND $2
    `, [prevStart, prevEnd]);
    const { rows: yoyFeePrevRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS fee_collected
      FROM fee_payments WHERE payment_date BETWEEN $1 AND $2 AND is_void = FALSE
    `, [prevStart, prevEnd]);
    const { rows: yoyExpPrevRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS expenses
      FROM expenses WHERE expense_date BETWEEN $1 AND $2
    `, [prevStart, prevEnd]);

    const curIncome = parseFloat(yoyCurrentRows[0].income) + parseFloat(yoyFeeCurrentRows[0].fee_collected);
    const curExp    = parseFloat(yoyExpCurrentRows[0].expenses);
    const prevIncome = parseFloat(yoyPrevRows[0].income) + parseFloat(yoyFeePrevRows[0].fee_collected);
    const prevExp    = parseFloat(yoyExpPrevRows[0].expenses);

    const summary = {
      year,
      totalIncome:   curIncome,
      totalExpenses: curExp,
      netProfit:     curIncome - curExp,
      prevYear:      year - 1,
      prevIncome,
      prevExpenses:  prevExp,
      prevNet:       prevIncome - prevExp,
      incomeGrowthPct: prevIncome > 0
        ? Math.round(((curIncome - prevIncome) / prevIncome) * 100)
        : null,
    };

    res.json({
      success: true,
      data: { monthlyPL, feeByClass, expenseByCategory, summary },
    });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  ANNUAL REPORT  — GET /api/analytics/annual?year=YYYY
//  Returns comprehensive school-year summary
// ══════════════════════════════════════════════════════════════
const getAnnualReport = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const start = `${year}-01-01`;
    const end   = `${year}-12-31`;

    // Enrollment stats
    const { rows: enrollRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND deleted_at IS NULL) AS active_students,
        COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total_enrolled,
        COUNT(*) FILTER (WHERE gender = 'male'   AND deleted_at IS NULL) AS male_count,
        COUNT(*) FILTER (WHERE gender = 'female' AND deleted_at IS NULL) AS female_count,
        COUNT(*) FILTER (WHERE admission_date BETWEEN $1 AND $2) AS new_admissions
      FROM students
    `, [start, end]);

    // Teacher stats
    const { rows: teacherRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND deleted_at IS NULL) AS active_teachers,
        COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total_teachers
      FROM teachers
    `);

    // Attendance summary for the year
    const { rows: attRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'present') AS present_count,
        COUNT(*) FILTER (WHERE status = 'absent')  AS absent_count,
        COUNT(*) AS total_count
      FROM attendance
      WHERE entity_type = 'student'
        AND date BETWEEN $1 AND $2
        AND period_id IS NULL
    `, [start, end]);

    const attTotal   = parseInt(attRows[0].total_count);
    const attPresent = parseInt(attRows[0].present_count);
    const attendanceSummary = {
      totalDays: attTotal,
      presentDays: attPresent,
      absentDays:  parseInt(attRows[0].absent_count),
      rate: attTotal > 0 ? Math.round((attPresent / attTotal) * 100) : null,
    };

    // Fee collection summary
    const { rows: feeSummary } = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount + fine_amount - discount_amount), 0) AS total_billed,
        COALESCE(SUM(paid_amount), 0) AS total_collected,
        COUNT(*) FILTER (WHERE status = 'paid')    AS paid_invoices,
        COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_invoices,
        COUNT(*) AS total_invoices
      FROM fee_invoices
      WHERE created_at BETWEEN $1 AND $2
        AND status != 'cancelled'
    `, [start, end]);

    const feeData = feeSummary[0];

    // Exam performance summary
    const { rows: examRows } = await pool.query(`
      SELECT
        COUNT(DISTINCT ex.id) AS total_exams,
        COUNT(*)              AS total_results,
        COUNT(*) FILTER (WHERE rs.result_status = 'pass') AS pass_count,
        ROUND(AVG(rs.percentage)::numeric, 1) AS avg_percentage
      FROM result_summary rs
      JOIN exams ex ON ex.id = rs.exam_id
      WHERE ex.start_date BETWEEN $1 AND $2
    `, [start, end]);

    // Expense summary
    const { rows: expSummary } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_expenses, COUNT(*) AS transaction_count
      FROM expenses
      WHERE expense_date BETWEEN $1 AND $2
    `, [start, end]);

    // Income summary
    const { rows: incSummary } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_income, COUNT(*) AS transaction_count
      FROM income_entries
      WHERE income_date BETWEEN $1 AND $2
    `, [start, end]);

    // Top performing classes
    const { rows: topClasses } = await pool.query(`
      SELECT
        c.name AS class_name,
        c.grade,
        COUNT(DISTINCT s.id) AS student_count,
        ROUND(AVG(rs.percentage)::numeric, 1) AS avg_pct
      FROM classes c
      JOIN students s ON s.class_id = c.id AND s.deleted_at IS NULL
      JOIN result_summary rs ON rs.student_id = s.id AND rs.class_id = c.id
      JOIN exams ex ON ex.id = rs.exam_id AND ex.start_date BETWEEN $1 AND $2
      GROUP BY c.id, c.name, c.grade
      HAVING COUNT(rs.exam_id) > 0
      ORDER BY avg_pct DESC
      LIMIT 5
    `, [start, end]);

    // Monthly fee collection trend
    const { rows: monthlyFee } = await pool.query(`
      SELECT
        TO_CHAR(fp.payment_date, 'Mon') AS month,
        EXTRACT(MONTH FROM fp.payment_date)::int AS month_num,
        COALESCE(SUM(fp.amount), 0) AS collected
      FROM fee_payments fp
      WHERE fp.payment_date BETWEEN $1 AND $2
      GROUP BY month_num, TO_CHAR(fp.payment_date, 'Mon')
      ORDER BY month_num
    `, [start, end]);

    const settings = await pool.query(`SELECT school_name, school_address, school_phone FROM settings LIMIT 1`).catch(() => ({ rows: [{}] }));

    res.json({
      success: true,
      data: {
        year,
        school: settings.rows[0] || {},
        enrollment:  enrollRows[0],
        teachers:    teacherRows[0],
        attendance:  attendanceSummary,
        fees: {
          totalBilled:     parseFloat(feeData.total_billed),
          totalCollected:  parseFloat(feeData.total_collected),
          paidInvoices:    parseInt(feeData.paid_invoices),
          overdueInvoices: parseInt(feeData.overdue_invoices),
          totalInvoices:   parseInt(feeData.total_invoices),
          collectionRate:  feeData.total_billed > 0
            ? Math.round((feeData.total_collected / feeData.total_billed) * 100)
            : null,
        },
        exams: {
          totalExams:    parseInt(examRows[0].total_exams),
          totalResults:  parseInt(examRows[0].total_results),
          passCount:     parseInt(examRows[0].pass_count),
          passRate:      examRows[0].total_results > 0
            ? Math.round((examRows[0].pass_count / examRows[0].total_results) * 100)
            : null,
          avgPercentage: parseFloat(examRows[0].avg_percentage),
        },
        expenses: {
          total:       parseFloat(expSummary[0].total_expenses),
          transactions: parseInt(expSummary[0].transaction_count),
        },
        income: {
          total:        parseFloat(incSummary[0].total_income),
          transactions: parseInt(incSummary[0].transaction_count),
        },
        topClasses,
        monthlyFeeCollection: monthlyFee,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  CUSTOM REPORT  — POST /api/analytics/custom-report
//  body: { entity, filters, columns, limit }
//  entity: 'students' | 'teachers' | 'fees' | 'attendance' | 'expenses'
// ══════════════════════════════════════════════════════════════
const getCustomReport = async (req, res) => {
  try {
    const { entity = 'students', filters = {}, limit = 200 } = req.body;

    let query, params = [], conditions = [];
    const push = v => { params.push(v); return `$${params.length}`; };

    if (entity === 'students') {
      if (filters.class_id)  conditions.push(`s.class_id = ${push(filters.class_id)}`);
      if (filters.gender)    conditions.push(`s.gender = ${push(filters.gender)}`);
      if (filters.status) conditions.push(`s.status = ${push(filters.status)}`);
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      query = `
        SELECT s.id, s.full_name, s.admission_number, s.roll_number,
               s.gender, s.date_of_birth, s.phone, s.email,
               s.father_name, s.father_phone, s.father_email,
               s.status, s.admission_date,
               c.name AS class_name, c.grade
        FROM students s
        LEFT JOIN classes c ON c.id = s.class_id
        WHERE s.deleted_at IS NULL ${where}
        ORDER BY s.full_name
        LIMIT ${push(Math.min(limit, 500))}
      `;
    } else if (entity === 'teachers') {
      if (filters.status) conditions.push(`t.status = ${push(filters.status)}`);
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      query = `
        SELECT t.id, t.full_name, t.email, t.phone,
               t.qualification, t.join_date, t.status,
               t.gender, t.subject AS primary_subject,
               STRING_AGG(DISTINCT sub.name, ', ') AS subjects
        FROM teachers t
        LEFT JOIN teacher_subject_assignments tsa ON tsa.teacher_id = t.id
        LEFT JOIN subjects sub ON sub.id = tsa.subject_id
        WHERE t.deleted_at IS NULL ${where}
        GROUP BY t.id, t.full_name, t.email, t.phone,
                 t.qualification, t.join_date, t.status, t.gender, t.subject
        ORDER BY t.full_name
        LIMIT ${push(Math.min(limit, 500))}
      `;
    } else if (entity === 'fees') {
      if (filters.status)    conditions.push(`fi.status = ${push(filters.status)}`);
      if (filters.class_id)  conditions.push(`s.class_id = ${push(filters.class_id)}`);
      if (filters.date_from) conditions.push(`fi.due_date >= ${push(filters.date_from)}`);
      if (filters.date_to)   conditions.push(`fi.due_date <= ${push(filters.date_to)}`);
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      query = `
        SELECT fi.id, fi.invoice_no, fi.billing_month,
               fi.total_amount, fi.discount_amount, fi.fine_amount, fi.paid_amount,
               (fi.total_amount + fi.fine_amount - fi.discount_amount) AS net_amount,
               fi.status, fi.due_date, fi.created_at,
               s.full_name AS student_name, s.admission_number,
               c.name AS class_name
        FROM fee_invoices fi
        JOIN students s ON s.id = fi.student_id
        LEFT JOIN classes c ON c.id = s.class_id
        WHERE fi.status != 'cancelled' ${where}
        ORDER BY fi.created_at DESC
        LIMIT ${push(Math.min(limit, 500))}
      `;
    } else if (entity === 'attendance') {
      if (filters.class_id)  conditions.push(`s.class_id = ${push(filters.class_id)}`);
      if (filters.date_from) conditions.push(`a.date >= ${push(filters.date_from)}`);
      if (filters.date_to)   conditions.push(`a.date <= ${push(filters.date_to)}`);
      if (filters.status)    conditions.push(`a.status = ${push(filters.status)}`);
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      query = `
        SELECT a.id, a.date, a.status, a.entity_type,
               s.full_name AS student_name, s.roll_number, s.admission_number,
               c.name AS class_name
        FROM attendance a
        JOIN students s ON s.id = a.entity_id AND a.entity_type = 'student'
        LEFT JOIN classes c ON c.id = s.class_id
        WHERE a.period_id IS NULL AND s.deleted_at IS NULL ${where}
        ORDER BY a.date DESC, s.full_name
        LIMIT ${push(Math.min(limit, 500))}
      `;
    } else if (entity === 'expenses') {
      if (filters.category_id) conditions.push(`e.category_id = ${push(filters.category_id)}`);
      if (filters.date_from)   conditions.push(`e.expense_date >= ${push(filters.date_from)}`);
      if (filters.date_to)     conditions.push(`e.expense_date <= ${push(filters.date_to)}`);
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      query = `
        SELECT e.id, e.expense_date, e.amount, e.description,
               e.payment_method, e.vendor, e.receipt_no,
               ec.category_name AS category
        FROM expenses e
        LEFT JOIN expense_categories ec ON ec.id = e.category_id
        WHERE 1=1 ${where}
        ORDER BY e.expense_date DESC
        LIMIT ${push(Math.min(limit, 500))}
      `;
    } else {
      return res.status(400).json({ success: false, message: 'Invalid entity type' });
    }

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows, total: rows.length, entity });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getClassAnalytics,
  getTeacherMetrics,
  getFinancialAnalytics,
  getAnnualReport,
  getCustomReport,
};
