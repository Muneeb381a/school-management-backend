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
router.get('/teacher/:id', (req, res, next) => {
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'teacher' && parseInt(req.params.id) === req.user.entity_id) return next();
  res.status(403).json({ success: false, message: 'Access denied' });
}, getTeacherMetrics);
router.get('/financial',  requireRole('admin'),            getFinancialAnalytics);
router.get('/annual',     requireRole('admin'),            getAnnualReport);
router.post('/custom-report', requireRole('admin', 'teacher'), getCustomReport);

module.exports = router;
