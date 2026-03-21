const express = require('express');
const router  = express.Router();
const {
  getClassAnalytics,
  getTeacherMetrics,
  getFinancialAnalytics,
  getAnnualReport,
  getCustomReport,
} = require('../controllers/analyticsController');
const { requireRole } = require('../middleware/authMiddleware');

router.get('/class/:id',  requireRole('admin', 'teacher'), getClassAnalytics);
router.get('/teacher/:id',requireRole('admin'),            getTeacherMetrics);
router.get('/financial',  requireRole('admin'),            getFinancialAnalytics);
router.get('/annual',     requireRole('admin'),            getAnnualReport);
router.post('/custom-report', requireRole('admin', 'teacher'), getCustomReport);

module.exports = router;
