const router = require('express').Router();
const ctrl   = require('../controllers/examSeatingController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

// Halls
router.get('/halls',         asyncHandler(ctrl.getHalls));
router.post('/halls',        requireRole('admin'), asyncHandler(ctrl.createHall));
router.put('/halls/:id',     requireRole('admin'), asyncHandler(ctrl.updateHall));
router.delete('/halls/:id',  requireRole('admin'), asyncHandler(ctrl.deleteHall));

// Plans
router.get('/',              asyncHandler(ctrl.getPlans));
router.get('/:id',           asyncHandler(ctrl.getPlan));
router.post('/generate',     requireRole('admin'), asyncHandler(ctrl.generatePlan));
router.delete('/:id',        requireRole('admin'), asyncHandler(ctrl.deletePlan));

module.exports = router;
