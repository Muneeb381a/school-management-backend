const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getSubmissionsForHomework,
  upsertSubmission,
  teacherCheck,
  bulkInitSubmissions,
  getPendingForDashboard,
  getStudentHomeworkHistory,
} = require('../controllers/homeworkSubmissionController');

router.use(auditMiddleware('homework-submissions'));

// Dashboard and student history routes (no :homework_id prefix — must come first)
router.get('/pending-summary',        requireRole('admin', 'teacher'), getPendingForDashboard);
router.get('/student/:id/history',    requireRole('admin', 'teacher', 'student'), getStudentHomeworkHistory);

// Routes with :homework_id prefix
router.get('/:homework_id/submissions',                           requireRole('admin', 'teacher'), getSubmissionsForHomework);
router.post('/:homework_id/submissions/init',                     requireRole('admin', 'teacher'), bulkInitSubmissions);
router.post('/:homework_id/submissions',                          requireRole('admin', 'teacher', 'student'), upsertSubmission);
router.put('/:homework_id/submissions/:student_id/check',         requireRole('admin', 'teacher'), teacherCheck);

module.exports = router;
