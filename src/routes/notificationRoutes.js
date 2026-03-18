const express = require('express');
const router  = express.Router();
const {
  getNotifications, getUnreadCount,
  markRead, markAllRead, deleteNotification,
  generateNotifications,
} = require('../controllers/notificationController');

router.get('/',                  getNotifications);
router.get('/unread-count',      getUnreadCount);
router.post('/generate',         generateNotifications);
router.post('/mark-all-read',    markAllRead);
router.patch('/:id/read',        markRead);
router.delete('/:id',            deleteNotification);

module.exports = router;
