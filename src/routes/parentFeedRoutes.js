const router = require('express').Router();
const { getParentFeed } = require('../controllers/parentFeedController');
const { requireRole } = require('../middleware/authMiddleware');

router.get('/', requireRole('admin', 'teacher', 'parent'), getParentFeed);

module.exports = router;
