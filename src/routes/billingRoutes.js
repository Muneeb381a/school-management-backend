const router = require('express').Router();
const ctrl = require('../controllers/billingController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

// Public — list plans (no auth needed for marketing pages)
router.get('/plans', asyncHandler(ctrl.getPlans));

router.use(verifyToken);
router.use(requireRole('admin'));

router.get('/subscription', asyncHandler(ctrl.getSubscription));
router.get('/payments',     asyncHandler(ctrl.getPayments));
router.post('/upgrade',     asyncHandler(ctrl.requestUpgrade));

module.exports = router;
