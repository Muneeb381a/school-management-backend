const express = require('express');
const router  = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const {
  getStudentPlan, assignTopic, updateTopic,
  completeTopic, deleteTopic, getClassPlan,
} = require('../controllers/studyPlannerController');

// Student or admin/teacher can view a student's plan
router.get('/student/:studentId', requireRole('admin', 'teacher', 'student'), getStudentPlan);

// Teacher view: topics for a whole class
router.get('/class/:classId', requireRole('admin', 'teacher'), getClassPlan);

// Teacher assigns / updates / deletes topics
router.post('/',        requireRole('admin', 'teacher'), assignTopic);
router.patch('/:id',    requireRole('admin', 'teacher'), updateTopic);
router.delete('/:id',   requireRole('admin', 'teacher'), deleteTopic);

// Student (or teacher) marks complete / incomplete
router.patch('/:id/complete', requireRole('admin', 'teacher', 'student'), completeTopic);

module.exports = router;
