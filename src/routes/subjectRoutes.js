const express = require('express');
const router  = express.Router();
const {
  getSubjects, createSubject, updateSubject, deleteSubject,
  getClassSubjects, assignSubjectToClass, removeSubjectFromClass,
  assignTeacherToSubject, removeTeacherAssignment,
  getClassSchedule, getAllSchedules,
} = require('../controllers/subjectController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('subject'));

// Subjects CRUD
router.get('/',         requireRole('admin', 'teacher'), getSubjects);
router.post('/',        requireRole('admin'),            createSubject);
router.put('/:id',      requireRole('admin'),            updateSubject);
router.delete('/:id',   requireRole('admin'),            deleteSubject);

// Class-Subject assignments
router.get('/class/:classId',       requireRole('admin', 'teacher'), getClassSubjects);
router.post('/class/:classId',      requireRole('admin'),            assignSubjectToClass);
router.delete('/class-subject/:id', requireRole('admin'),            removeSubjectFromClass);

// Teacher-Subject assignments
router.post('/assign-teacher',           requireRole('admin'), assignTeacherToSubject);
router.delete('/teacher-assignment/:id', requireRole('admin'), removeTeacherAssignment);

// Schedule views
router.get('/all-schedules',      requireRole('admin', 'teacher'), getAllSchedules);
router.get('/schedule/:classId',  requireRole('admin', 'teacher'), getClassSchedule);

module.exports = router;
