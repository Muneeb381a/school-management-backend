const express = require('express');
const router  = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const {
  getStaff, getStaffById, createStaff, updateStaff, deleteStaff,
  getAttendance, bulkAttendance,
  getSalaryPayments, generateSalaries, updateSalaryPayment,
  getDepartments,
} = require('../controllers/staffController');

// Staff CRUD
router.get('/',            requireRole('admin'), getStaff);
router.get('/departments', requireRole('admin'), getDepartments);
router.get('/:id',         requireRole('admin'), getStaffById);
router.post('/',           requireRole('admin'), createStaff);
router.put('/:id',         requireRole('admin'), updateStaff);
router.delete('/:id',      requireRole('admin'), deleteStaff);

// Attendance
router.get('/:id/attendance',   requireRole('admin'), getAttendance);
router.post('/attendance/bulk', requireRole('admin'), bulkAttendance);

// Salary
router.get('/salary/list',      requireRole('admin'), getSalaryPayments);
router.post('/salary/generate', requireRole('admin'), generateSalaries);
router.put('/salary/:id',       requireRole('admin'), updateSalaryPayment);

module.exports = router;
