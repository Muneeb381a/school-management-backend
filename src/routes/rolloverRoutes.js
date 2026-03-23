const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getRolloverPreview, bulkPromote, activateNewYear, getPromotionHistory,
} = require('../controllers/rolloverController');

router.use(auditMiddleware('rollover'));

router.get('/preview',         requireRole('admin'), getRolloverPreview);
router.post('/promote',        requireRole('admin'), bulkPromote);
router.post('/activate-year',  requireRole('admin'), activateNewYear);
router.get('/history',         requireRole('admin'), getPromotionHistory);

module.exports = router;
