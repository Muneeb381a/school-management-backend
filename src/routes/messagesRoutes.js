const router = require('express').Router();
const {
  getRecipients, getConversations, createConversation,
  getMessages, sendMessage, getUnreadCount,
} = require('../controllers/messagesController');
const { requireRole } = require('../middleware/authMiddleware');

// Messages are personal — all authenticated staff can use them
router.get('/conversations',                   requireRole('admin', 'teacher'), getConversations);
router.post('/conversations',                  requireRole('admin', 'teacher'), createConversation);
router.get('/conversations/:id',               requireRole('admin', 'teacher'), getMessages);
router.post('/conversations/:id/messages',     requireRole('admin', 'teacher'), sendMessage);
router.get('/recipients',                      requireRole('admin', 'teacher'), getRecipients);
router.get('/unread-count',                    requireRole('admin', 'teacher'), getUnreadCount);

module.exports = router;
