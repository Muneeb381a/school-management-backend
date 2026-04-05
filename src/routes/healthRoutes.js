const router = require('express').Router();
const ctrl = require('../controllers/healthController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

// Public endpoints (no auth)
router.get('/',      asyncHandler(ctrl.liveness));
router.get('/ready', asyncHandler(ctrl.readiness));

// Admin-only
router.get('/metrics', verifyToken, requireRole('admin'), asyncHandler(ctrl.getMetrics));
router.get('/info',    verifyToken, requireRole('admin'), asyncHandler(ctrl.getInfo));

module.exports = router;
