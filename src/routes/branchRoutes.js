const router = require('express').Router();
const ctrl   = require('../controllers/branchController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/',                              asyncHandler(ctrl.getBranches));
router.get('/:id',                           asyncHandler(ctrl.getBranch));
router.post('/',          requireRole('admin'), asyncHandler(ctrl.createBranch));
router.put('/:id',        requireRole('admin'), asyncHandler(ctrl.updateBranch));
router.delete('/:id',     requireRole('admin'), asyncHandler(ctrl.deleteBranch));
router.put('/:entity/:id/branch', requireRole('admin'), asyncHandler(ctrl.assignToBranch));

module.exports = router;
