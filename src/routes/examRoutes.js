const express = require('express');
const router = express.Router();
const {
  getExams,
  getExamById,
  createExam,
  updateExam,
  updateExamStatus,
  deleteExam,
  getExamSubjects,
  addExamSubject,
  removeExamSubject,
  getMarks,
  submitMarks,
  deleteMark,
  calculateResults,
  getResults,
  getStudentReportCard,
  getClassRanking,
  getClassReportCards,
  getStudentPerformance,
} = require('../controllers/examController');

// ── Student Performance (must be before /:id to avoid conflict) ──
router.get('/student/:studentId/performance', getStudentPerformance);

// ── Exams CRUD ───────────────────────────────────────────────
// GET    /api/exams                        → list exams (filter: ?academic_year=&status=)
// GET    /api/exams/:id                    → single exam
// POST   /api/exams                        → create exam
// PUT    /api/exams/:id                    → update exam
// PATCH  /api/exams/:id/status             → update status only
// DELETE /api/exams/:id                    → delete exam
router.get('/',                   getExams);
router.get('/:id',                getExamById);
router.post('/',                  createExam);
router.put('/:id',                updateExam);
router.patch('/:id/status',       updateExamStatus);
router.delete('/:id',             deleteExam);

// ── Exam Subjects (marks config per class × subject) ────────
// GET    /api/exams/:examId/subjects       → list configured subjects (filter: ?class_id=)
// POST   /api/exams/:examId/subjects       → add subject(s) to exam
// DELETE /api/exams/subjects/:id           → remove a subject from exam
router.get('/:examId/subjects',   getExamSubjects);
router.post('/:examId/subjects',  addExamSubject);
router.delete('/subjects/:id',    removeExamSubject);

// ── Student Marks ────────────────────────────────────────────
// GET    /api/exams/:examId/marks          → get marks (filter: ?class_id=&student_id=)
// POST   /api/exams/:examId/marks          → submit / update marks (bulk array)
// DELETE /api/exams/marks/:id             → delete a single mark
router.get('/:examId/marks',      getMarks);
router.post('/:examId/marks',     submitMarks);
router.delete('/marks/:id',       deleteMark);

// ── Results ──────────────────────────────────────────────────
// POST   /api/exams/:examId/calculate-results               → compute & store results
// GET    /api/exams/:examId/results                         → all results (filter: ?class_id=)
// GET    /api/exams/:examId/results/student/:studentId      → student report card
// GET    /api/exams/:examId/results/class/:classId/ranking  → class ranking
router.post('/:examId/calculate-results',                      calculateResults);
router.get('/:examId/results',                                 getResults);
router.get('/:examId/results/student/:studentId',              getStudentReportCard);
router.get('/:examId/results/class/:classId/ranking',          getClassRanking);
router.get('/:examId/results/class/:classId/report-cards',     getClassReportCards);

module.exports = router;
