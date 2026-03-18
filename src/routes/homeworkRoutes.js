const express = require('express');
const router  = express.Router();
const { getHomework, getHomeworkById, createHomework, updateHomework, deleteHomework } =
  require('../controllers/homeworkController');

// GET    /api/homework          → list (filter: ?class_id=&subject_id=&status=&due_from=&due_to=)
// POST   /api/homework          → create
// GET    /api/homework/:id      → single
// PUT    /api/homework/:id      → update
// DELETE /api/homework/:id      → delete

router.route('/').get(getHomework).post(createHomework);
router.route('/:id').get(getHomeworkById).put(updateHomework).delete(deleteHomework);

module.exports = router;
