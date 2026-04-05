const router = require('express').Router();
const ctrl = require('../controllers/timetableGeneratorController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);
router.use(requireRole('admin'));

router.post('/generate', asyncHandler(ctrl.generate));
router.post('/save',     asyncHandler(ctrl.saveGenerated));

module.exports = router;
