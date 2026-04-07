/**
 * chatRoutes.js
 * All routes are protected by verifyToken (applied globally in index.js).
 * Parents are blocked here via requireNotParent middleware.
 *
 * Rate limits:
 *  - Sending messages: 60/min per user (prevents spam)
 *  - File uploads:     20/min per user
 */

const router       = require('express').Router();
const { rateLimit } = require('express-rate-limit');
const asyncHandler  = require('../utils/asyncHandler');
const chatUpload    = require('../middleware/chatUpload');
const ctrl          = require('../controllers/chatController');
const AppError      = require('../utils/AppError');

// ── Rate limiters scoped to chat ──────────────────────────────────────────────
const msgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `chat_msg_${req.user?.id}`,
  message: { success: false, message: 'Slow down — max 60 messages per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => `chat_upload_${req.user?.id}`,
  message: { success: false, message: 'Too many file uploads. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Block parents from chat entirely ─────────────────────────────────────────
// (Chat is school-internal: students ↔ teachers ↔ admin)
function requireNotParent(req, _res, next) {
  if (req.user?.role === 'parent') {
    return next(new AppError('Parents do not have access to class chat', 403));
  }
  next();
}

router.use(requireNotParent);

// ── Rooms ─────────────────────────────────────────────────────────────────────
router.get  ('/rooms',                  asyncHandler(ctrl.getRooms));
router.get  ('/rooms/:roomId',          asyncHandler(ctrl.getRoom));
router.get  ('/rooms/:roomId/members',  asyncHandler(ctrl.getRoomMembers));
router.get  ('/rooms/:roomId/search',   asyncHandler(ctrl.searchMessages));

// ── Messages ──────────────────────────────────────────────────────────────────
router.get  ('/rooms/:roomId/messages', asyncHandler(ctrl.getMessages));
router.post ('/rooms/:roomId/messages', msgLimiter,    asyncHandler(ctrl.sendMessage));

// ── File upload (returns URL, client then calls sendMessage with it) ──────────
router.post (
  '/rooms/:roomId/upload',
  uploadLimiter,
  chatUpload.single('file'),
  asyncHandler(ctrl.uploadAttachment)
);

// ── Message actions ───────────────────────────────────────────────────────────
router.put   ('/messages/:id',            asyncHandler(ctrl.editMessage));
router.delete('/messages/:id',            asyncHandler(ctrl.deleteMessage));
router.post  ('/messages/:id/reactions',  asyncHandler(ctrl.toggleReaction));

// ── Read receipts ─────────────────────────────────────────────────────────────
router.put  ('/rooms/:roomId/read',       asyncHandler(ctrl.markRead));

module.exports = router;
