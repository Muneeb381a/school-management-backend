const express = require('express');
const router  = express.Router();
const { verifyToken: authenticate, requireRole } = require('../middleware/authMiddleware');
const {
  getPapers, createPaper, getPaper, updatePaper, deletePaper,
  updateSection,
  addQuestion, updateQuestion, deleteQuestion,
  getTeacherUsers,
} = require('../controllers/paperController');

router.use(authenticate);

const adminOrTeacher = requireRole('admin', 'teacher');
const adminOnly      = requireRole('admin');

// Teacher user list for assign-teacher dropdown (admin only)
router.get('/teacher-users', adminOnly, getTeacherUsers);

// Papers CRUD
router.get('/',     adminOrTeacher, getPapers);
router.post('/',    adminOrTeacher, createPaper);
router.get('/:id',  adminOrTeacher, getPaper);
router.put('/:id',  adminOrTeacher, updatePaper);
router.delete('/:id', adminOnly,    deletePaper);

// Section update
router.put('/sections/:id', adminOrTeacher, updateSection);

// Questions CRUD
router.post('/sections/:sectionId/questions', adminOrTeacher, addQuestion);
router.put('/questions/:id',    adminOrTeacher, updateQuestion);
router.delete('/questions/:id', adminOrTeacher, deleteQuestion);

module.exports = router;
