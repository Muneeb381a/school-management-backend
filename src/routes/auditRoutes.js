const router = require('express').Router();
const ctrl = require('../controllers/auditController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);
router.use(requireRole('admin'));

router.get('/logs',      asyncHandler(ctrl.getLogs));
router.get('/logs/:id',  asyncHandler(ctrl.getLog));
router.get('/summary',   asyncHandler(ctrl.getSummary));

module.exports = router;
