const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getQuizzes, getQuizById, createQuiz, updateQuiz, deleteQuiz,
  addQuestion, updateQuestion, deleteQuestion,
  startAttempt, submitAttempt, gradeShortAnswers,
  getAttemptResults, getQuizResults,
} = require('../controllers/quizController');

router.use(auditMiddleware('quizzes'));

// Attempt routes — specific paths before /:id
router.get('/attempts/:id',              requireRole('admin', 'teacher', 'student'), getAttemptResults);
router.put('/attempts/:attempt_id/grade',requireRole('admin', 'teacher'),            gradeShortAnswers);

// Question routes
router.put('/questions/:question_id',    requireRole('admin', 'teacher'), updateQuestion);
router.delete('/questions/:question_id', requireRole('admin', 'teacher'), deleteQuestion);

// Quiz CRUD
router.get('/',       requireRole('admin', 'teacher', 'student'), getQuizzes);
router.post('/',      requireRole('admin', 'teacher'),            createQuiz);
router.get('/:id',    requireRole('admin', 'teacher', 'student'), getQuizById);
router.put('/:id',    requireRole('admin', 'teacher'),            updateQuiz);
router.delete('/:id', requireRole('admin'),                       deleteQuiz);

// Quiz results
router.get('/:id/results', requireRole('admin', 'teacher'), getQuizResults);

// Per-quiz questions
router.post('/:id/questions', requireRole('admin', 'teacher'), addQuestion);

// Attempt actions
router.post('/:id/start',  requireRole('admin', 'teacher', 'student'), startAttempt);
router.post('/:id/submit', requireRole('admin', 'teacher', 'student'), submitAttempt);

module.exports = router;
