const pool  = require('../db');
const cache = require('../utils/cache');
const { childLogger } = require('../utils/logger');
const { serverErr } = require('../utils/serverErr');
const svc = require('../services/dashboardService');
const log = childLogger('DASHBOARD');

// ── Shared helper: build the monthly chart array ───────────────
function buildChart(feeRows, expRows) {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const feeMap = {};
  const expMap = {};
  feeRows.forEach(r => { feeMap[r.month] = parseFloat(r.fees     || 0); });
  expRows.forEach(r => { expMap[r.month] = parseFloat(r.expenses || 0); });
  return months.map(m => ({
    month:    m,
    label:    new Date(m + '-01').toLocaleDateString('en-PK', { month: 'short', year: '2-digit' }),
    fees:     feeMap[m] || 0,
    expenses: expMap[m] || 0,
  }));
}

// ── Shared helper: build the standard stats payload ───────────
function buildStatsPayload({ att, feeKpis, pendingSalaries, chartData, unmarked, events, alerts, counts }) {
  const totalActive = parseInt(att.total_active) || 0;
  const attPresent  = parseInt(att.present)      || 0;
  const attMarked   = parseInt(att.marked)        || 0;
  const attPct      = totalActive > 0 ? Math.round((attPresent / totalActive) * 100) : null;
  const feePct      = feeKpis.invoiced > 0
    ? Math.round((feeKpis.collected / feeKpis.invoiced) * 100) : null;

  return {
    counts: {
      all_students:       counts.all_students       || 0,
      active_students:    counts.active_students    || 0,
      inactive_students:  counts.inactive_students  || 0,
      suspended_students: counts.suspended_students || 0,
      graduated_students: counts.graduated_students || 0,
      male_students:      counts.male_students      || 0,
      female_students:    counts.female_students    || 0,
      total_teachers:     counts.total_teachers     || 0,
      total_classes:      counts.total_classes      || 0,
      total_students:     counts.active_students    || 0, // backward-compat alias
    },
    kpis: {
      attendance_today_pct: attPct,
      attendance_present:   attPresent,
      attendance_marked:    attMarked,
      attendance_total:     totalActive,
      fee_collection_pct:   feePct,
      fee_collected:        feeKpis.collected,
      fee_invoiced:         feeKpis.invoiced,
      pending_salaries:     pendingSalaries,
    },
    chart: buildChart(chartData.feeRows, chartData.expRows),
    today_panel: {
      unmarked_classes: unmarked,
      upcoming_events:  events,
      overdue_homework: alerts.overdue_homework,
    },
    alerts: {
      fee_defaulters: alerts.fee_defaulters,
      chronic_absent: alerts.chronic_absent,
      overdue_books:  alerts.overdue_books,
    },
  };
}

// ── GET /api/dashboard/stats ───────────────────────────────────
// Returns KPI data only. Cached for 5 min. Used by the refresh button.
const getStats = async (req, res) => {
  try {
    const date  = svc.today();
    const month = svc.thisMonth();
    const cacheKey = `dashboard:stats:${date}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      log.debug({ cacheKey }, 'Dashboard stats cache hit');
      return res.json({ success: true, data: cached, _cached: true });
    }

    const [att, feeKpis, pendingSalaries, chartData, unmarked, events, alerts, counts] =
      await Promise.all([
        svc.getAttendanceToday(date),
        svc.getMonthFeeKpis(month),
        svc.getPendingSalary(month),
        svc.getChartData(svc.sixMonthsAgo()),
        svc.getUnmarkedClasses(date),
        svc.getWeekEvents(date),
        svc.getAlertCounts(date, month),
        svc.getCountsSummary(),
      ]);

    const payload = buildStatsPayload({ att, feeKpis, pendingSalaries, chartData, unmarked, events, alerts, counts });

    await cache.set(cacheKey, payload, 300);
    res.json({ success: true, data: payload });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/dashboard/full ────────────────────────────────────
// Returns everything getStats returns PLUS list data (students,
// classes, teachers, exams, online classes, fee summary) so the
// admin dashboard can load in a single request instead of 7.
// Cached for 3 min (slightly less than stats cache).
const getFullDashboard = async (req, res) => {
  try {
    const date  = svc.today();
    const month = svc.thisMonth();
    const cacheKey = `dashboard:full:${date}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      log.debug({ cacheKey }, 'Dashboard full cache hit');
      return res.json({ success: true, data: cached, _cached: true });
    }

    const [
      att, feeKpis, pendingSalaries, chartData, unmarked, events, alerts, counts,
      students, classes, teachers, exams, onlineClasses, feeSummary,
    ] = await Promise.all([
      svc.getAttendanceToday(date),
      svc.getMonthFeeKpis(month),
      svc.getPendingSalary(month),
      svc.getChartData(svc.sixMonthsAgo()),
      svc.getUnmarkedClasses(date),
      svc.getWeekEvents(date),
      svc.getAlertCounts(date, month),
      svc.getCountsSummary(),
      // List data
      svc.getRecentStudents(6),
      svc.getClassesList(),
      svc.getRecentTeachers(12),
      svc.getUpcomingExams(date, 5),
      svc.getUpcomingOnlineClasses(5),
      svc.getFeeSummary(),
    ]);

    const payload = {
      ...buildStatsPayload({ att, feeKpis, pendingSalaries, chartData, unmarked, events, alerts, counts }),
      students,
      classes,
      teachers,
      exams,
      online_classes: onlineClasses,
      fee_summary: feeSummary,
    };

    await cache.set(cacheKey, payload, 180);
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
    return serverErr(res, err);
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
    return serverErr(res, err);
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
    return serverErr(res, err);
  }
};

module.exports = { getStats, getFullDashboard, getTeacherDashboard, getStudentDashboard, getParentDashboard };
