const express = require('express');
const router  = express.Router();
const { getStats, getFullDashboard, getTeacherDashboard, getStudentDashboard, getParentDashboard } = require('../controllers/dashboardController');
const { requireRole } = require('../middleware/authMiddleware');

router.get('/stats',   requireRole('admin', 'teacher'), getStats);
router.get('/full',    requireRole('admin'), getFullDashboard);
router.get('/teacher', requireRole('teacher', 'admin'), getTeacherDashboard);
router.get('/student', requireRole('student', 'admin'), getStudentDashboard);
router.get('/parent',  requireRole('parent',  'admin'), getParentDashboard);

module.exports = router;
