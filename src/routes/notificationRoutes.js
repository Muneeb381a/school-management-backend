const express = require('express');
const router  = express.Router();
const {
  getNotifications, getUnreadCount,
  markRead, markAllRead, deleteNotification,
  generateNotifications,
} = require('../controllers/notificationController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('notification'));

router.get('/',               requireRole('admin', 'teacher'), getNotifications);
router.get('/unread-count',   requireRole('admin', 'teacher'), getUnreadCount);
router.post('/generate',      requireRole('admin'),            generateNotifications);
router.post('/mark-all-read', requireRole('admin', 'teacher'), markAllRead);
router.patch('/:id/read',     requireRole('admin', 'teacher'), markRead);
router.delete('/:id',         requireRole('admin'),            deleteNotification);

module.exports = router;
