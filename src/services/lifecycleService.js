/**
 * lifecycleService.js
 * Fire-and-forget event logger for the student lifecycle system.
 *
 * Usage (inside any controller, after the main DB operation succeeds):
 *
 *   logLifecycleEvent({
 *     studentId:   student.id,
 *     eventType:   'fee_paid',
 *     title:       `Fee paid — PKR 5,000`,
 *     description: `Invoice INV-2024-001 cleared via cash`,
 *     metadata:    { invoice_id: 1, amount: 5000, method: 'cash' },
 *     performedBy: req.user.id,
 *   }).catch(() => {});  // ← never let logging crash the response
 *
 * Design principles:
 *   • Non-blocking — always fire-and-forget with .catch(() => {})
 *   • Never throws — catches DB errors internally
 *   • Metadata is free-form JSONB — store whatever context is useful
 */

const db = require('../db');

/**
 * Log a single student lifecycle event.
 * @returns {Promise<number|null>} inserted event ID, or null on failure
 */
async function logLifecycleEvent({
  studentId,
  eventType,
  title,
  description = null,
  metadata    = {},
  performedBy = null,
}) {
  if (!studentId || !eventType || !title) return null;

  try {
    const { rows } = await db.query(
      `INSERT INTO student_lifecycle_events
         (student_id, event_type, title, description, metadata, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        studentId,
        eventType,
        title.substring(0, 250),
        description || null,
        JSON.stringify(metadata),
        performedBy || null,
      ]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // Log to console but never propagate — lifecycle is observability, not business logic
    console.warn(`[lifecycle] Failed to log "${eventType}" for student ${studentId}:`, err.message);
    return null;
  }
}

/**
 * Log lifecycle events for multiple students at once (e.g., bulk promotion).
 * @param {Array<object>} events - array of logLifecycleEvent param objects
 */
async function logLifecycleBatch(events) {
  if (!events?.length) return;

  // Filter out invalid entries
  const valid = events.filter(e => e.studentId && e.eventType && e.title);
  if (!valid.length) return;

  try {
    const rows = valid.map((e, i) => {
      const base = i * 6;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
    });

    const params = valid.flatMap(e => [
      e.studentId,
      e.eventType,
      e.title.substring(0, 250),
      e.description || null,
      JSON.stringify(e.metadata || {}),
      e.performedBy || null,
    ]);

    await db.query(
      `INSERT INTO student_lifecycle_events
         (student_id, event_type, title, description, metadata, performed_by)
       VALUES ${rows.join(',')}`,
      params
    );
  } catch (err) {
    console.warn(`[lifecycle] Batch log failed (${valid.length} events):`, err.message);
  }
}

module.exports = { logLifecycleEvent, logLifecycleBatch };
