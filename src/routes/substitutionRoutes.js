const router = require('express').Router();
const ctrl   = require('../controllers/substitutionController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/summary',    asyncHandler(ctrl.getSummary));
router.get('/today',      asyncHandler(ctrl.getTodaySubstitutions));
router.get('/available',  asyncHandler(ctrl.getAvailableTeachers));
router.get('/',           asyncHandler(ctrl.getSubstitutions));
router.post('/',          requireRole('admin'), asyncHandler(ctrl.createSubstitution));
router.put('/:id',        requireRole('admin'), asyncHandler(ctrl.updateSubstitution));
router.put('/:id/status', requireRole('admin', 'teacher'), asyncHandler(ctrl.updateStatus));
router.delete('/:id',     requireRole('admin'), asyncHandler(ctrl.deleteSubstitution));

module.exports = router;
