const express = require('express');
const router  = express.Router();
const {
  getPeriods, createPeriod, updatePeriod, deletePeriod,
  getTimetable, upsertEntry, deleteEntry,
  getTeacherTimetable, getFullTimetable, getConflicts,
} = require('../controllers/timetableController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('timetable'));

// Period management — admin configures bell schedule
router.get('/periods',      requireRole('admin', 'teacher'), getPeriods);
router.post('/periods',     requireRole('admin'),            createPeriod);
router.put('/periods/:id',  requireRole('admin'),            updatePeriod);
router.delete('/periods/:id', requireRole('admin'),          deletePeriod);

// Static paths BEFORE parameterized routes
router.get('/all',         requireRole('admin', 'teacher'), getFullTimetable);
router.get('/teacher/:id', requireRole('admin', 'teacher'), getTeacherTimetable);

// Conflict detection
router.get('/conflicts', requireRole('admin', 'teacher'), getConflicts);

// Timetable entries
router.get('/',               requireRole('admin', 'teacher'), getTimetable);
router.post('/entries',       requireRole('admin'),            upsertEntry);
router.delete('/entries/:id', requireRole('admin'),            deleteEntry);

module.exports = router;
