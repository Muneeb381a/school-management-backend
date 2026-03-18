const express = require('express');
const router  = express.Router();
const {
  getAnnouncements,
  getActiveAnnouncements,
  getForStudents,
  getForTeachers,
  getRecent,
  getHistory,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  toggleActive,
  deleteAnnouncement,
  markRead,
  getReadStats,
} = require('../controllers/announcementController');

// ── Filtered views (must come BEFORE /:id) ──────────────────
// GET /api/announcements/active          → active + non-expired (?audience=&class_id=)
// GET /api/announcements/for-students    → for students (?class_id=)
// GET /api/announcements/for-teachers    → for teachers
// GET /api/announcements/recent          → latest active (?limit=5)
// GET /api/announcements/history         → all records paginated (?type=&audience=&limit=&offset=)
router.get('/active',       getActiveAnnouncements);
router.get('/for-students', getForStudents);
router.get('/for-teachers', getForTeachers);
router.get('/recent',       getRecent);
router.get('/history',      getHistory);

// ── CRUD ─────────────────────────────────────────────────────
// GET    /api/announcements              → list (?audience=&type=&priority=&class_id=&is_active=&active_only=&search=&limit=&offset=)
// POST   /api/announcements              → create
// GET    /api/announcements/:id          → single
// PUT    /api/announcements/:id          → update
// PATCH  /api/announcements/:id/toggle   → toggle is_active
// DELETE /api/announcements/:id          → hard delete
router.get('/',         getAnnouncements);
router.post('/',        createAnnouncement);
router.get('/:id',      getAnnouncementById);
router.put('/:id',      updateAnnouncement);
router.patch('/:id/toggle', toggleActive);
router.delete('/:id',   deleteAnnouncement);

// ── Read tracking ─────────────────────────────────────────────
// POST /api/announcements/:id/read       → mark as read (body: reader_type, reader_id)
// GET  /api/announcements/:id/reads      → who has read it
router.post('/:id/read',  markRead);
router.get('/:id/reads',  getReadStats);

module.exports = router;
