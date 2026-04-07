const router = require('express').Router();
const ctrl   = require('../controllers/disciplineController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/summary',      asyncHandler(ctrl.getSummary));
router.get('/',             asyncHandler(ctrl.getIncidents));
router.get('/:id',          asyncHandler(ctrl.getIncident));
router.post('/',            requireRole('admin', 'teacher'), asyncHandler(ctrl.createIncident));
router.put('/:id',          requireRole('admin', 'teacher'), asyncHandler(ctrl.updateIncident));
router.post('/:id/resolve', requireRole('admin', 'teacher'), asyncHandler(ctrl.resolveIncident));
router.delete('/:id',       requireRole('admin'),            asyncHandler(ctrl.deleteIncident));

module.exports = router;
