const pool = require('../db');

// Today's attendance summary
async function getTodayAttendance() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('present','late'))::int AS present,
       COUNT(*)::int AS marked,
       (SELECT COUNT(*)::int FROM students WHERE status='active') AS total_active
     FROM attendance
     WHERE entity_type='student' AND date=$1 AND period_id IS NULL`,
    [today]
  );
  return rows[0];
}

// This month fee collection stats
async function getMonthFeeStats() {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [col, inv] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS collected
       FROM fee_payments
       WHERE TO_CHAR(payment_date,'YYYY-MM')=$1`,
      [thisMonth]
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_amount),0)::numeric AS invoiced
       FROM fee_invoices
       WHERE TO_CHAR(due_date,'YYYY-MM')=$1 AND status!='cancelled'`,
      [thisMonth]
    ),
  ]);
  return {
    collected: col.rows[0].collected,
    invoiced: inv.rows[0].invoiced,
  };
}

// 6-month fee + expense chart data
async function getFinancialChart() {
  const d6 = new Date();
  d6.setDate(1);
  d6.setMonth(d6.getMonth() - 5);
  const sixMonthStart = d6.toISOString().slice(0, 10);

  const [feeChart, expChart] = await Promise.all([
    pool.query(
      `SELECT TO_CHAR(payment_date,'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS collected
       FROM fee_payments WHERE payment_date >= $1 GROUP BY 1 ORDER BY 1`,
      [sixMonthStart]
    ),
    pool.query(
      `SELECT TO_CHAR(expense_date,'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS spent
       FROM expenses WHERE expense_date >= $1 GROUP BY 1 ORDER BY 1`,
      [sixMonthStart]
    ),
  ]);

  return { feeChart: feeChart.rows, expChart: expChart.rows };
}

// Alerts: overdue homework count, fee defaulters count, chronic absent count, overdue library books
async function getAlerts() {
  const today = new Date().toISOString().slice(0, 10);
  const [hw, defaulters, absent, books] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS cnt FROM homework WHERE due_date < $1 AND status='active'`,
      [today]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT student_id)::int AS cnt FROM fee_invoices WHERE status='overdue'`
    ),
    pool.query(
      `SELECT COUNT(DISTINCT student_id)::int AS cnt
       FROM (
         SELECT student_id, COUNT(*) FILTER (WHERE status='absent') AS absent_days
         FROM attendance
         WHERE entity_type='student' AND date >= CURRENT_DATE - 30
         GROUP BY student_id
         HAVING COUNT(*) FILTER (WHERE status='absent') >= 5
       ) t`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt FROM library_issues WHERE status='issued' AND due_date < $1`,
      [today]
    ),
  ]);

  return {
    overdueHomework: hw.rows[0].cnt,
    feeDefaulters: defaulters.rows[0].cnt,
    chronicAbsent: absent.rows[0].cnt,
    overdueBooks: books.rows[0].cnt,
  };
}

// Pending salary count
async function getPendingSalary() {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM salary_records
     WHERE TO_CHAR(month,'YYYY-MM')=$1 AND status='pending'`,
    [thisMonth]
  );
  return rows[0].cnt;
}

module.exports = {
  getTodayAttendance,
  getMonthFeeStats,
  getFinancialChart,
  getAlerts,
  getPendingSalary,
};
