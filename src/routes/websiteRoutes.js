const router  = require('express').Router();
const ctrl    = require('../controllers/websiteController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

// Public endpoint — no auth required (for rendering the public school website)
router.get('/public', asyncHandler(ctrl.getConfig));

router.use(verifyToken);

router.get('/config',           asyncHandler(ctrl.getConfig));
router.put('/config',           requireRole('admin'), asyncHandler(ctrl.updateConfig));
router.post('/publish',         requireRole('admin'), asyncHandler(ctrl.togglePublish));

router.get('/sections',         asyncHandler(ctrl.getSections));
router.post('/sections',        requireRole('admin'), asyncHandler(ctrl.createSection));
router.put('/sections/:id',     requireRole('admin'), asyncHandler(ctrl.updateSection));
router.delete('/sections/:id',  requireRole('admin'), asyncHandler(ctrl.deleteSection));

module.exports = router;
