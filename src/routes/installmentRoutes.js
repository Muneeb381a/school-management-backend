const router = require('express').Router();
const ctrl   = require('../controllers/installmentController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/',                              asyncHandler(ctrl.getInstallments));
router.get('/upcoming',                      asyncHandler(ctrl.getUpcomingInstallments));
router.get('/overdue',                       asyncHandler(ctrl.getOverdueInstallments));
router.post('/create',   requireRole('admin'), asyncHandler(ctrl.createInstallmentPlan));
router.post('/:id/pay',  requireRole('admin'), asyncHandler(ctrl.payInstallment));
router.delete('/invoice/:invoiceId', requireRole('admin'), asyncHandler(ctrl.deleteInstallmentPlan));

module.exports = router;
