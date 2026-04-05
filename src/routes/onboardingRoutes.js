const router = require('express').Router();
const ctrl = require('../controllers/onboardingController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);
router.use(requireRole('admin'));

router.get('/progress',     asyncHandler(ctrl.getProgress));
router.post('/school-info', asyncHandler(ctrl.saveSchoolInfo));
router.post('/complete',    asyncHandler(ctrl.markComplete));

module.exports = router;
