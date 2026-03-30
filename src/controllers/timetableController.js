const pool  = require('../db');
const cache = require('../utils/cache');
const { serverErr } = require('../utils/serverErr');


// ─────────────────────────────────────────────
//  PERIODS CRUD
// ─────────────────────────────────────────────

// GET /api/timetable/periods
const getPeriods = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM periods ORDER BY period_no, start_time'
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /api/timetable/periods
const createPeriod = async (req, res) => {
  try {
    const { period_no, name, start_time, end_time, is_break } = req.body;
    if (!period_no || !name || !start_time || !end_time) {
      return res.status(400).json({ success: false, message: 'period_no, name, start_time, and end_time are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO periods (period_no, name, start_time, end_time, is_break)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [period_no, name.trim(), start_time, end_time, is_break || false]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Period created' });
  } catch (err) { serverErr(res, err); }
};

// PUT /api/timetable/periods/:id
const updatePeriod = async (req, res) => {
  try {
    const { period_no, name, start_time, end_time, is_break } = req.body;
    const { rows } = await pool.query(
      `UPDATE periods SET period_no=$1, name=$2, start_time=$3, end_time=$4, is_break=$5
       WHERE id=$6 RETURNING *`,
      [period_no, name?.trim(), start_time, end_time, is_break || false, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Period not found' });
    res.json({ success: true, data: rows[0], message: 'Period updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/timetable/periods/:id
const deletePeriod = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM periods WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Period not found' });
    res.json({ success: true, message: 'Period deleted' });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────
//  TIMETABLE ENTRIES
// ─────────────────────────────────────────────

// GET /api/timetable?class_id=X&academic_year=Y
//  Returns timetable grid for a class
const getTimetable = async (req, res) => {
  try {
    const { class_id, academic_year } = req.query;
    if (!class_id) {
      return res.status(400).json({ success: false, message: 'class_id is required' });
    }
    const year = academic_year || '2024-25';
    const cacheKey = `timetable:${class_id}:${year}`;

    const rows = await cache.remember(cacheKey, 600, async () => {
      const { rows } = await pool.query(
        `SELECT
           te.*,
           p.period_no,
           p.name        AS period_name,
           p.start_time,
           p.end_time,
           p.is_break,
           t.full_name   AS teacher_name,
           t.subject     AS teacher_subject
         FROM timetable_entries te
         JOIN periods  p ON p.id = te.period_id
         LEFT JOIN teachers t ON t.id = te.teacher_id
         WHERE te.class_id = $1 AND te.academic_year = $2
         ORDER BY te.day_of_week, p.period_no`,
        [class_id, year]
      );
      return rows;
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /api/timetable/entries  — upsert a single slot
const upsertEntry = async (req, res) => {
  try {
    const { class_id, period_id, day_of_week, teacher_id, subject, room, academic_year } = req.body;
    if (!class_id || !period_id || !day_of_week) {
      return res.status(400).json({ success: false, message: 'class_id, period_id, and day_of_week are required' });
    }
    const year = academic_year || '2024-25';

    // ── Conflict check 1: teacher double-booked ──────────────────────────────
    if (teacher_id) {
      const { rows: teacherConflicts } = await pool.query(
        `SELECT te.id, c.name AS class_name, c.section
         FROM timetable_entries te
         JOIN classes c ON c.id = te.class_id
         WHERE te.teacher_id    = $1
           AND te.period_id     = $2
           AND te.day_of_week   = $3
           AND te.academic_year = $4
           AND te.class_id     != $5`,
        [teacher_id, period_id, day_of_week, year, class_id]
      );
      if (teacherConflicts.length > 0) {
        const clash = teacherConflicts[0];
        return res.status(409).json({
          success: false,
          conflict_type: 'teacher',
          message: `Teacher is already assigned to ${clash.class_name}${clash.section ? ' – ' + clash.section : ''} at this period`,
          conflict: clash,
        });
      }
    }

    // ── Conflict check 2: room double-booked ─────────────────────────────────
    if (room && room.trim()) {
      const { rows: roomConflicts } = await pool.query(
        `SELECT te.id, c.name AS class_name, c.section
         FROM timetable_entries te
         JOIN classes c ON c.id = te.class_id
         WHERE LOWER(te.room)   = LOWER($1)
           AND te.period_id     = $2
           AND te.day_of_week   = $3
           AND te.academic_year = $4
           AND te.class_id     != $5`,
        [room.trim(), period_id, day_of_week, year, class_id]
      );
      if (roomConflicts.length > 0) {
        const clash = roomConflicts[0];
        return res.status(409).json({
          success: false,
          conflict_type: 'room',
          message: `Room "${room}" is already booked by ${clash.class_name}${clash.section ? ' – ' + clash.section : ''} at this period`,
          conflict: clash,
        });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO timetable_entries
         (class_id, period_id, day_of_week, teacher_id, subject, room, academic_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (class_id, period_id, day_of_week, academic_year) DO UPDATE
         SET teacher_id = EXCLUDED.teacher_id,
             subject    = EXCLUDED.subject,
             room       = EXCLUDED.room
       RETURNING *`,
      [class_id, period_id, day_of_week, teacher_id || null, subject || null, room || null, year]
    );
    await cache.del(`timetable:${class_id}:${year}`);
    res.status(201).json({ success: true, data: rows[0], message: 'Timetable slot saved' });
  } catch (err) { serverErr(res, err); }
};

// GET /api/timetable/conflicts?class_id=X&academic_year=Y
//  Returns entries in this class where the teacher is double-booked elsewhere
const getConflicts = async (req, res) => {
  try {
    const { class_id, academic_year } = req.query;
    if (!class_id) return res.json({ success: true, data: [] });
    const year = academic_year || '2024-25';
    const { rows } = await pool.query(
      `SELECT te.id, te.period_id, te.day_of_week, te.teacher_id,
              c2.name AS conflict_class, c2.section AS conflict_section
       FROM timetable_entries te
       JOIN timetable_entries te2
         ON  te2.teacher_id   = te.teacher_id
         AND te2.period_id    = te.period_id
         AND te2.day_of_week  = te.day_of_week
         AND te2.academic_year= te.academic_year
         AND te2.class_id    != te.class_id
       JOIN classes c2 ON c2.id = te2.class_id
       WHERE te.class_id      = $1
         AND te.academic_year = $2
         AND te.teacher_id IS NOT NULL`,
      [class_id, year]
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/timetable/entries/:id
const deleteEntry = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM timetable_entries WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Entry not found' });
    await cache.delPattern('timetable:*');
    res.json({ success: true, message: 'Slot cleared' });
  } catch (err) { serverErr(res, err); }
};

// GET /api/timetable/teacher/:id?academic_year=Y
//  All slots for a teacher across all classes
const getTeacherTimetable = async (req, res) => {
  try {
    const year = req.query.academic_year || '2024-25';
    const { rows } = await pool.query(
      `SELECT
         te.*,
         p.period_no, p.name AS period_name, p.start_time, p.end_time, p.is_break,
         c.name AS class_name, c.grade, c.section
       FROM timetable_entries te
       JOIN periods p ON p.id = te.period_id
       JOIN classes c ON c.id = te.class_id
       WHERE te.teacher_id = $1 AND te.academic_year = $2
       ORDER BY te.day_of_week, p.period_no`,
      [req.params.id, year]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /api/timetable/all?academic_year=Y
//  Returns every entry for every class (for full-school print/export)
const getFullTimetable = async (req, res) => {
  try {
    const year = req.query.academic_year || '2024-25';
    const [entriesRes, periodsRes] = await Promise.all([
      pool.query(
        `SELECT te.*,
                p.period_no, p.name AS period_name, p.start_time, p.end_time, p.is_break,
                t.full_name AS teacher_name,
                c.name AS class_name, c.grade, c.section
         FROM timetable_entries te
         JOIN periods  p ON p.id = te.period_id
         JOIN classes  c ON c.id = te.class_id
         LEFT JOIN teachers t ON t.id = te.teacher_id
         WHERE te.academic_year = $1
         ORDER BY c.grade, c.section, te.day_of_week, p.period_no`,
        [year]
      ),
      pool.query('SELECT * FROM periods ORDER BY period_no, start_time'),
    ]);
    res.json({
      success: true,
      data: { entries: entriesRes.rows, periods: periodsRes.rows },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getPeriods, createPeriod, updatePeriod, deletePeriod,
  getTimetable, upsertEntry, deleteEntry,
  getTeacherTimetable, getFullTimetable, getConflicts,
};
