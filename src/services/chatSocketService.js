/**
 * chatSocketService.js
 * Socket.IO handler for the Slack-style class chat system.
 *
 * ROOM NAMING:
 *   chat:{roomId}     — all members of a specific chat room
 *   user:{userId}     — personal room (already joined by socketService.js)
 *
 * EVENT CONTRACT
 * ──────────────────────────────────────────────────────────────
 * Client → Server:
 *   chat:join          { roomId }                  join a chat room + get initial messages
 *   chat:leave         { roomId }                  leave a chat room
 *   chat:typing        { roomId }                  start typing indicator
 *   chat:stop_typing   { roomId }                  stop typing indicator
 *
 * Server → Client:
 *   chat:joined        { roomId, messages, canPost, members }
 *   chat:message       { ...messageRow }            new message in room
 *   chat:message_edited { id, room_id, content, updated_at }
 *   chat:message_deleted { id, room_id }
 *   chat:reaction      { message_id, room_id, reactions }
 *   chat:typing        { roomId, userId, userName, role }
 *   chat:stop_typing   { roomId, userId }
 *   chat:presence      { roomId, count }            online member count in room
 *   chat:error         { message }                  non-fatal error
 */

const db     = require('../db');
const logger = require('../utils/logger');

// ── In-memory state ───────────────────────────────────────────────────────────

// Track which socket rooms a user has joined for cleanup on disconnect
// socketId → Set<roomId>
const socketRooms = new Map();

// Typing timers: auto-clear typing indicator if stop_typing never arrives
// `${roomId}:${userId}` → NodeJS.Timeout
const typingTimers = new Map();

// Per-room online presence: roomId → Set<userId>
const roomPresence = new Map();

const TYPING_TIMEOUT_MS = 4_000; // auto-clear after 4 s of silence
const INITIAL_MESSAGES  = 30;    // messages sent on room join

// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns array of class IDs the user is allowed to access.
 * null means "all classes" (admin).
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

  return []; // parent → no access
}

/**
 * Verify user can access the room. Returns room row or null.
 */
async function resolveRoomAccess(roomId, user) {
  const { rows: [room] } = await db.query(
    `SELECT r.id, r.class_id, r.type, r.name, r.is_active
     FROM chat_rooms r WHERE r.id = $1 AND r.is_active = true`,
    [roomId]
  );
  if (!room) return null;
  if (user.role === 'admin') return room;

  const classIds = await getUserClassIds(user);
  if (!classIds || !classIds.includes(room.class_id)) return null;
  return room;
}

/**
 * Returns true if user can send messages to this room type.
 * Students cannot post in announcement channels.
 */
function canPost(user, room) {
  if (user.role === 'admin' || user.role === 'teacher') return true;
  return user.role === 'student' && room.type === 'class_chat';
}

/**
 * Fetch the last N messages for a room (ascending order, ready for display).
 */
async function fetchInitialMessages(roomId, userId, limit = INITIAL_MESSAGES) {
  const { rows } = await db.query(
    `SELECT
       m.id, m.room_id, m.content, m.file_url, m.file_name,
       m.file_size, m.file_type, m.message_type,
       m.is_deleted, m.created_at, m.updated_at, m.reply_to_id,
       u.id   AS sender_id,
       u.name AS sender_name,
       u.role AS sender_role,
       rm.content      AS reply_content,
       rm.message_type AS reply_type,
       ru.name         AS reply_sender_name,
       COALESCE((
         SELECT json_agg(x ORDER BY x.emoji)
         FROM (
           SELECT emoji,
                  COUNT(*)::int AS count,
                  BOOL_OR(user_id = $3) AS reacted_by_me
           FROM chat_reactions WHERE message_id = m.id
           GROUP BY emoji
         ) x
       ), '[]'::json) AS reactions
     FROM chat_messages m
     JOIN users u ON u.id = m.sender_id
     LEFT JOIN chat_messages rm ON rm.id = m.reply_to_id
     LEFT JOIN users ru         ON ru.id = rm.sender_id
     WHERE m.room_id = $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [roomId, limit, userId]
  );
  return rows.reverse(); // oldest → newest
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESENCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function addPresence(roomId, userId) {
  if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Set());
  roomPresence.get(roomId).add(userId);
}

function removePresence(roomId, userId) {
  roomPresence.get(roomId)?.delete(userId);
}

function getPresenceCount(roomId) {
  return roomPresence.get(roomId)?.size ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clearTyping(io, roomId, userId) {
  const key = `${roomId}:${userId}`;
  const timer = typingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    typingTimers.delete(key);
  }
  io.to(`chat:${roomId}`).emit('chat:stop_typing', { roomId, userId });
}

function setTyping(io, socket, roomId) {
  const { user } = socket;
  const key = `${roomId}:${user.id}`;

  // Broadcast to room (exclude sender)
  socket.to(`chat:${roomId}`).emit('chat:typing', {
    roomId,
    userId:   user.id,
    userName: user.name,
    role:     user.role,
  });

  // Reset auto-clear timer
  if (typingTimers.has(key)) clearTimeout(typingTimers.get(key));
  typingTimers.set(key, setTimeout(() => {
    clearTyping(io, roomId, user.id);
  }, TYPING_TIMEOUT_MS));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SETUP — called once per socket connection from socketService.js
// ─────────────────────────────────────────────────────────────────────────────

function setupChatSocket(io, socket) {
  const { user } = socket;

  // Parents have no access to class chat
  if (user.role === 'parent') return;

  // Track joined rooms for this socket
  socketRooms.set(socket.id, new Set());

  // ── chat:join ─────────────────────────────────────────────────────────────
  socket.on('chat:join', async ({ roomId }, ack) => {
    try {
      if (!roomId) return ack?.({ error: 'roomId required' });

      const room = await resolveRoomAccess(roomId, user);
      if (!room) {
        socket.emit('chat:error', { message: 'Room not found or access denied' });
        return ack?.({ error: 'Access denied' });
      }

      // Join the Socket.IO room
      socket.join(`chat:${roomId}`);
      socketRooms.get(socket.id)?.add(roomId);

      // Update presence
      addPresence(roomId, user.id);
      io.to(`chat:${roomId}`).emit('chat:presence', {
        roomId,
        count: getPresenceCount(roomId),
      });

      // Mark as read (user joined, so they've "seen" up to this point)
      const { rows: [latest] } = await db.query(
        `SELECT id FROM chat_messages WHERE room_id=$1 AND is_deleted=false
         ORDER BY id DESC LIMIT 1`, [roomId]
      );
      if (latest) {
        await db.query(
          `INSERT INTO chat_read_receipts (room_id, user_id, last_read_msg_id, last_read_at)
           VALUES ($1,$2,$3,NOW())
           ON CONFLICT (room_id, user_id)
           DO UPDATE SET last_read_msg_id = EXCLUDED.last_read_msg_id,
                         last_read_at     = NOW()
           WHERE chat_read_receipts.last_read_msg_id IS NULL
              OR chat_read_receipts.last_read_msg_id < EXCLUDED.last_read_msg_id`,
          [roomId, user.id, latest.id]
        );
      }

      // Fetch initial message history
      const messages = await fetchInitialMessages(roomId, user.id);

      logger.info({ userId: user.id, roomId, role: user.role }, '[chat] joined room');

      ack?.({
        ok: true,
        messages,
        canPost:  canPost(user, room),
        roomName: room.name,
        roomType: room.type,
        onlineCount: getPresenceCount(roomId),
      });

    } catch (err) {
      logger.error({ err: err.message, userId: user.id, roomId }, '[chat] chat:join error');
      socket.emit('chat:error', { message: 'Failed to join room' });
      ack?.({ error: 'Server error' });
    }
  });

  // ── chat:leave ────────────────────────────────────────────────────────────
  socket.on('chat:leave', ({ roomId }) => {
    if (!roomId) return;
    socket.leave(`chat:${roomId}`);
    socketRooms.get(socket.id)?.delete(roomId);
    removePresence(roomId, user.id);
    clearTyping(io, roomId, user.id);
    io.to(`chat:${roomId}`).emit('chat:presence', {
      roomId, count: getPresenceCount(roomId),
    });
    logger.info({ userId: user.id, roomId }, '[chat] left room');
  });

  // ── chat:typing ───────────────────────────────────────────────────────────
  socket.on('chat:typing', ({ roomId }) => {
    if (!roomId) return;
    // Only broadcast if socket has joined this room
    if (!socketRooms.get(socket.id)?.has(roomId)) return;
    setTyping(io, socket, roomId);
  });

  // ── chat:stop_typing ──────────────────────────────────────────────────────
  socket.on('chat:stop_typing', ({ roomId }) => {
    if (!roomId) return;
    clearTyping(io, roomId, user.id);
  });

  // ── Disconnect: clean up all joined rooms ─────────────────────────────────
  socket.on('disconnect', () => {
    const joined = socketRooms.get(socket.id) ?? new Set();
    for (const roomId of joined) {
      removePresence(roomId, user.id);
      clearTyping(io, roomId, user.id);
      io.to(`chat:${roomId}`).emit('chat:presence', {
        roomId, count: getPresenceCount(roomId),
      });
    }
    socketRooms.delete(socket.id);
    logger.info({ userId: user.id }, '[chat] socket disconnected, rooms cleaned up');
  });
}

module.exports = { setupChatSocket };
