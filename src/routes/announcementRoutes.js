const express = require('express');
const router  = express.Router();
const {
  getAnnouncements, getActiveAnnouncements, getForStudents, getForTeachers,
  getRecent, getHistory, getAnnouncementById,
  createAnnouncement, updateAnnouncement, toggleActive, deleteAnnouncement,
  markRead, getReadStats, sendEmail,
} = require('../controllers/announcementController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('announcement'));

// Filtered views — all staff can read announcements
router.get('/active',       requireRole('admin', 'teacher'), getActiveAnnouncements);
router.get('/for-students', requireRole('admin', 'teacher'), getForStudents);
router.get('/for-teachers', requireRole('admin', 'teacher'), getForTeachers);
router.get('/recent',       requireRole('admin', 'teacher'), getRecent);
router.get('/history',      requireRole('admin', 'teacher'), getHistory);

// CRUD — admin manages; teachers read
router.get('/',         requireRole('admin', 'teacher'), getAnnouncements);
router.post('/',        requireRole('admin'),            createAnnouncement);
router.get('/:id',      requireRole('admin', 'teacher'), getAnnouncementById);
router.put('/:id',      requireRole('admin'),            updateAnnouncement);
router.patch('/:id/toggle', requireRole('admin'),        toggleActive);
router.delete('/:id',   requireRole('admin'),            deleteAnnouncement);

// Email broadcast — admin only
router.post('/:id/send-email', requireRole('admin'), sendEmail);

// Read tracking — all staff can mark as read
router.post('/:id/read', requireRole('admin', 'teacher'), markRead);
router.get('/:id/reads', requireRole('admin'),            getReadStats);

module.exports = router;
