const express = require('express');
const router  = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  getStudentTimeline,
  getTimelineSummary,
  addManualNote,
  getRecentEvents,
} = require('../controllers/lifecycleController');

router.use(verifyToken);

// Admin-only: recent events across all students
router.get('/recent', requireRole('admin', 'teacher'), getRecentEvents);

// Per-student routes (student/parent/admin/teacher)
router.get('/:studentId',         getStudentTimeline);
router.get('/:studentId/summary', getTimelineSummary);
router.post('/:studentId/note',   requireRole('admin', 'teacher'), addManualNote);

module.exports = router;
