const express = require('express');
const router  = express.Router();
const {
  getPeriods, createPeriod, updatePeriod, deletePeriod,
  getTimetable, upsertEntry, deleteEntry,
  getTeacherTimetable, getFullTimetable, getConflicts,
} = require('../controllers/timetableController');

// Period management
router.route('/periods')
  .get(getPeriods)
  .post(createPeriod);

router.route('/periods/:id')
  .put(updatePeriod)
  .delete(deletePeriod);

// Static paths BEFORE parameterized routes
router.get('/all',         getFullTimetable);   // full school (all classes)
router.get('/teacher/:id', getTeacherTimetable);

// Conflict detection
router.get('/conflicts', getConflicts);

// Timetable entries
router.get('/',               getTimetable);      // ?class_id=X
router.post('/entries',       upsertEntry);
router.delete('/entries/:id', deleteEntry);

module.exports = router;
