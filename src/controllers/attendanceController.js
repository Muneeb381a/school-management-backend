const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[ATTENDANCE]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/class-students
//  Returns all students in a class with their attendance status
//  for a specific date (and optional period_id).
//  Query: class_id, date, period_id (optional)
// ─────────────────────────────────────────────────────────────
const getClassStudentsAttendance = async (req, res) => {
  try {
    const { class_id, date, period_id } = req.query;
    if (!class_id || !date) {
      return res.status(400).json({ success: false, message: 'class_id and date are required' });
    }

    const params = [class_id, date];
    const periodCondition = period_id
      ? `AND a.period_id = $${params.push(period_id)}`
      : `AND a.period_id IS NULL`;

    const { rows } = await pool.query(
      `SELECT
         s.id, s.full_name, s.roll_number, s.gender, s.b_form_no, s.phone,
         s.father_name, s.father_phone,
         a.id         AS att_id,
         a.status,
         a.remarks,
         a.marked_by,
         a.period_id,
         a.updated_at
       FROM students s
       LEFT JOIN attendance a
         ON a.entity_type = 'student'
        AND a.entity_id   = s.id
        AND a.date        = $2
        ${periodCondition}
       WHERE s.class_id = $1
       ORDER BY s.roll_number NULLS LAST, s.full_name`,
      params
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/teachers-status
//  Returns all teachers with their attendance for a date.
//  Query: date
// ─────────────────────────────────────────────────────────────
const getTeachersAttendance = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'date is required' });

    const { rows } = await pool.query(
      `SELECT
         t.id, t.full_name, t.subject, t.phone, t.gender, t.status AS teacher_status,
         a.id      AS att_id,
         a.status,
         a.remarks,
         a.marked_by,
         a.updated_at
       FROM teachers t
       LEFT JOIN attendance a
         ON a.entity_type = 'teacher'
        AND a.entity_id   = t.id
        AND a.date        = $1
        AND a.period_id IS NULL
       WHERE t.status = 'active'
       ORDER BY t.full_name`,
      [date]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/attendance/bulk
//  Upsert attendance for many students/teachers at once.
//  Body: { records: [{ entity_type, entity_id, class_id, period_id,
//                       date, status, remarks, marked_by }] }
// ─────────────────────────────────────────────────────────────
const bulkMark = async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ success: false, message: 'records array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = [];
    for (const r of records) {
      const { entity_type, entity_id, class_id, period_id, date, status, remarks, marked_by } = r;
      if (!entity_type || !entity_id || !date || !status) continue;

      const pid = period_id || null;
      let row;
      try {
        // Attempt INSERT first
        const { rows } = await client.query(
          `INSERT INTO attendance
             (entity_type, entity_id, class_id, period_id, date, status, remarks, marked_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [entity_type, entity_id, class_id || null, pid,
           date, status, remarks || null, marked_by || null]
        );
        row = rows[0];
      } catch (e) {
        if (e.code === '23505') {
          // Duplicate — UPDATE the existing record
          const { rows } = await client.query(
            `UPDATE attendance
             SET status=$1, remarks=$2, marked_by=$3, updated_at=NOW()
             WHERE entity_type=$4 AND entity_id=$5 AND date=$6
               AND (period_id = $7 OR (period_id IS NULL AND $7 IS NULL))
             RETURNING *`,
            [status, remarks || null, marked_by || null,
             entity_type, entity_id, date, pid]
          );
          row = rows[0];
        } else { throw e; }
      }
      if (row) results.push(row);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, saved: results.length, message: `${results.length} records saved` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/attendance  — single record upsert
// ─────────────────────────────────────────────────────────────
const markSingle = async (req, res) => {
  try {
    const { entity_type, entity_id, class_id, period_id, date, status, remarks, marked_by } = req.body;
    if (!entity_type || !entity_id || !date || !status) {
      return res.status(400).json({ success: false, message: 'entity_type, entity_id, date, and status are required' });
    }

    // Use raw INSERT … ON CONFLICT workaround for partial unique indexes
    // (PostgreSQL doesn't support ON CONFLICT on partial indexes by name directly in all drivers)
    // Strategy: try INSERT, catch unique violation (23505), then UPDATE.
    let row;
    try {
      const { rows } = await pool.query(
        `INSERT INTO attendance
           (entity_type, entity_id, class_id, period_id, date, status, remarks, marked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [entity_type, entity_id, class_id || null, period_id || null,
         date, status, remarks || null, marked_by || null]
      );
      row = rows[0];
    } catch (e) {
      if (e.code === '23505') {
        // Already exists — update
        const { rows } = await pool.query(
          `UPDATE attendance
           SET status=$1, remarks=$2, marked_by=$3, updated_at=NOW()
           WHERE entity_type=$4 AND entity_id=$5 AND date=$6
             AND (period_id=$7 OR (period_id IS NULL AND $7 IS NULL))
           RETURNING *`,
          [status, remarks || null, marked_by || null,
           entity_type, entity_id, date, period_id || null]
        );
        row = rows[0];
      } else { throw e; }
    }
    res.status(201).json({ success: true, data: row });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  PUT /api/attendance/:id
// ─────────────────────────────────────────────────────────────
const updateAttendance = async (req, res) => {
  try {
    const { status, remarks, marked_by } = req.body;
    const { rows } = await pool.query(
      `UPDATE attendance SET status=$1, remarks=$2, marked_by=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [status, remarks || null, marked_by || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  DELETE /api/attendance/:id
// ─────────────────────────────────────────────────────────────
const deleteAttendance = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM attendance WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/monthly
//  Monthly summary — attendance % per student or teacher.
//  Query: entity_type (student|teacher), class_id (if student),
//         month (YYYY-MM), period_id (optional)
// ─────────────────────────────────────────────────────────────
const getMonthlySummary = async (req, res) => {
  try {
    const { entity_type = 'student', class_id, month, period_id } = req.query;
    if (!month) return res.status(400).json({ success: false, message: 'month (YYYY-MM) is required' });

    const startDate = `${month}-01`;
    const endDate   = new Date(new Date(startDate).getFullYear(), new Date(startDate).getMonth() + 1, 0)
      .toISOString().slice(0, 10);

    // periodFilter uses alias "a." for JOIN queries; periodFilterPlain for standalone queries
    const periodFilter      = period_id ? `AND a.period_id = ${parseInt(period_id)}` : `AND a.period_id IS NULL`;
    const periodFilterPlain = period_id ? `AND period_id = ${parseInt(period_id)}`   : `AND period_id IS NULL`;

    if (entity_type === 'student') {
      if (!class_id) return res.status(400).json({ success: false, message: 'class_id required for student report' });

      const { rows } = await pool.query(
        `SELECT
           s.id, s.full_name, s.roll_number, s.gender,
           COUNT(a.id)                                                        AS total_days,
           COUNT(a.id) FILTER (WHERE a.status = 'present')::int              AS present,
           COUNT(a.id) FILTER (WHERE a.status = 'absent')::int               AS absent,
           COUNT(a.id) FILTER (WHERE a.status = 'late')::int                 AS late,
           COUNT(a.id) FILTER (WHERE a.status = 'excused')::int              AS excused,
           ROUND(
             100.0 * COUNT(a.id) FILTER (WHERE a.status IN ('present','late')) /
             NULLIF(COUNT(a.id), 0), 1
           ) AS percentage
         FROM students s
         LEFT JOIN attendance a
           ON a.entity_type = 'student' AND a.entity_id = s.id
           AND a.date BETWEEN $2 AND $3
           ${periodFilter}
         WHERE s.class_id = $1
         GROUP BY s.id, s.full_name, s.roll_number, s.gender
         ORDER BY s.roll_number NULLS LAST, s.full_name`,
        [class_id, startDate, endDate]
      );

      // Working days in the month for this class
      const { rows: days } = await pool.query(
        `SELECT COUNT(DISTINCT date)::int AS working_days
         FROM attendance
         WHERE entity_type='student' AND class_id=$1
           AND date BETWEEN $2 AND $3 ${periodFilterPlain}`,
        [class_id, startDate, endDate]
      );

      // Use key "rows" (not "data") so axios interceptor won't strip working_days metadata
      res.json({ success: true, rows, working_days: days[0]?.working_days || 0, month, startDate, endDate });
    } else {
      const { rows } = await pool.query(
        `SELECT
           t.id, t.full_name, t.subject, t.gender,
           COUNT(a.id)::int                                                    AS total_days,
           COUNT(a.id) FILTER (WHERE a.status = 'present')::int               AS present,
           COUNT(a.id) FILTER (WHERE a.status = 'absent')::int                AS absent,
           COUNT(a.id) FILTER (WHERE a.status = 'late')::int                  AS late,
           COUNT(a.id) FILTER (WHERE a.status = 'excused')::int               AS excused,
           ROUND(
             100.0 * COUNT(a.id) FILTER (WHERE a.status IN ('present','late')) /
             NULLIF(COUNT(a.id), 0), 1
           ) AS percentage
         FROM teachers t
         LEFT JOIN attendance a
           ON a.entity_type = 'teacher' AND a.entity_id = t.id
           AND a.date BETWEEN $1 AND $2
           AND a.period_id IS NULL
         WHERE t.status = 'active'
         GROUP BY t.id, t.full_name, t.subject, t.gender
         ORDER BY t.full_name`,
        [startDate, endDate]
      );

      const { rows: days } = await pool.query(
        `SELECT COUNT(DISTINCT date)::int AS working_days
         FROM attendance
         WHERE entity_type='teacher' AND date BETWEEN $1 AND $2 AND period_id IS NULL`,
        [startDate, endDate]
      );

      res.json({ success: true, rows, working_days: days[0]?.working_days || 0, month, startDate, endDate });
    }
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/daily-summary
//  Quick stats for a date: present/absent/late/excused counts.
//  Query: date, class_id (optional), entity_type
// ─────────────────────────────────────────────────────────────
const getDailySummary = async (req, res) => {
  try {
    const { date, class_id, entity_type = 'student' } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'date is required' });

    const params = [entity_type, date];
    let classFilter = '';
    if (class_id) { params.push(class_id); classFilter = `AND a.class_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'present')::int  AS present,
         COUNT(*) FILTER (WHERE status = 'absent')::int   AS absent,
         COUNT(*) FILTER (WHERE status = 'late')::int     AS late,
         COUNT(*) FILTER (WHERE status = 'excused')::int  AS excused,
         COUNT(*)::int                                     AS total
       FROM attendance a
       WHERE a.entity_type = $1 AND a.date = $2
         AND a.period_id IS NULL
         ${classFilter}`,
      params
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/export
//  Returns CSV text for monthly attendance.
//  Query: same as getMonthlySummary
// ─────────────────────────────────────────────────────────────
const exportCSV = async (req, res) => {
  try {
    const { entity_type = 'student', class_id, month } = req.query;
    if (!month) return res.status(400).json({ success: false, message: 'month required' });

    // Re-use monthly summary logic inline
    const startDate = `${month}-01`;
    const endDate   = new Date(new Date(startDate).getFullYear(), new Date(startDate).getMonth() + 1, 0)
      .toISOString().slice(0, 10);

    let rows;
    if (entity_type === 'student') {
      if (!class_id) return res.status(400).json({ success: false, message: 'class_id required' });
      ({ rows } = await pool.query(
        `SELECT s.roll_number, s.full_name, s.gender,
                COUNT(a.id) FILTER (WHERE a.status='present')::int  AS present,
                COUNT(a.id) FILTER (WHERE a.status='absent')::int   AS absent,
                COUNT(a.id) FILTER (WHERE a.status='late')::int     AS late,
                COUNT(a.id) FILTER (WHERE a.status='excused')::int  AS excused,
                COUNT(a.id)::int                                     AS total_days,
                ROUND(100.0 * COUNT(a.id) FILTER (WHERE a.status IN ('present','late'))
                  / NULLIF(COUNT(a.id),0), 1)                        AS percentage
         FROM students s
         LEFT JOIN attendance a ON a.entity_type='student' AND a.entity_id=s.id
           AND a.date BETWEEN $2 AND $3 AND a.period_id IS NULL
         WHERE s.class_id=$1
         GROUP BY s.id ORDER BY s.roll_number NULLS LAST, s.full_name`,
        [class_id, startDate, endDate]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT t.full_name, t.subject, t.gender,
                COUNT(a.id) FILTER (WHERE a.status='present')::int  AS present,
                COUNT(a.id) FILTER (WHERE a.status='absent')::int   AS absent,
                COUNT(a.id) FILTER (WHERE a.status='late')::int     AS late,
                COUNT(a.id) FILTER (WHERE a.status='excused')::int  AS excused,
                COUNT(a.id)::int                                     AS total_days,
                ROUND(100.0 * COUNT(a.id) FILTER (WHERE a.status IN ('present','late'))
                  / NULLIF(COUNT(a.id),0), 1)                        AS percentage
         FROM teachers t
         LEFT JOIN attendance a ON a.entity_type='teacher' AND a.entity_id=t.id
           AND a.date BETWEEN $1 AND $2 AND a.period_id IS NULL
         WHERE t.status='active'
         GROUP BY t.id ORDER BY t.full_name`,
        [startDate, endDate]
      ));
    }

    // Build CSV
    const isStudent = entity_type === 'student';
    const headers = isStudent
      ? ['Roll No', 'Full Name', 'Gender', 'Present', 'Absent', 'Late', 'Excused', 'Total Days', 'Attendance %']
      : ['Full Name', 'Subject', 'Gender', 'Present', 'Absent', 'Late', 'Excused', 'Total Days', 'Attendance %'];

    const csvRows = rows.map(r => isStudent
      ? [r.roll_number || '', r.full_name, r.gender || '', r.present, r.absent, r.late, r.excused, r.total_days, r.percentage ?? '—']
      : [r.full_name, r.subject || '', r.gender || '', r.present, r.absent, r.late, r.excused, r.total_days, r.percentage ?? '—']
    );

    const csv = [headers, ...csvRows]
      .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${entity_type}_${month}.csv"`);
    res.send(csv);
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/student/:id/history
//  All attendance records for a student (with optional month filter).
// ─────────────────────────────────────────────────────────────
const getStudentHistory = async (req, res) => {
  try {
    const { month } = req.query;
    const params = [req.params.id];
    let dateFilter = '';
    if (month) {
      const start = `${month}-01`;
      const end   = new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0).toISOString().slice(0,10);
      params.push(start, end);
      dateFilter = `AND date BETWEEN $2 AND $3`;
    }
    const { rows } = await pool.query(
      `SELECT * FROM attendance
       WHERE entity_type='student' AND entity_id=$1 ${dateFilter}
       ORDER BY date DESC, period_id NULLS FIRST`,
      params
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/attendance/register
//  Printable monthly attendance register for a class.
//  Query: class_id, month (YYYY-MM)
//  Returns: class info, students list, all calendar days of month,
//           per-student day-status map, school settings, summary
// ─────────────────────────────────────────────────────────────
const getAttendanceRegister = async (req, res) => {
  try {
    const { class_id, month } = req.query;
    if (!class_id || !month)
      return res.status(400).json({ success: false, message: 'class_id and month (YYYY-MM) required' });

    const startDate = `${month}-01`;
    const d = new Date(startDate);
    const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);

    // Build full calendar days array for the month
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const allDays = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const dd = String(i).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      allDays.push(`${d.getFullYear()}-${mm}-${dd}`);
    }

    // Class info
    const { rows: classRows } = await pool.query(
      `SELECT c.id, c.name, c.grade, c.section, t.full_name AS teacher_name
       FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id
       WHERE c.id = $1`,
      [class_id]
    );
    if (!classRows[0]) return res.status(404).json({ success: false, message: 'Class not found' });

    // Students in class
    const { rows: students } = await pool.query(
      `SELECT id, full_name, roll_number, gender
       FROM students
       WHERE class_id = $1 AND status = 'active'
       ORDER BY roll_number NULLS LAST, full_name`,
      [class_id]
    );

    // All attendance records for this class + month (period_id IS NULL = daily)
    const { rows: records } = await pool.query(
      `SELECT entity_id AS student_id, date, status
       FROM attendance
       WHERE entity_type = 'student' AND class_id = $1
         AND date BETWEEN $2 AND $3
         AND period_id IS NULL
       ORDER BY date`,
      [class_id, startDate, endDate]
    );

    // Build map: studentId → { 'YYYY-MM-DD': 'present'|'absent'|'late'|'excused' }
    const attendanceMap = {};
    students.forEach(s => { attendanceMap[s.id] = {}; });
    records.forEach(r => {
      const sid = r.student_id;
      const dt  = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
      if (attendanceMap[sid] !== undefined) attendanceMap[sid][dt] = r.status;
    });

    // Days where any record exists (working days)
    const markedDays = [...new Set(records.map(r => String(r.date).slice(0, 10)))].sort();

    // Per-student summary
    const studentSummaries = students.map(s => {
      const dayMap = attendanceMap[s.id] || {};
      let present = 0, absent = 0, late = 0, excused = 0;
      markedDays.forEach(dt => {
        const st = dayMap[dt];
        if (st === 'present') present++;
        else if (st === 'absent') absent++;
        else if (st === 'late') late++;
        else if (st === 'excused') excused++;
      });
      const total = present + absent + late + excused;
      const pct   = total > 0 ? Math.round((present + late) / total * 100) : null;
      return { ...s, present, absent, late, excused, total, pct };
    });

    // School settings
    const { rows: settingsRows } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
       ('school_name','school_address','school_phone','school_logo')`
    );
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });

    res.json({
      success: true,
      data: {
        class:       classRows[0],
        month,
        startDate,
        endDate,
        allDays,
        markedDays,
        students:    studentSummaries,
        attendance:  attendanceMap,
        settings,
        working_days: markedDays.length,
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getClassStudentsAttendance,
  getTeachersAttendance,
  bulkMark,
  markSingle,
  updateAttendance,
  deleteAttendance,
  getMonthlySummary,
  getDailySummary,
  exportCSV,
  getStudentHistory,
  getAttendanceRegister,
};
