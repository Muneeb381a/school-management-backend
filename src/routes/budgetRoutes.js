const router = require('express').Router();
const ctrl   = require('../controllers/budgetController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/summary',                  asyncHandler(ctrl.getSummary));
router.get('/',                         asyncHandler(ctrl.getPlans));
router.get('/:id',                      asyncHandler(ctrl.getPlan));
router.post('/',        requireRole('admin'), asyncHandler(ctrl.createPlan));
router.put('/:id',      requireRole('admin'), asyncHandler(ctrl.updatePlan));
router.post('/:id/approve', requireRole('admin'), asyncHandler(ctrl.approvePlan));
router.delete('/:id',   requireRole('admin'), asyncHandler(ctrl.deletePlan));

router.post('/:planId/items',        requireRole('admin'), asyncHandler(ctrl.createItem));
router.put('/:planId/items/:itemId', requireRole('admin'), asyncHandler(ctrl.updateItem));
router.delete('/:planId/items/:itemId', requireRole('admin'), asyncHandler(ctrl.deleteItem));

module.exports = router;
