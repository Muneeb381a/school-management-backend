const express = require('express');
const router  = express.Router();
const {
  getClassStudentsAttendance,
  getTeachersAttendance,
  bulkMark,
  markSingle,
  updateAttendance,
  deleteAttendance,
  getMonthlySummary,
  getDailySummary,
  exportCSV,
  getStudentHistory,
  getAttendanceRegister,
} = require('../controllers/attendanceController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('attendance'));

// Fetch helpers
router.get('/class-students',    requireRole('admin', 'teacher'), getClassStudentsAttendance);
router.get('/teachers-status',   requireRole('admin', 'teacher'), getTeachersAttendance);

// Mark attendance — teachers can mark their own classes
router.post('/bulk',  requireRole('admin', 'teacher'), bulkMark);
router.post('/',      requireRole('admin', 'teacher'), markSingle);

// Edit / Delete — admin only (prevents unauthorized changes)
router.put('/:id',    requireRole('admin'), updateAttendance);
router.delete('/:id', requireRole('admin'), deleteAttendance);

// Reports
router.get('/register',      requireRole('admin', 'teacher'), getAttendanceRegister);
router.get('/monthly',       requireRole('admin', 'teacher'), getMonthlySummary);
router.get('/daily-summary', requireRole('admin', 'teacher'), getDailySummary);
router.get('/export',        requireRole('admin'),            exportCSV);

// Per-student history
router.get('/student/:id/history', requireRole('admin', 'teacher'), getStudentHistory);

module.exports = router;
