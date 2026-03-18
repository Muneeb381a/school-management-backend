const pool = require('../db');

/* ─────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────── */

/** Return the display name + role of a user row */
async function getUserInfo(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.role, u.username,
            COALESCE(t.full_name, s.full_name, u.username) AS name
     FROM users u
     LEFT JOIN teachers t ON u.role = 'teacher' AND t.id = u.entity_id
     LEFT JOIN students s ON u.role = 'student' AND s.id = u.entity_id
     WHERE u.id = $1`,
    [userId],
  );
  return rows[0] || null;
}

/* ─────────────────────────────────────────────────────────
   GET /api/messages/recipients?q=...
   Search for people the current user can message.
   - parent  → can message teachers + admin
   - teacher → can message parents + admin
   - admin   → can message anyone
───────────────────────────────────────────────────────── */
const getRecipients = async (req, res) => {
  try {
    const { q = '', exclude_self = 'true' } = req.query;
    const callerId   = req.user.id;
    const callerRole = req.user.role;
    const search     = `%${q}%`;

    // Who each role can message:
    //   admin   → everyone
    //   teacher → students, parents, admin, other teachers
    //   parent  → teachers, admin
    //   student → teachers, admin
    let roleFilter = '';
    if (callerRole === 'parent')  roleFilter = `AND u.role IN ('teacher','admin')`;
    if (callerRole === 'student') roleFilter = `AND u.role IN ('teacher','admin')`;

    const { rows } = await pool.query(
      `SELECT u.id, u.role, u.username,
              COALESCE(t.full_name, s.full_name, u.username) AS name,
              COALESCE(t.subject, CONCAT(s.grade, ' ', s.section), '') AS extra
       FROM users u
       LEFT JOIN teachers t ON u.role = 'teacher' AND t.id = u.entity_id
       LEFT JOIN students s ON u.role = 'student'  AND s.id = u.entity_id
       WHERE (
         u.username ILIKE $1
         OR t.full_name ILIKE $1
         OR s.full_name ILIKE $1
       )
       ${roleFilter}
       ${exclude_self === 'true' ? 'AND u.id <> $2' : ''}
       ORDER BY name
       LIMIT 20`,
      exclude_self === 'true' ? [search, callerId] : [search],
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[MESSAGES] getRecipients:', err.message);
    res.status(500).json({ success: false, message: 'Failed to search recipients' });
  }
};

/* ─────────────────────────────────────────────────────────
   GET /api/messages/conversations
   List all conversations the caller participates in,
   with the last message preview + unread count.
───────────────────────────────────────────────────────── */
const getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      `SELECT
         c.id, c.subject, c.updated_at,
         s.full_name AS student_name, s.roll_number,
         -- last message
         lm.body        AS last_message,
         lm.sent_at     AS last_sent_at,
         lu.id          AS last_sender_id,
         COALESCE(lt.full_name, ls.full_name, lu.username) AS last_sender_name,
         -- unread count: messages after participant's last_read_at
         (
           SELECT COUNT(*)::int FROM messages m2
           WHERE m2.conversation_id = c.id
             AND m2.sent_at > COALESCE(cp.last_read_at, '-infinity'::timestamptz)
             AND m2.sender_id <> $1
         ) AS unread_count,
         -- participant list (other participants)
         ARRAY_AGG(DISTINCT
           jsonb_build_object(
             'user_id', pu.id,
             'name', COALESCE(pt.full_name, ps.full_name, pu.username),
             'role', pu.role
           )
         ) FILTER (WHERE pu.id <> $1) AS participants
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id
       JOIN users pu ON pu.id = cp2.user_id
       LEFT JOIN teachers pt ON pu.role = 'teacher' AND pt.id = pu.entity_id
       LEFT JOIN students ps ON pu.role = 'student'  AND ps.id = pu.entity_id
       LEFT JOIN students s  ON s.id = c.student_id
       LEFT JOIN LATERAL (
         SELECT m.body, m.sent_at, m.sender_id
         FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.sent_at DESC
         LIMIT 1
       ) lm ON true
       LEFT JOIN users lu ON lu.id = lm.sender_id
       LEFT JOIN teachers lt ON lu.role = 'teacher' AND lt.id = lu.entity_id
       LEFT JOIN students ls ON lu.role = 'student'  AND ls.id = lu.entity_id
       GROUP BY c.id, c.subject, c.updated_at,
                s.full_name, s.roll_number,
                lm.body, lm.sent_at, lu.id, lt.full_name, ls.full_name, lu.username,
                cp.last_read_at
       ORDER BY c.updated_at DESC`,
      [userId],
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[MESSAGES] getConversations:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load conversations' });
  }
};

/* ─────────────────────────────────────────────────────────
   POST /api/messages/conversations
   Body: { subject, student_id?, recipient_ids: [userId...] }
───────────────────────────────────────────────────────── */
const createConversation = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const senderId   = req.user.id;
    const { subject = 'General', student_id, recipient_ids } = req.body;

    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one recipient required' });
    }

    const { rows: [conv] } = await client.query(
      `INSERT INTO conversations (subject, student_id, created_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [subject, student_id || null, senderId],
    );

    const allParticipants = [...new Set([senderId, ...recipient_ids.map(Number)])];
    for (const uid of allParticipants) {
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [conv.id, uid],
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { id: conv.id }, message: 'Conversation started' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[MESSAGES] createConversation:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create conversation' });
  } finally {
    client.release();
  }
};

/* ─────────────────────────────────────────────────────────
   GET /api/messages/conversations/:id
   Returns conversation header + all messages.
   Also marks all as read.
───────────────────────────────────────────────────────── */
const getMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const convId = parseInt(req.params.id);

    // Check participant
    const { rows: [part] } = await pool.query(
      `SELECT user_id FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2`,
      [convId, userId],
    );
    if (!part) return res.status(403).json({ success: false, message: 'Access denied' });

    // Get conversation header
    const { rows: [conv] } = await pool.query(
      `SELECT c.id, c.subject, c.created_at,
              s.id AS student_id, s.full_name AS student_name, s.roll_number,
              COALESCE(cls.name,'') AS student_class
       FROM conversations c
       LEFT JOIN students s ON s.id = c.student_id
       LEFT JOIN classes cls ON cls.id = s.class_id
       WHERE c.id = $1`,
      [convId],
    );

    // Get participants
    const { rows: participants } = await pool.query(
      `SELECT u.id, u.role,
              COALESCE(t.full_name, s2.full_name, u.username) AS name,
              COALESCE(t.subject, '', '') AS extra
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN teachers t  ON u.role='teacher' AND t.id=u.entity_id
       LEFT JOIN students s2 ON u.role='student'  AND s2.id=u.entity_id
       WHERE cp.conversation_id = $1`,
      [convId],
    );

    // Get messages
    const { rows: messages } = await pool.query(
      `SELECT m.id, m.body, m.sent_at, m.sender_id,
              COALESCE(t.full_name, s.full_name, u.username) AS sender_name,
              u.role AS sender_role
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN teachers t ON u.role='teacher' AND t.id=u.entity_id
       LEFT JOIN students s ON u.role='student'  AND s.id=u.entity_id
       WHERE m.conversation_id = $1
       ORDER BY m.sent_at ASC`,
      [convId],
    );

    // Mark as read
    await pool.query(
      `UPDATE conversation_participants SET last_read_at = NOW()
       WHERE conversation_id=$1 AND user_id=$2`,
      [convId, userId],
    );

    res.json({
      success: true,
      data: { conversation: { ...conv, participants }, messages },
    });
  } catch (err) {
    console.error('[MESSAGES] getMessages:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load messages' });
  }
};

/* ─────────────────────────────────────────────────────────
   POST /api/messages/conversations/:id/messages
   Body: { body }
───────────────────────────────────────────────────────── */
const sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const convId = parseInt(req.params.id);
    const { body } = req.body;

    if (!body?.trim()) {
      return res.status(400).json({ success: false, message: 'Message body required' });
    }

    // Verify participant
    const { rows: [part] } = await pool.query(
      `SELECT user_id FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2`,
      [convId, userId],
    );
    if (!part) return res.status(403).json({ success: false, message: 'Access denied' });

    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, sent_at, sender_id`,
      [convId, userId, body.trim()],
    );

    // Bump conversation updated_at
    await pool.query(
      `UPDATE conversations SET updated_at=NOW() WHERE id=$1`,
      [convId],
    );

    // Mark sender's last_read_at too
    await pool.query(
      `UPDATE conversation_participants SET last_read_at=NOW()
       WHERE conversation_id=$1 AND user_id=$2`,
      [convId, userId],
    );

    const senderInfo = await getUserInfo(userId);

    res.status(201).json({
      success: true,
      data: {
        ...msg,
        sender_name: senderInfo?.name || 'Unknown',
        sender_role: senderInfo?.role || 'admin',
      },
    });
  } catch (err) {
    console.error('[MESSAGES] sendMessage:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
};

/* ─────────────────────────────────────────────────────────
   GET /api/messages/unread-count
   Returns total unread messages across all conversations.
───────────────────────────────────────────────────────── */
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows: [row] } = await pool.query(
      `SELECT COALESCE(SUM(
         (SELECT COUNT(*)::int FROM messages m
          WHERE m.conversation_id = cp.conversation_id
            AND m.sent_at > COALESCE(cp.last_read_at, '-infinity'::timestamptz)
            AND m.sender_id <> $1)
       ), 0)::int AS total
       FROM conversation_participants cp
       WHERE cp.user_id = $1`,
      [userId],
    );
    res.json({ success: true, data: { count: row.total } });
  } catch (err) {
    console.error('[MESSAGES] getUnreadCount:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get unread count' });
  }
};

module.exports = {
  getRecipients,
  getConversations,
  createConversation,
  getMessages,
  sendMessage,
  getUnreadCount,
};
