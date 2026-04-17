/**
 * chatController.js
 * Class-based Slack-style chat — REST endpoints.
 * Real-time layer is in chatSocketService.js (Socket.IO).
 *
 * RBAC summary:
 *   admin   → all rooms, all operations
 *   teacher → rooms for their assigned classes, can post to announcements
 *   student → rooms for their class only, cannot post to announcements
 *   parent  → no access (chat is school-internal only)
 */

const db          = require('../db');
const AppError    = require('../utils/AppError');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');

// ── Pagination default ────────────────────────────────────────────────────────
const PAGE_SIZE = 30;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an array of class IDs the user is authorised to access.
 * Admin → null (means "all classes")
 * Teacher → classes from teacher_classes
 * Student → single class from students.class_id
 */
async function getUserClassIds(user) {
  if (user.role === 'admin') return null;

  if (user.role === 'teacher') {
    const { rows } = await db.query(
      `SELECT DISTINCT class_id FROM teacher_classes WHERE teacher_id = $1`,
      [user.entity_id]
    );
    return rows.map(r => r.class_id);
  }

  if (user.role === 'student') {
    const { rows } = await db.query(
      `SELECT class_id FROM students WHERE id = $1`,
      [user.entity_id]
    );
    return rows[0]?.class_id ? [rows[0].class_id] : [];
  }

  return []; // parent / unknown → no access
}

/**
 * Verify user can access a specific room. Throws 403 if not.
 * Returns the room row.
 */
async function assertRoomAccess(roomId, user) {
  const { rows: [room] } = await db.query(
    `SELECT r.*, c.name AS class_name, c.grade, c.section
     FROM chat_rooms r
     JOIN classes c ON c.id = r.class_id
     WHERE r.id = $1 AND r.is_active = true`,
    [roomId]
  );
  if (!room) throw new AppError('Room not found', 404);

  if (user.role === 'admin') return room;

  const classIds = await getUserClassIds(user);
  if (!classIds.includes(room.class_id)) {
    throw new AppError('You do not have access to this room', 403);
  }
  return room;
}

/**
 * Returns true if user can SEND messages to this room.
 * Students are read-only in announcement channels.
 */
function canPost(user, room) {
  if (user.role === 'admin' || user.role === 'teacher') return true;
  if (user.role === 'student' && room.type === 'class_chat') return true;
  return false; // student → announcement = read-only
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/rooms
// List all rooms the current user can access (with unread counts).
// ─────────────────────────────────────────────────────────────────────────────
async function getRooms(req, res) {
  const classIds = await getUserClassIds(req.user);

  let whereClause = 'r.is_active = true';
  const params    = [];

  if (classIds !== null) {
    if (classIds.length === 0) {
      return res.json({ success: true, data: [] });
    }
    params.push(classIds);
    whereClause += ` AND r.class_id = ANY($${params.length})`;
  }

  params.push(req.user.id);
  const userParamIdx = params.length;

  const { rows } = await db.query(
    `SELECT
       r.id, r.class_id, r.type, r.name, r.description, r.created_at,
       c.name  AS class_name,
       c.grade, c.section,
       -- Last message preview
       lm.id          AS last_msg_id,
       lm.content     AS last_msg_content,
       lm.message_type AS last_msg_type,
       lm.created_at  AS last_msg_at,
       lu.name        AS last_msg_sender,
       -- Unread count: messages after the user's last-read pointer
       COALESCE((
         SELECT COUNT(*)::int
         FROM chat_messages cm
         WHERE cm.room_id = r.id
           AND cm.is_deleted = false
           AND cm.id > COALESCE(
             (SELECT last_read_msg_id FROM chat_read_receipts
              WHERE room_id = r.id AND user_id = $${userParamIdx}),
             0
           )
       ), 0) AS unread_count
     FROM chat_rooms r
     JOIN classes c ON c.id = r.class_id
     -- Latest non-deleted message
     LEFT JOIN LATERAL (
       SELECT id, content, message_type, created_at, sender_id
       FROM chat_messages
       WHERE room_id = r.id AND is_deleted = false
       ORDER BY created_at DESC LIMIT 1
     ) lm ON true
     LEFT JOIN users lu ON lu.id = lm.sender_id
     WHERE ${whereClause}
     ORDER BY c.grade, c.section, r.type`,
    params
  );

  res.json({ success: true, data: rows });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/rooms/:roomId
// Single room detail (used when opening a chat window).
// ─────────────────────────────────────────────────────────────────────────────
async function getRoom(req, res) {
  const room = await assertRoomAccess(+req.params.roomId, req.user);
  res.json({ success: true, data: { ...room, can_post: canPost(req.user, room) } });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/rooms/:roomId/messages?before=<id>&limit=30
// Cursor-based pagination — newest first, paginate backwards.
// ─────────────────────────────────────────────────────────────────────────────
async function getMessages(req, res) {
  await assertRoomAccess(+req.params.roomId, req.user);

  const roomId = +req.params.roomId;
  const limit  = Math.min(+req.query.limit  || PAGE_SIZE, 100);
  const before = req.query.before ? +req.query.before : null; // message id cursor

  const params  = [roomId, limit];
  let cursorSql = '';
  if (before) {
    params.push(before);
    cursorSql = `AND m.id < $${params.length}`;
  }
  // Add user id AFTER the optional cursor so its index is always correct
  params.push(req.user.id);
  const userIdx = params.length; // $3 when no cursor, $4 when cursor present

  const { rows } = await db.query(
    `SELECT
       m.id, m.room_id, m.content, m.file_url, m.file_name,
       m.file_size, m.file_type, m.message_type,
       m.is_deleted, m.created_at, m.updated_at,
       m.reply_to_id,
       -- Sender info
       u.id   AS sender_id,
       u.name AS sender_name,
       u.role AS sender_role,
       -- Reply context (just the preview, not recursive)
       rm.content     AS reply_content,
       rm.message_type AS reply_type,
       ru.name        AS reply_sender_name,
       -- Reactions aggregated as JSON [{emoji, count, reacted_by_me}]
       COALESCE((
         SELECT json_agg(x ORDER BY x.emoji)
         FROM (
           SELECT emoji,
                  COUNT(*)::int AS count,
                  BOOL_OR(user_id = $${userIdx}) AS reacted_by_me
           FROM chat_reactions
           WHERE message_id = m.id
           GROUP BY emoji
         ) x
       ), '[]'::json) AS reactions
     FROM chat_messages m
     JOIN users u   ON u.id = m.sender_id
     LEFT JOIN chat_messages rm ON rm.id = m.reply_to_id
     LEFT JOIN users ru         ON ru.id = rm.sender_id
     WHERE m.room_id = $1
       ${cursorSql}
     ORDER BY m.id DESC
     LIMIT $2`,
    params
  );

  // Return in ascending order (oldest at top, like Slack)
  const messages = rows.reverse();
  const hasMore  = rows.length === limit;

  res.json({
    success: true,
    data: {
      messages,
      hasMore,
      nextCursor: hasMore ? messages[0]?.id : null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat/rooms/:roomId/messages
// Send a text message (file uploads go through /upload endpoint first).
// ─────────────────────────────────────────────────────────────────────────────
async function sendMessage(req, res) {
  const room   = await assertRoomAccess(+req.params.roomId, req.user);
  if (!canPost(req.user, room)) {
    throw new AppError('Students cannot post in announcement channels', 403);
  }

  const { content, file_url, file_name, file_size, file_type, message_type = 'text', reply_to_id } = req.body;

  if (!content?.trim() && !file_url) {
    throw new AppError('Message must have content or a file', 400);
  }

  // Validate reply target belongs to same room
  if (reply_to_id) {
    const { rows: [reply] } = await db.query(
      `SELECT id FROM chat_messages WHERE id = $1 AND room_id = $2 AND is_deleted = false`,
      [reply_to_id, room.id]
    );
    if (!reply) throw new AppError('Reply target not found in this room', 400);
  }

  const { rows: [msg] } = await db.query(
    `INSERT INTO chat_messages
       (room_id, sender_id, content, file_url, file_name, file_size, file_type, message_type, reply_to_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      room.id, req.user.id,
      content?.trim() || null,
      file_url   || null, file_name || null,
      file_size  || null, file_type || null,
      message_type, reply_to_id || null,
    ]
  );

  // Full message payload (with sender info) for socket broadcast
  const payload = {
    ...msg,
    sender_name: req.user.name,
    sender_role: req.user.role,
    reactions:   [],
    reply_content: null,
    reply_sender_name: null,
  };

  // Broadcast via Socket.IO to everyone in the room
  const io = req.app.get('io');
  if (io) {
    io.to(`chat:${room.id}`).emit('chat:message', payload);
  }

  res.status(201).json({ success: true, data: payload });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat/rooms/:roomId/upload
// Upload a file attachment → returns {file_url, file_name, file_type, file_size}
// The client then calls sendMessage with these values.
// ─────────────────────────────────────────────────────────────────────────────
async function uploadAttachment(req, res) {
  const room = await assertRoomAccess(+req.params.roomId, req.user);
  if (!canPost(req.user, room)) {
    throw new AppError('You cannot post in this room', 403);
  }
  if (!req.file) throw new AppError('No file uploaded', 400);

  const { buffer, originalname, mimetype, size } = req.file;

  if (size > 10 * 1024 * 1024) throw new AppError('File too large (max 10 MB)', 400);

  const result = await uploadToCloudinary(buffer, `chat/room-${room.id}`, {
    public_id: `${Date.now()}-${originalname.replace(/\s+/g, '_')}`,
  });

  const isImage = mimetype.startsWith('image/');

  res.json({
    success: true,
    data: {
      file_url:     result.secure_url,
      file_name:    originalname,
      file_type:    mimetype,
      file_size:    size,
      message_type: isImage ? 'image' : 'file',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /chat/messages/:id
// Edit own message content (within 15 minutes, text only).
// ─────────────────────────────────────────────────────────────────────────────
async function editMessage(req, res) {
  const msgId  = +req.params.id;
  const { content } = req.body;
  if (!content?.trim()) throw new AppError('Content cannot be empty', 400);

  const { rows: [msg] } = await db.query(
    `SELECT * FROM chat_messages WHERE id = $1 AND is_deleted = false`, [msgId]
  );
  if (!msg) throw new AppError('Message not found', 404);

  // Only sender or admin can edit
  if (msg.sender_id !== req.user.id && req.user.role !== 'admin') {
    throw new AppError('You can only edit your own messages', 403);
  }

  // 15-minute edit window for non-admins
  if (req.user.role !== 'admin') {
    const ageMs = Date.now() - new Date(msg.created_at).getTime();
    if (ageMs > 15 * 60 * 1000) throw new AppError('Messages can only be edited within 15 minutes', 403);
  }

  // Files cannot be edited (only text content)
  if (msg.message_type !== 'text') throw new AppError('Only text messages can be edited', 400);

  // Verify access to the room
  await assertRoomAccess(msg.room_id, req.user);

  const { rows: [updated] } = await db.query(
    `UPDATE chat_messages
     SET content = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [content.trim(), msgId]
  );

  const io = req.app.get('io');
  if (io) {
    io.to(`chat:${msg.room_id}`).emit('chat:message_edited', {
      id: updated.id, room_id: updated.room_id,
      content: updated.content, updated_at: updated.updated_at,
    });
  }

  res.json({ success: true, data: updated });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /chat/messages/:id
// Soft-delete. Own messages (any time) or admin.
// File is removed from Cloudinary too.
// ─────────────────────────────────────────────────────────────────────────────
async function deleteMessage(req, res) {
  const msgId = +req.params.id;

  const { rows: [msg] } = await db.query(
    `SELECT * FROM chat_messages WHERE id = $1`, [msgId]
  );
  if (!msg) throw new AppError('Message not found', 404);

  if (msg.sender_id !== req.user.id && req.user.role !== 'admin') {
    throw new AppError('You can only delete your own messages', 403);
  }

  await assertRoomAccess(msg.room_id, req.user);

  await db.query(
    `UPDATE chat_messages SET is_deleted = true, content = NULL, file_url = NULL, updated_at = NOW()
     WHERE id = $1`,
    [msgId]
  );

  // Remove from Cloudinary (best-effort)
  if (msg.file_url) deleteFromCloudinary(msg.file_url).catch(() => {});

  const io = req.app.get('io');
  if (io) {
    io.to(`chat:${msg.room_id}`).emit('chat:message_deleted', {
      id: msg.id, room_id: msg.room_id,
    });
  }

  res.json({ success: true, message: 'Message deleted' });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat/messages/:id/reactions
// Toggle reaction: adds if not present for this user+emoji, removes if present.
// ─────────────────────────────────────────────────────────────────────────────
async function toggleReaction(req, res) {
  const msgId = +req.params.id;
  const { emoji } = req.body;
  if (!emoji?.trim()) throw new AppError('emoji is required', 400);

  const { rows: [msg] } = await db.query(
    `SELECT * FROM chat_messages WHERE id = $1 AND is_deleted = false`, [msgId]
  );
  if (!msg) throw new AppError('Message not found', 404);
  await assertRoomAccess(msg.room_id, req.user);

  // Check if reaction already exists
  const { rows: [existing] } = await db.query(
    `SELECT id FROM chat_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
    [msgId, req.user.id, emoji]
  );

  let action;
  if (existing) {
    await db.query(`DELETE FROM chat_reactions WHERE id = $1`, [existing.id]);
    action = 'removed';
  } else {
    await db.query(
      `INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)`,
      [msgId, req.user.id, emoji]
    );
    action = 'added';
  }

  // Re-fetch aggregated reactions for the broadcast
  const { rows: reactions } = await db.query(
    `SELECT emoji, COUNT(*)::int AS count,
            BOOL_OR(user_id = $2) AS reacted_by_me
     FROM chat_reactions WHERE message_id = $1
     GROUP BY emoji ORDER BY emoji`,
    [msgId, req.user.id]
  );

  const io = req.app.get('io');
  if (io) {
    io.to(`chat:${msg.room_id}`).emit('chat:reaction', {
      message_id: msgId, room_id: msg.room_id, reactions,
    });
  }

  res.json({ success: true, data: { action, reactions } });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /chat/rooms/:roomId/read
// Mark a room as read up to a given message id (or latest).
// ─────────────────────────────────────────────────────────────────────────────
async function markRead(req, res) {
  const roomId = +req.params.roomId;
  await assertRoomAccess(roomId, req.user);

  // Use provided message_id, or find latest message in room
  let messageId = req.body.message_id ? +req.body.message_id : null;
  if (!messageId) {
    const { rows: [latest] } = await db.query(
      `SELECT id FROM chat_messages WHERE room_id = $1 AND is_deleted = false
       ORDER BY id DESC LIMIT 1`,
      [roomId]
    );
    messageId = latest?.id || null;
  }

  if (!messageId) return res.json({ success: true }); // room is empty

  await db.query(
    `INSERT INTO chat_read_receipts (room_id, user_id, last_read_msg_id, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (room_id, user_id)
     DO UPDATE SET last_read_msg_id = EXCLUDED.last_read_msg_id,
                   last_read_at     = NOW()
     WHERE chat_read_receipts.last_read_msg_id IS NULL
        OR chat_read_receipts.last_read_msg_id < EXCLUDED.last_read_msg_id`,
    [roomId, req.user.id, messageId]
  );

  res.json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/rooms/:roomId/members
// Who can access this room (for showing member count / avatars).
// ─────────────────────────────────────────────────────────────────────────────
async function getRoomMembers(req, res) {
  const room = await assertRoomAccess(+req.params.roomId, req.user);

  const { rows } = await db.query(
    `-- Students in this class
     SELECT u.id, u.name, u.role, 'student' AS member_type
     FROM students s
     JOIN users u ON u.entity_id = s.id AND u.role = 'student' AND u.is_active = true
     WHERE s.class_id = $1

     UNION ALL

     -- Teachers assigned to this class
     SELECT u.id, u.name, u.role, tc.role AS member_type
     FROM teacher_classes tc
     JOIN users u ON u.entity_id = tc.teacher_id AND u.role = 'teacher' AND u.is_active = true
     WHERE tc.class_id = $1

     ORDER BY role, name`,
    [room.class_id]
  );

  res.json({ success: true, data: rows });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/rooms/:roomId/search?q=keyword
// Full-text search within a room (last 30 days).
// ─────────────────────────────────────────────────────────────────────────────
async function searchMessages(req, res) {
  await assertRoomAccess(+req.params.roomId, req.user);

  const q = req.query.q?.trim();
  if (!q || q.length < 2) throw new AppError('Search query must be at least 2 characters', 400);

  const { rows } = await db.query(
    `SELECT m.id, m.content, m.created_at, m.message_type,
            u.name AS sender_name, u.role AS sender_role
     FROM chat_messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1
       AND m.is_deleted = false
       AND m.content ILIKE $2
       AND m.created_at >= NOW() - INTERVAL '30 days'
     ORDER BY m.created_at DESC
     LIMIT 50`,
    [+req.params.roomId, `%${q}%`]
  );

  res.json({ success: true, data: rows });
}

module.exports = {
  getRooms,
  getRoom,
  getMessages,
  sendMessage,
  uploadAttachment,
  editMessage,
  deleteMessage,
  toggleReaction,
  markRead,
  getRoomMembers,
  searchMessages,
};
