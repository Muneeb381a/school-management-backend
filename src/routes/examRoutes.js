const express = require('express');
const router  = express.Router();
const {
  getExams,
  getExamById,
  createExam,
  updateExam,
  updateExamStatus,
  deleteExam,
  publishResults,
  unpublishResults,
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
  downloadStudentReportCardPDF,
  downloadClassReportCardsPDF,
  getDateSheet,
  updateDateSheet,
} = require('../controllers/examController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('exam'));

// ── Student Performance ───────────────────────────────────────
router.get('/student/:studentId/performance', requireRole('admin', 'teacher'), getStudentPerformance);

// ── Exams CRUD ────────────────────────────────────────────────
router.get('/',              requireRole('admin', 'teacher'), getExams);
router.post('/',             requireRole('admin'),            createExam);
router.get('/:id',           requireRole('admin', 'teacher'), getExamById);
router.put('/:id',           requireRole('admin'),            updateExam);
router.patch('/:id/status',  requireRole('admin'),            updateExamStatus);
router.delete('/:id',        requireRole('admin'),            deleteExam);

// ── Exam Subjects ─────────────────────────────────────────────
router.get('/:examId/subjects',  requireRole('admin', 'teacher'), getExamSubjects);
router.post('/:examId/subjects', requireRole('admin'),            addExamSubject);
router.delete('/subjects/:id',   requireRole('admin'),            removeExamSubject);

// ── Student Marks ─────────────────────────────────────────────
router.get('/:examId/marks',    requireRole('admin', 'teacher'), getMarks);
router.post('/:examId/marks',   requireRole('admin', 'teacher'), submitMarks);   // teachers enter marks
router.delete('/marks/:id',     requireRole('admin'),            deleteMark);

// ── Publish / Unpublish results ───────────────────────────────
router.post('/:examId/publish-results',   requireRole('admin'), publishResults);
router.delete('/:examId/publish-results', requireRole('admin'), unpublishResults);

// ── Date Sheet ────────────────────────────────────────────────
router.get('/:examId/date-sheet',   requireRole('admin', 'teacher'), getDateSheet);
router.patch('/:examId/date-sheet', requireRole('admin'),            updateDateSheet);

// ── Results ───────────────────────────────────────────────────
router.post('/:examId/calculate-results',                  requireRole('admin'),            calculateResults);
router.get('/:examId/results',                             requireRole('admin', 'teacher'), getResults);
router.get('/:examId/results/student/:studentId',              requireRole('admin', 'teacher'), getStudentReportCard);
router.get('/:examId/results/student/:studentId/pdf',          requireRole('admin', 'teacher'), downloadStudentReportCardPDF);
router.get('/:examId/results/class/:classId/ranking',          requireRole('admin', 'teacher'), getClassRanking);
router.get('/:examId/results/class/:classId/report-cards',     requireRole('admin', 'teacher'), getClassReportCards);
router.get('/:examId/results/class/:classId/report-cards/pdf', requireRole('admin', 'teacher'), downloadClassReportCardsPDF);

module.exports = router;
