const express = require('express');
const router  = express.Router();
const {
  getSalaryStructures, getTeacherSalaryStructure, upsertSalaryStructure,
  getSalaryPayments, generateMonthlySalaries, updateSalaryPayment, markSalaryPaid, getSalarySlip,
  bulkMarkSalaryPaid, exportSalary,
} = require('../controllers/salaryController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('salary'));

// Export (CSV / Excel)
router.get('/export', requireRole('admin'), exportSalary);

// ── Salary Structures — admin only (financial configuration) ──
router.get('/structures',            requireRole('admin'),            getSalaryStructures);
router.get('/structures/:teacherId', requireRole('admin'),            getTeacherSalaryStructure);
router.post('/structures',           requireRole('admin'),            upsertSalaryStructure);

// ── Salary Payments ───────────────────────────────────────────
// Teachers can view their own salary slip; admin can view/manage all
router.get('/payments',                  requireRole('admin'),            getSalaryPayments);
router.post('/payments/generate',        requireRole('admin'),            generateMonthlySalaries);
router.post('/payments/bulk-mark-paid',  requireRole('admin'),            bulkMarkSalaryPaid);
router.get('/payments/:id',              requireRole('admin', 'teacher'), getSalarySlip);   // own slip
router.put('/payments/:id',              requireRole('admin'),            updateSalaryPayment);
router.post('/payments/:id/mark-paid',   requireRole('admin'),            markSalaryPaid);

module.exports = router;
