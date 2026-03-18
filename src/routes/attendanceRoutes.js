const express = require('express');
const router  = express.Router();
const {
  getClassStudentsAttendance,
  getTeachersAttendance,
  bulkMark,
  markSingle,
  updateAttendance,
  deleteAttendance,
  getMonthlySummary,
  getDailySummary,
  exportCSV,
  getStudentHistory,
  getAttendanceRegister,
} = require('../controllers/attendanceController');

// Fetch helpers (used by Mark Attendance tab)
router.get('/class-students',    getClassStudentsAttendance); // ?class_id&date&period_id
router.get('/teachers-status',   getTeachersAttendance);     // ?date

// Mark
router.post('/bulk',  bulkMark);   // body: { records: [...] }
router.post('/',      markSingle); // body: single record

// Edit / Delete
router.put('/:id',    updateAttendance);
router.delete('/:id', deleteAttendance);

// Reports
router.get('/register',      getAttendanceRegister); // ?class_id&month — printable register
router.get('/monthly',       getMonthlySummary);     // ?entity_type&class_id&month
router.get('/daily-summary', getDailySummary);       // ?entity_type&date&class_id
router.get('/export',        exportCSV);             // ?entity_type&class_id&month

// Per-student history
router.get('/student/:id/history', getStudentHistory); // ?month

module.exports = router;
