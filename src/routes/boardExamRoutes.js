const express = require('express');
const router  = express.Router();
const {
  getRegistrations, getRegistration,
  createRegistration, updateRegistration, deleteRegistration,
  getStats,
} = require('../controllers/boardExamController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('board_exam'));

router.get('/stats',  requireRole('admin', 'teacher'), getStats);
router.get('/',       requireRole('admin', 'teacher'), getRegistrations);
router.post('/',      requireRole('admin'),            createRegistration);
router.get('/:id',    requireRole('admin', 'teacher'), getRegistration);
router.put('/:id',    requireRole('admin'),            updateRegistration);
router.delete('/:id', requireRole('admin'),            deleteRegistration);

module.exports = router;
