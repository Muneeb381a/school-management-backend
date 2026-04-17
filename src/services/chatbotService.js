/**
 * chatbotService.js
 * Intent detection engine + DB query layer for the school chatbot.
 *
 * Design principles:
 *  - All DB queries are fully parameterized (zero SQL injection risk)
 *  - Role-based data isolation: students/parents see only their own data
 *  - Graceful fallback on missing data (no hard throws)
 *  - Responses are human-readable, not raw JSON dumps
 */

const db = require('../db');

// ── Calendar helper ───────────────────────────────────────────────────────────
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function todayDayName() { return DAY_NAMES[new Date().getDay()]; }

// Maps user.role → announcements.target_audience value
const ROLE_TO_AUDIENCE = {
  student: 'students',
  teacher: 'teachers',
  parent:  'parents',
  admin:   'all',
};

// ── Intent patterns (ordered: most specific first) ────────────────────────────
const INTENT_PATTERNS = [
  { intent: 'greeting',              pattern: /^(hi|hello|hey|salam|assalam|good\s*(morning|afternoon|evening)|greetings|sup)\b/i },
  { intent: 'help',                  pattern: /\b(help|what can you|commands|features|options|what do you do)\b/i },
  { intent: 'absent_students_query', pattern: /\b(who.{0,10}absent|absent.{0,10}student|absent.{0,10}today|today.{0,10}absent|missing.{0,10}student)\b/i },
  { intent: 'fee_defaulters_query',  pattern: /\b(defaulter|unpaid|who.{0,10}paid|fee.{0,10}default|haven.t paid|not.{0,10}paid)\b/i },
  { intent: 'class_teacher_query',   pattern: /\b(class teacher|my teacher|who.{0,10}teach|incharge|teacher.{0,10}name)\b/i },
  { intent: 'transport_query',       pattern: /\b(bus|transport|van|driver|route|pick.?up|drop.?off|vehicle)\b/i },
  { intent: 'timetable_query',       pattern: /\b(timetable|schedule|today.{0,10}class|class.{0,10}today|period|what.{0,10}class|class.{0,10}time)\b/i },
  { intent: 'attendance_query',      pattern: /\b(attendance|present|absent|days.{0,10}miss|how many days|how.{0,10}attend)\b/i },
  { intent: 'fee_query',             pattern: /\b(fee|fees|pending.{0,10}fee|fee.{0,10}status|payment|paid|challan|invoice|outstanding|due|balance|amount)\b/i },
  { intent: 'homework_query',        pattern: /\b(homework|assignment|pending.{0,10}work|task.{0,10}due)\b/i },
  { intent: 'exam_query',            pattern: /\b(exam|test|quiz|assessment|paper|when.{0,10}exam|next.{0,10}exam|upcoming.{0,10}test)\b/i },
  { intent: 'announcement_query',    pattern: /\b(announcement|notice|news|circular|update|latest)\b/i },
];

// ── Intent detection ──────────────────────────────────────────────────────────
function detectIntent(message) {
  const msg = message.trim();
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(msg)) return intent;
  }
  return 'fallback';
}

// ── Entity resolution helpers ─────────────────────────────────────────────────

/** Resolve the student_id for any role that needs student data */
async function resolveStudentId(user) {
  if (user.role === 'student') return user.entity_id;
  if (user.role === 'parent')  return user.entity_id; // parent.entity_id = child student.id
  if (user.role === 'admin') {
    // Admin context: no specific student — return null (admin gets aggregate views)
    return null;
  }
  return null;
}

async function getStudentClassId(studentId) {
  const { rows } = await db.query(
    `SELECT class_id FROM students WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [studentId]
  );
  return rows[0]?.class_id ?? null;
}

/** Teacher's assigned class IDs (via teacher_classes junction) */
async function getTeacherClassIds(teacherId) {
  const { rows } = await db.query(
    `SELECT DISTINCT class_id FROM teacher_classes WHERE teacher_id = $1`,
    [teacherId]
  );
  return rows.map(r => r.class_id);
}

// ── DB query functions ────────────────────────────────────────────────────────

async function queryAttendance(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return null;

  const [{ rows: [stats] }, { rows: recent }] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('present','late'))  AS present_days,
         COUNT(*) FILTER (WHERE status = 'absent')             AS absent_days,
         COUNT(*)                                               AS total_days,
         ROUND(
           100.0 * COUNT(*) FILTER (WHERE status IN ('present','late')) / NULLIF(COUNT(*), 0), 1
         ) AS percentage,
         COUNT(*) FILTER (WHERE status = 'absent'
                          AND date >= CURRENT_DATE - INTERVAL '7 days') AS absent_this_week
       FROM attendance
       WHERE entity_type = 'student' AND entity_id = $1 AND period_id IS NULL`,
      [studentId]
    ),
    db.query(
      `SELECT date, status FROM attendance
       WHERE entity_type = 'student' AND entity_id = $1 AND period_id IS NULL
       ORDER BY date DESC LIMIT 5`,
      [studentId]
    ),
  ]);

  return { stats, recent };
}

async function queryFees(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return null;

  const [{ rows: [summary] }, { rows: invoices }] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('unpaid','partial','overdue'))               AS pending_count,
         COALESCE(SUM(total_amount + fine_amount - discount_amount - paid_amount)
                  FILTER (WHERE status IN ('unpaid','partial','overdue')), 0)           AS outstanding,
         COALESCE(SUM(paid_amount), 0)                                                 AS total_paid,
         COUNT(*) FILTER (WHERE status = 'paid')                                       AS paid_invoices,
         MIN(due_date) FILTER (WHERE status IN ('unpaid','partial','overdue')
                               AND due_date IS NOT NULL)                               AS earliest_due
       FROM fee_invoices
       WHERE student_id = $1 AND status != 'cancelled'`,
      [studentId]
    ),
    db.query(
      `SELECT invoice_no, billing_month, total_amount, paid_amount,
              (total_amount + fine_amount - discount_amount - paid_amount) AS balance,
              status, due_date
       FROM fee_invoices
       WHERE student_id = $1 AND status IN ('unpaid','partial','overdue')
       ORDER BY due_date NULLS LAST LIMIT 5`,
      [studentId]
    ),
  ]);

  return { summary, invoices };
}

async function queryTimetable(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return null;

  const classId = await getStudentClassId(studentId);
  if (!classId) return null;

  const dayName = todayDayName();

  const { rows } = await db.query(
    `SELECT p.period_no, p.start_time, p.end_time, p.is_break,
            te.subject, t.full_name AS teacher_name
     FROM timetable_entries te
     JOIN periods p ON p.id = te.period_id
     LEFT JOIN teachers t ON t.id = te.teacher_id
     WHERE te.class_id = $1 AND te.day_of_week = $2
     ORDER BY p.period_no`,
    [classId, dayName]
  );

  return { day: dayName, periods: rows };
}

async function queryTransport(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return null;

  const { rows: [bus] } = await db.query(
    `SELECT b.bus_number, b.vehicle_number, b.is_online, b.trip_status,
            b.current_lat, b.current_lng, b.last_seen,
            COALESCE(d.full_name, b.driver_name) AS driver_name,
            COALESCE(d.phone,     b.driver_phone) AS driver_phone,
            r.route_name, r.start_point, r.end_point,
            rs.stop_name, rs.pickup_time, rs.dropoff_time
     FROM student_transport st
     JOIN buses b ON b.id = st.bus_id
     LEFT JOIN drivers d ON d.id = b.driver_id
     LEFT JOIN transport_routes r ON r.id = st.route_id
     LEFT JOIN route_stops rs ON rs.id = st.stop_id
     WHERE st.student_id = $1 AND st.status = 'active'
     LIMIT 1`,
    [studentId]
  );

  return bus ?? null;
}

async function queryClassTeacher(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return null;

  const { rows: [data] } = await db.query(
    `SELECT t.full_name AS teacher_name, t.subject, t.phone, t.email,
            c.name AS class_name, c.grade, c.section
     FROM students s
     JOIN classes c ON c.id = s.class_id
     LEFT JOIN teachers t ON t.id = c.teacher_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [studentId]
  );

  return data ?? null;
}

async function queryHomework(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return [];

  const classId = await getStudentClassId(studentId);
  if (!classId) return [];

  const { rows } = await db.query(
    `SELECT h.title, h.subject_name, h.due_date, h.description,
            t.full_name AS teacher_name
     FROM homework h
     LEFT JOIN teachers t ON t.id = h.teacher_id
     WHERE h.class_id = $1 AND h.due_date >= CURRENT_DATE
       AND h.status NOT IN ('cancelled')
     ORDER BY h.due_date LIMIT 5`,
    [classId]
  );

  return rows;
}

async function queryExams(user) {
  const studentId = await resolveStudentId(user);
  if (!studentId) return [];

  const classId = await getStudentClassId(studentId);
  if (!classId) return [];

  const { rows } = await db.query(
    `SELECT e.name AS exam_name, es.date, es.start_time,
            s.name AS subject_name, es.total_marks, es.passing_marks
     FROM exams e
     JOIN exam_subjects es ON es.exam_id = e.id AND es.class_id = $1
     JOIN subjects s ON s.id = es.subject_id
     WHERE e.status NOT IN ('cancelled') AND es.date >= CURRENT_DATE
     ORDER BY es.date, es.start_time LIMIT 5`,
    [classId]
  );

  return rows;
}

async function queryAbsentStudents(user) {
  let classFilter = '';
  const params = [];

  if (user.role === 'teacher') {
    const classIds = await getTeacherClassIds(user.entity_id);
    if (!classIds.length) return [];
    params.push(classIds);
    classFilter = `AND s.class_id = ANY($1)`;
  }

  const { rows } = await db.query(
    `SELECT s.full_name, s.roll_number,
            c.name AS class_name, c.grade, c.section
     FROM attendance a
     JOIN students s ON s.id = a.entity_id
     JOIN classes c ON c.id = s.class_id
     WHERE a.entity_type = 'student'
       AND a.status = 'absent'
       AND a.date = CURRENT_DATE
       AND a.period_id IS NULL
       ${classFilter}
     ORDER BY c.grade, c.section, s.roll_number
     LIMIT 25`,
    params
  );

  return rows;
}

async function queryFeeDefaulters() {
  const { rows } = await db.query(
    `SELECT s.full_name, s.roll_number,
            c.name AS class_name,
            SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount)::NUMERIC(12,2) AS outstanding
     FROM fee_invoices fi
     JOIN students s ON s.id = fi.student_id AND s.deleted_at IS NULL
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE fi.status IN ('unpaid','partial','overdue')
     GROUP BY s.id, s.full_name, s.roll_number, c.name
     HAVING SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) > 0
     ORDER BY outstanding DESC
     LIMIT 10`
  );
  return rows;
}

async function queryAnnouncements(user) {
  const audienceValue = ROLE_TO_AUDIENCE[user.role] || 'all';

  const { rows } = await db.query(
    `SELECT title, content, created_at
     FROM announcements
     WHERE (target_audience = 'all' OR target_audience = $1)
       AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 3`,
    [audienceValue]
  );
  return rows;
}

// ── Response formatters ───────────────────────────────────────────────────────

function fmtAttendance(data, firstName) {
  if (!data?.stats) return "I couldn't retrieve your attendance records. Please try again.";

  const { present_days, absent_days, total_days, percentage, absent_this_week } = data.stats;
  const pct = parseFloat(percentage) || 0;

  let msg = `📊 *Attendance Report for ${firstName}*\n\n`;
  msg += `✅ Present: ${present_days} days\n`;
  msg += `❌ Absent:  ${absent_days} days\n`;
  msg += `📅 Total:   ${total_days} working days\n`;
  msg += `📈 Rate:    *${pct}%*`;

  if (parseInt(absent_this_week) > 0) {
    msg += `\n\n⚠️ You were absent ${absent_this_week} time(s) this week.`;
  }

  msg += '\n\n';
  if (pct >= 90)      msg += '🌟 Excellent attendance! Keep it up!';
  else if (pct >= 75) msg += '👍 Good attendance. Aim to stay above 90%.';
  else                msg += '⚠️ Your attendance is below 75%. Please attend regularly to avoid issues.';

  if (data.recent?.length) {
    msg += '\n\n*Recent Records:*\n';
    data.recent.forEach(r => {
      const icon = r.status === 'present' ? '✅' : r.status === 'absent' ? '❌' : '⏰';
      const dateStr = new Date(r.date).toLocaleDateString('en-PK', { weekday: 'short', month: 'short', day: 'numeric' });
      msg += `${icon} ${dateStr} — ${r.status}\n`;
    });
  }

  return msg;
}

function fmtFees(data, firstName) {
  if (!data?.summary) return "I couldn't retrieve your fee records. Please contact the accounts office.";

  const { pending_count, outstanding, total_paid, paid_invoices, earliest_due } = data.summary;
  const outstandingAmt = parseFloat(outstanding);

  if (outstandingAmt === 0 && parseInt(pending_count) === 0) {
    return `✅ *Great news, ${firstName}!* You have no pending fees. All cleared! 🎉\n\n📋 Total paid so far: PKR ${parseFloat(total_paid).toLocaleString()}`;
  }

  let msg = `💰 *Fee Status for ${firstName}*\n\n`;
  msg += `🔴 Outstanding: *PKR ${outstandingAmt.toLocaleString()}*\n`;
  msg += `📄 Pending invoices: ${pending_count}\n`;

  if (earliest_due) {
    const dueDate = new Date(earliest_due).toLocaleDateString('en-PK', { month: 'long', day: 'numeric', year: 'numeric' });
    msg += `📅 Earliest due: ${dueDate}\n`;
  }

  msg += `\n✅ Total paid: PKR ${parseFloat(total_paid).toLocaleString()}`;
  msg += `\n📋 Paid invoices: ${paid_invoices}`;

  if (data.invoices?.length) {
    msg += '\n\n*Pending Details:*\n';
    data.invoices.forEach(inv => {
      const label = inv.billing_month || inv.invoice_no || 'Invoice';
      msg += `• ${label} — PKR ${parseFloat(inv.balance).toLocaleString()} (${inv.status})\n`;
    });
  }

  msg += '\n\n💬 Visit the accounts office or pay online to clear your dues.';
  return msg;
}

function fmtTimetable(data) {
  if (!data) return "No timetable data available.";

  const { day, periods } = data;
  if (!periods?.length) {
    return `📅 No classes scheduled for *${day}*. Enjoy your day! 🎉`;
  }

  let msg = `📚 *Timetable for ${day}*\n\n`;
  periods.forEach(p => {
    if (p.is_break) {
      msg += `☕ Period ${p.period_no}: Break`;
      if (p.start_time && p.end_time) msg += ` (${p.start_time}–${p.end_time})`;
    } else {
      msg += `📖 Period ${p.period_no}: *${p.subject || 'N/A'}*`;
      if (p.teacher_name) msg += ` — ${p.teacher_name}`;
      if (p.start_time && p.end_time) msg += ` (${p.start_time}–${p.end_time})`;
    }
    msg += '\n';
  });

  return msg;
}

function fmtTransport(bus) {
  if (!bus) {
    return '🚌 No transport assignment found. Please contact the transport office.';
  }

  let msg = `🚌 *Transport Information*\n\n`;
  msg += `🚍 Bus: *${bus.bus_number || 'N/A'}*`;
  if (bus.vehicle_number) msg += ` (${bus.vehicle_number})`;
  msg += '\n';

  if (bus.driver_name) {
    msg += `👨‍✈️ Driver: ${bus.driver_name}`;
    if (bus.driver_phone) msg += ` — 📞 ${bus.driver_phone}`;
    msg += '\n';
  }
  if (bus.route_name)   msg += `🗺️  Route: ${bus.route_name}\n`;
  if (bus.stop_name)    msg += `📍 Your Stop: ${bus.stop_name}\n`;
  if (bus.pickup_time)  msg += `⏰ Pickup: ${bus.pickup_time}\n`;
  if (bus.dropoff_time) msg += `⏰ Drop-off: ${bus.dropoff_time}\n`;

  const online     = bus.is_online;
  const statusIcon = online ? '🟢' : '🔴';
  const statusText = bus.trip_status === 'started' ? 'On route'
                   : bus.trip_status === 'idle'    ? 'Parked / Idle'
                   : bus.trip_status ?? 'Unknown';
  msg += `\n${statusIcon} Status: *${statusText}*`;

  if (online && bus.last_seen) {
    const t = new Date(bus.last_seen).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
    msg += `\n🕐 Last updated: ${t}`;
  }

  return msg;
}

function fmtClassTeacher(data) {
  if (!data) return "I couldn't find your class teacher information.";

  const cls = data.class_name || `Grade ${data.grade}${data.section ? ' – ' + data.section : ''}`;
  let msg = `👩‍🏫 *Class Teacher Information*\n\n`;
  msg += `🏫 Class: ${cls}\n`;

  if (data.teacher_name) {
    msg += `👤 Teacher: *${data.teacher_name}*\n`;
    if (data.subject) msg += `📚 Subject: ${data.subject}\n`;
    if (data.phone)   msg += `📞 Phone: ${data.phone}\n`;
    if (data.email)   msg += `📧 Email: ${data.email}\n`;
  } else {
    msg += `⚠️ No class teacher has been assigned yet.`;
  }

  return msg;
}

function fmtHomework(rows) {
  if (!rows?.length) return '📚 No pending homework! Great — enjoy your time. 🎉';

  let msg = `📝 *Pending Homework (${rows.length})*\n\n`;
  rows.forEach((hw, i) => {
    const due = new Date(hw.due_date).toLocaleDateString('en-PK', { weekday: 'short', month: 'short', day: 'numeric' });
    msg += `${i + 1}. *${hw.subject_name || 'General'}* — ${hw.title}\n`;
    msg += `   📅 Due: ${due}`;
    if (hw.teacher_name) msg += ` | 👤 ${hw.teacher_name}`;
    msg += '\n';
  });

  return msg;
}

function fmtExams(rows) {
  if (!rows?.length) return '📅 No upcoming exams scheduled. Stay prepared and keep studying! 📚';

  let msg = `📋 *Upcoming Exams (${rows.length})*\n\n`;
  rows.forEach((exam, i) => {
    const date = new Date(exam.date).toLocaleDateString('en-PK', { weekday: 'short', month: 'long', day: 'numeric' });
    msg += `${i + 1}. *${exam.subject_name}* — ${exam.exam_name}\n`;
    msg += `   📅 ${date}`;
    if (exam.start_time) msg += ` at ${exam.start_time}`;
    if (exam.total_marks) msg += ` | Pass: ${exam.passing_marks}/${exam.total_marks} marks`;
    msg += '\n';
  });

  msg += '\n💡 Tip: Start revising early for better results!';
  return msg;
}

function fmtAbsentStudents(rows) {
  const today = new Date().toLocaleDateString('en-PK', { weekday: 'long', month: 'long', day: 'numeric' });

  if (!rows?.length) return `🎉 Great news! No students are absent today (${today}). Full attendance!`;

  // Group by class
  const byClass = {};
  rows.forEach(r => {
    const key = r.class_name || 'Unknown Class';
    (byClass[key] = byClass[key] || []).push(r);
  });

  let msg = `📋 *Absent Students — ${today}*\n`;
  msg += `Total: *${rows.length} student(s)* absent\n\n`;

  Object.entries(byClass).forEach(([cls, students]) => {
    msg += `📌 *${cls}* (${students.length})\n`;
    students.forEach(s => {
      msg += `  • ${s.full_name}`;
      if (s.roll_number) msg += ` (Roll ${s.roll_number})`;
      msg += '\n';
    });
    msg += '\n';
  });

  return msg.trim();
}

function fmtDefaulters(rows) {
  if (!rows?.length) return '✅ No fee defaulters! All students have cleared their dues.';

  let msg = `💸 *Top Fee Defaulters*\n\n`;
  rows.forEach((r, i) => {
    msg += `${i + 1}. *${r.full_name}*`;
    if (r.class_name)   msg += ` — ${r.class_name}`;
    if (r.roll_number)  msg += ` (Roll ${r.roll_number})`;
    msg += `\n   Outstanding: PKR ${parseFloat(r.outstanding).toLocaleString()}\n`;
  });

  return msg;
}

function fmtAnnouncements(rows) {
  if (!rows?.length) return '📢 No recent announcements at this time.';

  let msg = `📢 *Latest Announcements*\n\n`;
  rows.forEach((ann, i) => {
    const date = new Date(ann.created_at).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' });
    msg += `${i + 1}. *${ann.title}* (${date})\n`;
    const excerpt = ann.content?.length > 130 ? ann.content.substring(0, 130) + '…' : ann.content;
    if (excerpt) msg += `   ${excerpt}\n\n`;
  });

  return msg.trim();
}

function getHelpMessage(role) {
  const base = [
    '📊 "What is my attendance?"',
    '💰 "Do I have pending fees?"',
    '📚 "Show my timetable"',
    '🚌 "Where is my bus?"',
    '👩‍🏫 "Who is my class teacher?"',
    '📝 "Show pending homework"',
    '📋 "Upcoming exams"',
    '📢 "Any announcements?"',
  ];
  const staffExtras = [
    '📋 "Which students are absent today?"',
  ];
  const adminExtras = [
    '💸 "Show fee defaulters"',
  ];

  const commands = [
    ...(role === 'admin' || role === 'teacher' ? staffExtras : []),
    ...(role === 'admin' ? adminExtras : []),
    ...base,
  ];

  return `👋 *Hi! I\'m your School Assistant.*\n\nHere\'s what I can help you with:\n\n${commands.join('\n')}\n\nJust type your question naturally and I\'ll do my best to help!`;
}

// ── Access guards ─────────────────────────────────────────────────────────────
const ADMIN_ONLY   = new Set(['fee_defaulters_query']);
const STAFF_ONLY   = new Set(['absent_students_query']);
const STUDENT_INTENTS = new Set(['attendance_query', 'fee_query', 'timetable_query', 'transport_query', 'class_teacher_query', 'homework_query', 'exam_query']);

// ── Main resolver ─────────────────────────────────────────────────────────────
async function resolveIntent(intent, user) {
  const firstName = (user.name || 'there').split(' ')[0];
  const { role } = user;

  // RBAC guards
  if (ADMIN_ONLY.has(intent) && role !== 'admin') {
    return '🔒 This information is only available to administrators.';
  }
  if (STAFF_ONLY.has(intent) && !['admin', 'teacher'].includes(role)) {
    return '🔒 This information is only available to teachers and administrators.';
  }
  if (STUDENT_INTENTS.has(intent) && !['student', 'parent', 'admin'].includes(role)) {
    return '❓ This query is designed for students and parents. Try asking about absent students or announcements instead.';
  }

  try {
    switch (intent) {
      case 'greeting':
        return `Hello ${firstName}! 👋 How can I help you today?\n\nType *help* to see everything I can do for you.`;

      case 'help':
        return getHelpMessage(role);

      case 'attendance_query': {
        const data = await queryAttendance(user);
        return fmtAttendance(data, firstName);
      }

      case 'fee_query': {
        const data = await queryFees(user);
        return fmtFees(data, firstName);
      }

      case 'timetable_query': {
        const data = await queryTimetable(user);
        return fmtTimetable(data);
      }

      case 'transport_query': {
        const bus = await queryTransport(user);
        return fmtTransport(bus);
      }

      case 'class_teacher_query': {
        const data = await queryClassTeacher(user);
        return fmtClassTeacher(data);
      }

      case 'homework_query': {
        const rows = await queryHomework(user);
        return fmtHomework(rows);
      }

      case 'exam_query': {
        const rows = await queryExams(user);
        return fmtExams(rows);
      }

      case 'absent_students_query': {
        const rows = await queryAbsentStudents(user);
        return fmtAbsentStudents(rows);
      }

      case 'fee_defaulters_query': {
        const rows = await queryFeeDefaulters();
        return fmtDefaulters(rows);
      }

      case 'announcement_query': {
        const rows = await queryAnnouncements(user);
        return fmtAnnouncements(rows);
      }

      case 'fallback':
      default:
        return `🤔 I didn\'t quite understand that.\n\nTry asking about your *attendance*, *fees*, *timetable*, or *bus*. Type *help* for all options.`;
    }
  } catch (err) {
    console.error('[chatbot] Error resolving intent "%s":', intent, err.message);
    return '⚠️ Something went wrong fetching your data. Please try again shortly.';
  }
}

module.exports = { detectIntent, resolveIntent };
