const router = require('express').Router();
const {
  getRecipients,
  getConversations,
  createConversation,
  getMessages,
  sendMessage,
  getUnreadCount,
} = require('../controllers/messagesController');

// Inbox & unread
router.get('/conversations',          getConversations);
router.post('/conversations',         createConversation);
router.get('/conversations/:id',      getMessages);
router.post('/conversations/:id/messages', sendMessage);
router.get('/recipients',             getRecipients);
router.get('/unread-count',           getUnreadCount);

module.exports = router;
