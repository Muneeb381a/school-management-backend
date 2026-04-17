/**
 * lifecycleController.js
 * REST handlers for the student lifecycle timeline.
 *
 * GET  /lifecycle/:studentId          → paginated timeline for one student
 * GET  /lifecycle/:studentId/summary  → counts per event type
 * POST /lifecycle/:studentId/note     → admin adds a manual note
 * GET  /lifecycle/recent              → latest events across all students (admin widget)
 */

const db       = require('../db');
const AppError = require('../utils/AppError');
const { logLifecycleEvent } = require('../services/lifecycleService');

// ── GET /lifecycle/:studentId ─────────────────────────────────────────────────
async function getStudentTimeline(req, res) {
  const { studentId } = req.params;
  const { types, search, limit = 50, offset = 0 } = req.query;

  // Verify student exists
  const { rows: [student] } = await db.query(
    `SELECT id, full_name, admission_number, grade, section, status, class_id,
            admission_date,
            (SELECT name FROM classes WHERE id = students.class_id LIMIT 1) AS class_name
     FROM students WHERE id = $1 AND deleted_at IS NULL`,
    [studentId]
  );
  if (!student) throw new AppError('Student not found', 404);

  // Role guard: students can only see their own timeline
  const { user } = req;
  if (user.role === 'student' && user.entity_id !== +studentId) {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }
  if (user.role === 'parent' && user.entity_id !== +studentId) {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }

  // Build filter conditions
  const conditions = ['e.student_id = $1'];
  const params     = [studentId];

  if (types) {
    const typeList = types.split(',').map(t => t.trim()).filter(Boolean);
    if (typeList.length) {
      params.push(typeList);
      conditions.push(`e.event_type = ANY($${params.length})`);
    }
  }

  if (search?.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(e.title ILIKE $${params.length} OR e.description ILIKE $${params.length})`);
  }

  const where = conditions.join(' AND ');
  params.push(+limit, +offset);

  const { rows: events } = await db.query(
    `SELECT e.id, e.event_type, e.title, e.description, e.metadata, e.created_at,
            u.name AS performed_by_name
     FROM student_lifecycle_events e
     LEFT JOIN users u ON u.id = e.performed_by
     WHERE ${where}
     ORDER BY e.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const { rows: [{ total }] } = await db.query(
    `SELECT COUNT(*)::INT AS total FROM student_lifecycle_events e WHERE ${where}`,
    params.slice(0, -2)
  );

  res.json({
    success: true,
    data: { student, events, total, limit: +limit, offset: +offset },
  });
}

// ── GET /lifecycle/:studentId/summary ─────────────────────────────────────────
async function getTimelineSummary(req, res) {
  const { studentId } = req.params;

  const { rows: [student] } = await db.query(
    `SELECT id, full_name, admission_number FROM students WHERE id = $1 AND deleted_at IS NULL`,
    [studentId]
  );
  if (!student) throw new AppError('Student not found', 404);

  const { rows: counts } = await db.query(
    `SELECT event_type, COUNT(*)::INT AS count
     FROM student_lifecycle_events WHERE student_id = $1
     GROUP BY event_type ORDER BY count DESC`,
    [studentId]
  );

  const { rows: [{ total }] } = await db.query(
    `SELECT COUNT(*)::INT AS total FROM student_lifecycle_events WHERE student_id = $1`,
    [studentId]
  );

  const { rows: [latest] } = await db.query(
    `SELECT event_type, title, created_at FROM student_lifecycle_events
     WHERE student_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [studentId]
  );

  res.json({ success: true, data: { student, counts, total, latest } });
}

// ── POST /lifecycle/:studentId/note ──────────────────────────────────────────
async function addManualNote(req, res) {
  const { studentId } = req.params;
  const { title, description } = req.body;
  if (!title?.trim()) throw new AppError('title is required', 400);

  const { rows: [student] } = await db.query(
    `SELECT id, full_name FROM students WHERE id = $1 AND deleted_at IS NULL`,
    [studentId]
  );
  if (!student) throw new AppError('Student not found', 404);

  const id = await logLifecycleEvent({
    studentId: +studentId,
    eventType:   'manual_note',
    title:       title.trim(),
    description: description?.trim() || null,
    metadata:    { added_by_role: req.user.role },
    performedBy: req.user.id,
  });

  const { rows: [event] } = await db.query(
    `SELECT e.*, u.name AS performed_by_name
     FROM student_lifecycle_events e LEFT JOIN users u ON u.id = e.performed_by
     WHERE e.id = $1`,
    [id]
  );

  res.status(201).json({ success: true, data: event });
}

// ── GET /lifecycle/recent ─────────────────────────────────────────────────────
// Admin widget: last N lifecycle events across ALL students.
async function getRecentEvents(req, res) {
  const { limit = 20 } = req.query;

  const { rows } = await db.query(
    `SELECT e.id, e.student_id, e.event_type, e.title, e.created_at,
            s.full_name AS student_name, s.admission_number,
            u.name AS performed_by_name
     FROM student_lifecycle_events e
     JOIN students s ON s.id = e.student_id
     LEFT JOIN users u ON u.id = e.performed_by
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [Math.min(+limit, 100)]
  );

  res.json({ success: true, data: rows });
}

module.exports = {
  getStudentTimeline,
  getTimelineSummary,
  addManualNote,
  getRecentEvents,
};
