const pool  = require('../db');
const cache = require('../utils/cache');
const { childLogger } = require('../utils/logger');
const log = childLogger('DASHBOARD');

const serverErr = (res, err) => {
  log.error({ err: err.message }, 'Dashboard error');
  res.status(500).json({ success: false, message: err.message });
};

// GET /api/dashboard/stats
// Returns all data needed for the live dashboard in one round-trip.
const getStats = async (req, res) => {
  try {
    const today      = new Date().toISOString().slice(0, 10);
    // Cache key includes today's date so stats auto-expire at midnight
    const cacheKey = `dashboard:stats:${today}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      log.debug({ cacheKey }, 'Dashboard stats cache hit');
      return res.json({ success: true, data: cached, _cached: true });
    }
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
      countsRow,
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

      // 11. Totals: students, teachers, classes
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM students  WHERE status = 'active'   AND deleted_at IS NULL) AS total_students,
           (SELECT COUNT(*)::int FROM students  WHERE status = 'active' AND gender = 'Male'   AND deleted_at IS NULL) AS male_students,
           (SELECT COUNT(*)::int FROM students  WHERE status = 'active' AND gender = 'Female' AND deleted_at IS NULL) AS female_students,
           (SELECT COUNT(*)::int FROM teachers  WHERE status = 'active'   AND deleted_at IS NULL) AS total_teachers,
           (SELECT COUNT(*)::int FROM classes)                                                     AS total_classes`
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

    const counts = countsRow.rows[0] || {};
    const payload = {
        counts: {
          total_students:  counts.total_students  || 0,
          male_students:   counts.male_students   || 0,
          female_students: counts.female_students || 0,
          total_teachers:  counts.total_teachers  || 0,
          total_classes:   counts.total_classes   || 0,
        },
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
    };

    // Cache for 5 minutes (dashboard is refreshed frequently)
    await cache.set(cacheKey, payload, 300);

    res.json({ success: true, data: payload });
  } catch (err) { serverErr(res, err); }
};

const getTeacherDashboard = async (req, res) => {
  try {
    const teacherId = req.user.entity_id;
    const today = new Date().toISOString().slice(0, 10);
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    const [classes, periods, pendingHW, leaves] = await Promise.all([
      // My assigned classes
      pool.query(
        `SELECT DISTINCT c.id, c.name, c.section, c.grade,
                (SELECT COUNT(*)::int FROM students WHERE class_id=c.id AND status='active') AS student_count
         FROM teacher_class_assignments tca
         JOIN classes c ON c.id = tca.class_id
         WHERE tca.teacher_id = $1`,
        [teacherId]
      ),
      // Today's timetable periods
      pool.query(
        `SELECT tt.period_number, tt.start_time, tt.end_time,
                s.name AS subject_name,
                c.name AS class_name, c.section
         FROM timetable tt
         JOIN subjects s   ON s.id = tt.subject_id
         JOIN classes  c   ON c.id = tt.class_id
         JOIN teacher_class_assignments tca ON tca.class_id = tt.class_id AND tca.teacher_id = $1
         WHERE tt.day_of_week = $2
         ORDER BY tt.period_number`,
        [teacherId, dayName]
      ),
      // Pending homework assignments
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM homework WHERE teacher_id=$1 AND due_date >= $2`,
        [teacherId, today]
      ),
      // My pending leave applications
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM teacher_leaves WHERE teacher_id=$1 AND status='pending'`,
        [teacherId]
      ),
    ]);

    const totalStudents = classes.rows.reduce((s, c) => s + (c.student_count || 0), 0);

    res.json({
      success: true,
      data: {
        myClasses:       classes.rows.length,
        totalStudents,
        pendingHomework: pendingHW.rows[0].cnt,
        pendingLeaves:   leaves.rows[0].cnt,
        todayPeriods:    periods.rows,
        myClassList:     classes.rows,
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'Teacher dashboard error');
    res.status(500).json({ success: false, message: err.message });
  }
};

const getStudentDashboard = async (req, res) => {
  try {
    const studentId = req.user.entity_id;
    const today     = new Date().toISOString().slice(0, 10);
    const thisMonth = today.slice(0, 7);
    const dayName   = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    // Get student + class info first
    const { rows: [student] } = await pool.query(
      `SELECT s.id, s.full_name, s.class_id,
              c.name AS class_name, c.section, c.grade
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.id = $1`,
      [studentId]
    );

    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const [attendance, homework, exams, periods, announcements] = await Promise.all([
      // Attendance this month
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('present','late'))::int AS present,
           COUNT(*)::int AS total
         FROM attendance
         WHERE entity_type='student' AND entity_id=$1 AND TO_CHAR(date,'YYYY-MM')=$2 AND period_id IS NULL`,
        [studentId, thisMonth]
      ),
      // Pending homework
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM homework
         WHERE class_id=$1 AND due_date >= $2 AND status='active'`,
        [student.class_id, today]
      ),
      // Upcoming exams (next 30 days)
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM exams
         WHERE class_id=$1 AND exam_date BETWEEN $2 AND $2::date + INTERVAL '30 days'`,
        [student.class_id, today]
      ),
      // Today's timetable
      student.class_id ? pool.query(
        `SELECT tt.period_number, tt.start_time, tt.end_time, s.name AS subject_name
         FROM timetable tt
         JOIN subjects s ON s.id = tt.subject_id
         WHERE tt.class_id=$1 AND tt.day_of_week=$2
         ORDER BY tt.period_number`,
        [student.class_id, dayName]
      ) : Promise.resolve({ rows: [] }),
      // Recent announcements
      pool.query(
        `SELECT id, title, created_at FROM announcements
         WHERE target_audience IN ('all','students') OR target_audience IS NULL
         ORDER BY created_at DESC LIMIT 5`
      ),
    ]);

    const att = attendance.rows[0];
    const attPct = att.total > 0 ? Math.round((att.present / att.total) * 100) : 0;

    res.json({
      success: true,
      data: {
        className:           `${student.class_name || ''}${student.section ? ' ' + student.section : ''}`.trim(),
        attendancePercent:   attPct,
        attendancePresent:   att.present,
        attendanceTotal:     att.total,
        pendingHomework:     homework.rows[0].cnt,
        upcomingExams:       exams.rows[0].cnt,
        todayPeriods:        periods.rows,
        recentAnnouncements: announcements.rows,
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'Student dashboard error');
    res.status(500).json({ success: false, message: err.message });
  }
};

const getParentDashboard = async (req, res) => {
  try {
    const parentId  = req.user.entity_id;
    const thisMonth = new Date().toISOString().slice(0, 7);

    // Get parent's child (first linked student)
    const { rows: [parent] } = await pool.query(
      `SELECT p.id, p.student_id, s.full_name AS child_name,
              s.class_id, c.name AS class_name, c.section, c.grade
       FROM parents p
       JOIN students s ON s.id = p.student_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE p.id = $1`,
      [parentId]
    );

    if (!parent) return res.json({ success: true, data: {} });

    const [attendance, fees, announcements] = await Promise.all([
      // Attendance this month
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('present','late'))::int AS present,
           COUNT(*)::int AS total
         FROM attendance
         WHERE entity_type='student' AND entity_id=$1 AND TO_CHAR(date,'YYYY-MM')=$2 AND period_id IS NULL`,
        [parent.student_id, thisMonth]
      ),
      // Outstanding fees
      pool.query(
        `SELECT COALESCE(SUM(total_amount + fine_amount - discount_amount - paid_amount), 0)::numeric AS outstanding
         FROM fee_invoices
         WHERE student_id=$1 AND status NOT IN ('paid','cancelled')`,
        [parent.student_id]
      ),
      // Recent announcements for parents
      pool.query(
        `SELECT id, title, created_at FROM announcements
         WHERE target_audience IN ('all','parents') OR target_audience IS NULL
         ORDER BY created_at DESC LIMIT 5`
      ),
    ]);

    const att = attendance.rows[0];
    const attPct = att.total > 0 ? Math.round((att.present / att.total) * 100) : 0;

    res.json({
      success: true,
      data: {
        childName:           parent.child_name,
        className:           `${parent.class_name || ''}${parent.section ? ' ' + parent.section : ''}`.trim(),
        attendancePercent:   attPct,
        pendingFees:         parseFloat(fees.rows[0].outstanding || 0),
        recentAnnouncements: announcements.rows,
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'Parent dashboard error');
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getStats, getTeacherDashboard, getStudentDashboard, getParentDashboard };
