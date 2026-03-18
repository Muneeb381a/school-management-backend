const express = require('express');
const router = express.Router();
const {
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getClassSubjects,
  assignSubjectToClass,
  removeSubjectFromClass,
  assignTeacherToSubject,
  removeTeacherAssignment,
  getClassSchedule,
  getAllSchedules,
} = require('../controllers/subjectController');

// ── Subjects CRUD ───────────────────────────────────────────
// GET    /api/subjects              → list all subjects
// POST   /api/subjects              → create subject
// PUT    /api/subjects/:id          → update subject
// DELETE /api/subjects/:id          → delete subject
router.get('/',         getSubjects);
router.post('/',        createSubject);
router.put('/:id',      updateSubject);
router.delete('/:id',   deleteSubject);

// ── Class-Subject assignments ───────────────────────────────
// GET    /api/subjects/class/:classId          → subjects of a class (+ assigned teachers)
// POST   /api/subjects/class/:classId          → assign subject to class
// DELETE /api/subjects/class-subject/:id       → remove subject from class
router.get('/class/:classId',         getClassSubjects);
router.post('/class/:classId',        assignSubjectToClass);
router.delete('/class-subject/:id',   removeSubjectFromClass);

// ── Teacher-Subject assignments ─────────────────────────────
// POST   /api/subjects/assign-teacher          → assign / reassign teacher to subject for a class
// DELETE /api/subjects/teacher-assignment/:id  → remove teacher assignment
router.post('/assign-teacher',              assignTeacherToSubject);
router.delete('/teacher-assignment/:id',    removeTeacherAssignment);

// ── Full schedule views ─────────────────────────────────────
// GET /api/subjects/schedule/:classId          → full schedule for one class
// GET /api/subjects/all-schedules              → school-wide schedule
router.get('/all-schedules',          getAllSchedules);
router.get('/schedule/:classId',      getClassSchedule);

module.exports = router;
