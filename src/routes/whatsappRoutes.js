const router = require('express').Router();
const ctrl = require('../controllers/whatsappController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);
router.use(requireRole('admin', 'teacher'));

router.post('/send',    asyncHandler(ctrl.sendMessage));
router.post('/bulk',    asyncHandler(ctrl.sendBulkMessage));
router.get('/logs',     asyncHandler(ctrl.getLogs));
router.get('/stats',    asyncHandler(ctrl.getStats));

module.exports = router;
