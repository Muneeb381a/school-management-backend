const express = require('express');
const router  = express.Router();
const {
  getAll, getMy, getOne, create, update, cancel,
  updateStatus, joinClass, getAttendance, getStats,
} = require('../controllers/onlineClassController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('online_class'));

// ── Static paths first (before /:id) ──────────────────────────
router.get('/stats', requireRole('admin'),                          getStats);
router.get('/my',    requireRole('student', 'parent'),              getMy);

// ── Collection ────────────────────────────────────────────────
router.get('/',  requireRole('admin', 'teacher', 'student', 'parent'), getAll);
router.post('/', requireRole('admin', 'teacher'),                       create);

// ── Single resource ───────────────────────────────────────────
router.get('/:id',            requireRole('admin','teacher','student','parent'), getOne);
router.put('/:id',            requireRole('admin', 'teacher'),                   update);
router.delete('/:id',         requireRole('admin', 'teacher'),                   cancel);
router.patch('/:id/status',   requireRole('admin', 'teacher'),                   updateStatus);
router.post('/:id/join',      requireRole('admin','teacher','student','parent'), joinClass);
router.get('/:id/attendance', requireRole('admin', 'teacher'),                   getAttendance);

module.exports = router;
