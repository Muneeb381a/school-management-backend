const router = require('express').Router();
const {
  getRecipients, getConversations, createConversation,
  getMessages, sendMessage, getUnreadCount, flagRequiresMeeting,
} = require('../controllers/messagesController');
const { requireRole } = require('../middleware/authMiddleware');

// All authenticated roles (admin, teacher, parent, student) can use messaging
router.get('/conversations',                   requireRole('admin', 'teacher', 'parent', 'student'), getConversations);
router.post('/conversations',                  requireRole('admin', 'teacher', 'parent', 'student'), createConversation);
router.get('/conversations/:id',               requireRole('admin', 'teacher', 'parent', 'student'), getMessages);
router.post('/conversations/:id/messages',     requireRole('admin', 'teacher', 'parent', 'student'), sendMessage);
router.get('/recipients',                      requireRole('admin', 'teacher', 'parent', 'student'), getRecipients);
router.get('/unread-count',                    requireRole('admin', 'teacher', 'parent', 'student'), getUnreadCount);
// Teacher/admin can flag a thread as "requires meeting"
router.patch('/conversations/:id/flag-meeting', requireRole('admin', 'teacher'), flagRequiresMeeting);

module.exports = router;
