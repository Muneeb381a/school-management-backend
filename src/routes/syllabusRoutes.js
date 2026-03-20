const express  = require('express');
const { getTopics, getStats, createTopic, updateTopic, markComplete, deleteTopic } =
  require('../controllers/syllabusController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

const router = express.Router();

router.use(auditMiddleware('syllabus'));

// Teachers manage their own syllabus; admin has full access
router.get('/',               requireRole('admin', 'teacher'), getTopics);
router.get('/stats',          requireRole('admin', 'teacher'), getStats);
router.post('/',              requireRole('admin', 'teacher'), createTopic);
router.put('/:id',            requireRole('admin', 'teacher'), updateTopic);
router.patch('/:id/complete', requireRole('admin', 'teacher'), markComplete);
router.delete('/:id',         requireRole('admin'),            deleteTopic);

module.exports = router;
