const router = require('express').Router();
const ctrl   = require('../controllers/hostelController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/summary',               asyncHandler(ctrl.getSummary));
router.get('/',                      asyncHandler(ctrl.getHostels));
router.post('/',                     requireRole('admin'), asyncHandler(ctrl.createHostel));
router.put('/:id',                   requireRole('admin'), asyncHandler(ctrl.updateHostel));
router.delete('/:id',                requireRole('admin'), asyncHandler(ctrl.deleteHostel));

router.get('/rooms',                 asyncHandler(ctrl.getRooms));
router.post('/rooms',                requireRole('admin'), asyncHandler(ctrl.createRoom));
router.put('/rooms/:id',             requireRole('admin'), asyncHandler(ctrl.updateRoom));
router.delete('/rooms/:id',          requireRole('admin'), asyncHandler(ctrl.deleteRoom));

router.get('/boarders',              asyncHandler(ctrl.getBoarders));
router.post('/boarders',             requireRole('admin'), asyncHandler(ctrl.assignBoarder));
router.put('/boarders/:id/checkout', requireRole('admin'), asyncHandler(ctrl.checkOutBoarder));

module.exports = router;
