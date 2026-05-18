const router = require('express').Router();
const { getParentFeed, getMyChildren } = require('../controllers/parentFeedController');
const { requireRole } = require('../middleware/authMiddleware');

router.get('/children', requireRole('admin', 'parent'), getMyChildren);
router.get('/',         requireRole('admin', 'teacher', 'parent'), getParentFeed);

module.exports = router;
