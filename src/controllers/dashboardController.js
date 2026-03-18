const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[DASHBOARD]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// GET /api/dashboard/stats
// Returns all data needed for the live dashboard in one round-trip.
const getStats = async (req, res) => {
  try {
    const today      = new Date().toISOString().slice(0, 10);
    const thisMonth  = today.slice(0, 7);

    // Start of the 6-month window (1st of 5 months ago)
    const d6 = new Date(); d6.setDate(1); d6.setMonth(d6.getMonth() - 5);
    const sixMonthStart = d6.toISOString().slice(0, 10);

    const [
      attRow,
      feeCollected,
      feeInvoiced,
      pendingSalary,
      feeChart,
      expChart,
      unmarkedClasses,
      weekEvents,
      overdueHW,
      feeDefaulters,
      chronicAbsent,
      overdueBooks,
    ] = await Promise.all([

      // 1. Today's student attendance
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('present','late'))::int AS present,
           COUNT(*)::int AS marked,
           (SELECT COUNT(*)::int FROM students WHERE status='active') AS total_active
         FROM attendance
         WHERE entity_type='student' AND date=$1 AND period_id IS NULL`,
        [today]
      ),

      // 2a. This month fee collections
      pool.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS collected
         FROM fee_payments
         WHERE TO_CHAR(payment_date,'YYYY-MM') = $1`,
        [thisMonth]
      ),

      // 2b. This month fee invoiced
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0)::numeric AS invoiced
         FROM fee_invoices
         WHERE TO_CHAR(due_date,'YYYY-MM') = $1 AND status != 'cancelled'`,
        [thisMonth]
      ),

      // 3. Pending salaries this month
      pool.query(
        `SELECT COUNT(*)::int AS pending
         FROM salary_payments WHERE month=$1 AND status='pending'`,
        [thisMonth]
      ),

      // 4a. Monthly fee collections chart — last 6 months
      pool.query(
        `SELECT TO_CHAR(payment_date,'YYYY-MM') AS month,
                SUM(amount)::numeric              AS fees
         FROM fee_payments
         WHERE payment_date >= $1
         GROUP BY month ORDER BY month`,
        [sixMonthStart]
      ),

      // 4b. Monthly expenses chart — last 6 months
      pool.query(
        `SELECT TO_CHAR(expense_date,'YYYY-MM') AS month,
                SUM(amount)::numeric             AS expenses
         FROM expenses
         WHERE expense_date >= $1 AND is_deleted = FALSE
         GROUP BY month ORDER BY month`,
        [sixMonthStart]
      ),

      // 5. Classes with no student attendance marked today
      pool.query(
        `SELECT c.id, c.name, c.grade, c.section,
                (SELECT COUNT(*)::int FROM students WHERE class_id=c.id AND status='active') AS student_count
         FROM classes c
         WHERE (SELECT COUNT(*)::int FROM students WHERE class_id=c.id AND status='active') > 0
           AND c.id NOT IN (
             SELECT DISTINCT class_id
             FROM attendance
             WHERE date=$1 AND entity_type='student' AND period_id IS NULL AND class_id IS NOT NULL
           )
         ORDER BY c.name
         LIMIT 8`,
        [today]
      ),

      // 6. Events this week (next 7 days)
      pool.query(
        `SELECT id, title, start_date AS event_date, type AS event_type
         FROM events
         WHERE start_date BETWEEN $1 AND $1::date + INTERVAL '7 days'
         ORDER BY start_date
         LIMIT 5`,
        [today]
      ),

      // 7. Overdue homework assignments
      pool.query(
        `SELECT COUNT(*)::int AS count FROM homework WHERE due_date < $1`,
        [today]
      ),

      // 8. Fee defaulters — students with unpaid/partial invoices past due
      pool.query(
        `SELECT COUNT(DISTINCT student_id)::int AS count
         FROM fee_invoices
         WHERE status IN ('unpaid','partial') AND due_date < $1`,
        [today]
      ),

      // 9. Students with 3+ absences this month (chronic absentees)
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM (
           SELECT entity_id
           FROM attendance
           WHERE entity_type='student' AND status='absent'
             AND date >= $1::date
           GROUP BY entity_id
           HAVING COUNT(*) >= 3
         ) t`,
        [`${thisMonth}-01`]
      ),

      // 10. Overdue library books
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM book_issues
         WHERE due_date < $1 AND status IN ('issued','overdue') AND return_date IS NULL`,
        [today]
      ),
    ]);

    // ── Build monthly chart (last 6 months, merge fee + expense rows) ──
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const feeMap  = {};
    const expMap  = {};
    feeChart.rows.forEach(r => { feeMap[r.month]  = parseFloat(r.fees     || 0); });
    expChart.rows.forEach(r => { expMap[r.month]   = parseFloat(r.expenses || 0); });

    const chart = months.map(m => ({
      month:    m,
      label:    new Date(m + '-01').toLocaleDateString('en-PK', { month: 'short', year: '2-digit' }),
      fees:     feeMap[m]  || 0,
      expenses: expMap[m]  || 0,
    }));

    // ── Attendance % ──
    const att         = attRow.rows[0];
    const totalActive = parseInt(att.total_active) || 0;
    const attPresent  = parseInt(att.present)      || 0;
    const attMarked   = parseInt(att.marked)        || 0;
    const attPct      = totalActive > 0 ? Math.round((attPresent / totalActive) * 100) : null;

    // ── Fee collection rate this month ──
    const collected = parseFloat(feeCollected.rows[0]?.collected || 0);
    const invoiced  = parseFloat(feeInvoiced.rows[0]?.invoiced   || 0);
    const feePct    = invoiced > 0 ? Math.round((collected / invoiced) * 100) : null;

    res.json({
      success: true,
      data: {
        kpis: {
          attendance_today_pct:  attPct,
          attendance_present:    attPresent,
          attendance_marked:     attMarked,
          attendance_total:      totalActive,
          fee_collection_pct:    feePct,
          fee_collected:         collected,
          fee_invoiced:          invoiced,
          pending_salaries:      parseInt(pendingSalary.rows[0]?.pending || 0),
        },
        chart,
        today_panel: {
          unmarked_classes: unmarkedClasses.rows,
          upcoming_events:  weekEvents.rows,
          overdue_homework: parseInt(overdueHW.rows[0]?.count || 0),
        },
        alerts: {
          fee_defaulters:  parseInt(feeDefaulters.rows[0]?.count  || 0),
          chronic_absent:  parseInt(chronicAbsent.rows[0]?.count  || 0),
          overdue_books:   parseInt(overdueBooks.rows[0]?.count    || 0),
        },
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getStats };
