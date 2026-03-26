const pool = require('../db');

// ─── Helpers ──────────────────────────────────────────────────
const today      = () => new Date().toISOString().slice(0, 10);
const thisMonth  = () => new Date().toISOString().slice(0, 7);
function sixMonthsAgo() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5);
  return d.toISOString().slice(0, 10);
}

// ─── Core KPI queries ─────────────────────────────────────────

async function getAttendanceToday(date) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('present','late'))::int AS present,
       COUNT(*)::int AS marked,
       (SELECT COUNT(*)::int FROM students WHERE status='active') AS total_active
     FROM attendance
     WHERE entity_type='student' AND date=$1 AND period_id IS NULL`,
    [date]
  );
  return rows[0];
}

async function getMonthFeeKpis(month) {
  const [col, inv] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS collected
       FROM fee_payments WHERE TO_CHAR(payment_date,'YYYY-MM')=$1`,
      [month]
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_amount),0)::numeric AS invoiced
       FROM fee_invoices WHERE TO_CHAR(due_date,'YYYY-MM')=$1 AND status!='cancelled'`,
      [month]
    ),
  ]);
  return {
    collected: parseFloat(col.rows[0].collected || 0),
    invoiced:  parseFloat(inv.rows[0].invoiced  || 0),
  };
}

async function getPendingSalary(month) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS pending FROM salary_payments WHERE month=$1 AND status='pending'`,
    [month]
  );
  return rows[0].pending;
}

async function getChartData(sixMonthStart) {
  const [feeRows, expRows] = await Promise.all([
    pool.query(
      `SELECT TO_CHAR(payment_date,'YYYY-MM') AS month, SUM(amount)::numeric AS fees
       FROM fee_payments WHERE payment_date >= $1 GROUP BY month ORDER BY month`,
      [sixMonthStart]
    ),
    pool.query(
      `SELECT TO_CHAR(expense_date,'YYYY-MM') AS month, SUM(amount)::numeric AS expenses
       FROM expenses WHERE expense_date >= $1 AND is_deleted=FALSE GROUP BY month ORDER BY month`,
      [sixMonthStart]
    ),
  ]);
  return { feeRows: feeRows.rows, expRows: expRows.rows };
}

async function getUnmarkedClasses(date) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.grade, c.section,
            (SELECT COUNT(*)::int FROM students WHERE class_id=c.id AND status='active') AS student_count
     FROM classes c
     WHERE (SELECT COUNT(*)::int FROM students WHERE class_id=c.id AND status='active') > 0
       AND c.id NOT IN (
         SELECT DISTINCT class_id FROM attendance
         WHERE date=$1 AND entity_type='student' AND period_id IS NULL AND class_id IS NOT NULL
       )
     ORDER BY c.name LIMIT 8`,
    [date]
  );
  return rows;
}

async function getWeekEvents(date) {
  const { rows } = await pool.query(
    `SELECT id, title, start_date AS event_date, type AS event_type
     FROM events
     WHERE start_date BETWEEN $1 AND $1::date + INTERVAL '7 days'
     ORDER BY start_date LIMIT 5`,
    [date]
  );
  return rows;
}

async function getAlertCounts(date, month) {
  const [hw, defaulters, absent, books] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM homework WHERE due_date < $1`, [date]),
    pool.query(
      `SELECT COUNT(DISTINCT student_id)::int AS count
       FROM fee_invoices WHERE status IN ('unpaid','partial') AND due_date < $1`,
      [date]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT entity_id FROM attendance
         WHERE entity_type='student' AND status='absent' AND date >= $1::date
         GROUP BY entity_id HAVING COUNT(*) >= 3
       ) t`,
      [`${month}-01`]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM book_issues
       WHERE due_date < $1 AND status IN ('issued','overdue') AND return_date IS NULL`,
      [date]
    ),
  ]);
  return {
    overdue_homework: hw.rows[0].count,
    fee_defaulters:   defaulters.rows[0].count,
    chronic_absent:   absent.rows[0].count,
    overdue_books:    books.rows[0].count,
  };
}

async function getCountsSummary() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE deleted_at IS NULL)                                              AS all_students,
      (SELECT COUNT(*)::int FROM students WHERE status='active'    AND deleted_at IS NULL)                      AS active_students,
      (SELECT COUNT(*)::int FROM students WHERE status='inactive'  AND deleted_at IS NULL)                      AS inactive_students,
      (SELECT COUNT(*)::int FROM students WHERE status='suspended' AND deleted_at IS NULL)                      AS suspended_students,
      (SELECT COUNT(*)::int FROM students WHERE status='graduated' AND deleted_at IS NULL)                      AS graduated_students,
      (SELECT COUNT(*)::int FROM students WHERE status='active' AND gender='Male'   AND deleted_at IS NULL)     AS male_students,
      (SELECT COUNT(*)::int FROM students WHERE status='active' AND gender='Female' AND deleted_at IS NULL)     AS female_students,
      (SELECT COUNT(*)::int FROM teachers WHERE status='active' AND deleted_at IS NULL)                        AS total_teachers,
      (SELECT COUNT(*)::int FROM classes)                                                                        AS total_classes
  `);
  return rows[0] || {};
}

// ─── List queries for /full endpoint ──────────────────────────

async function getRecentStudents(limit = 6) {
  const { rows } = await pool.query(
    `SELECT id, full_name, grade, section, roll_number, status, admission_date, gender
     FROM students WHERE deleted_at IS NULL
     ORDER BY created_at DESC NULLS LAST LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getClassesList() {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.grade, c.section, COALESCE(c.capacity, 40) AS capacity,
            COUNT(s.id) FILTER (WHERE s.status='active' AND s.deleted_at IS NULL)::int AS student_count
     FROM classes c
     LEFT JOIN students s ON s.class_id = c.id
     GROUP BY c.id
     ORDER BY c.name`
  );
  return rows;
}

async function getRecentTeachers(limit = 12) {
  const { rows } = await pool.query(
    `SELECT id, full_name, subject, status
     FROM teachers WHERE deleted_at IS NULL
     ORDER BY created_at DESC NULLS LAST LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getUpcomingExams(date, limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, exam_name, start_date, end_date, status
     FROM exams WHERE status != 'completed'
     ORDER BY start_date ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getUpcomingOnlineClasses(limit = 5) {
  const { rows } = await pool.query(
    `SELECT oc.id, oc.title, oc.status, oc.scheduled_at,
            c.name AS class_name,
            s.name AS subject_name,
            t.full_name AS teacher_name
     FROM online_classes oc
     LEFT JOIN classes  c ON c.id = oc.class_id
     LEFT JOIN subjects s ON s.id = oc.subject_id
     LEFT JOIN teachers t ON t.id = oc.teacher_id
     WHERE oc.scheduled_at > NOW() AND oc.status = 'scheduled'
     ORDER BY oc.scheduled_at ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getFeeSummary() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='paid')::int      AS paid_count,
       COUNT(*) FILTER (WHERE status='unpaid')::int    AS unpaid_count,
       COUNT(*) FILTER (WHERE status='partial')::int   AS partial_count,
       COUNT(*) FILTER (WHERE status='overdue')::int   AS overdue_count,
       SUM(total_amount+fine_amount-discount_amount)::numeric(12,2)             AS total_billed,
       SUM(paid_amount)::numeric(12,2)                                           AS total_collected,
       SUM(total_amount+fine_amount-discount_amount-paid_amount)::numeric(12,2) AS total_pending
     FROM fee_invoices WHERE status!='cancelled'`
  );
  return rows[0] || {};
}

module.exports = {
  // KPI
  getAttendanceToday,
  getMonthFeeKpis,
  getPendingSalary,
  getChartData,
  getUnmarkedClasses,
  getWeekEvents,
  getAlertCounts,
  getCountsSummary,
  // Lists
  getRecentStudents,
  getClassesList,
  getRecentTeachers,
  getUpcomingExams,
  getUpcomingOnlineClasses,
  getFeeSummary,
  // Helpers
  today,
  thisMonth,
  sixMonthsAgo,
};
