const express = require('express');
const router  = express.Router();
const {
  getHomework, getHomeworkById, createHomework, updateHomework, deleteHomework,
} = require('../controllers/homeworkController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('homework'));

// Teachers create/manage homework; admin has full access
router.get('/',    requireRole('admin', 'teacher'), getHomework);
router.post('/',   requireRole('admin', 'teacher'), createHomework);
router.get('/:id', requireRole('admin', 'teacher'), getHomeworkById);
router.put('/:id', requireRole('admin', 'teacher'), updateHomework);
router.delete('/:id', requireRole('admin'),         deleteHomework);

module.exports = router;
