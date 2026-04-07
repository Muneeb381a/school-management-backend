const router = require('express').Router();
const ctrl   = require('../controllers/complaintController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/summary',        requireRole('admin'), asyncHandler(ctrl.getSummary));
router.get('/',               asyncHandler(ctrl.getComplaints));
router.get('/:id',            asyncHandler(ctrl.getComplaint));
router.post('/',              asyncHandler(ctrl.createComplaint));
router.post('/:id/respond',   asyncHandler(ctrl.addResponse));
router.put('/:id',            requireRole('admin'), asyncHandler(ctrl.updateComplaint));
router.delete('/:id',         requireRole('admin'), asyncHandler(ctrl.deleteComplaint));

module.exports = router;
