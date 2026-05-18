const express = require('express');
const router  = express.Router();
const {
  getSalaryStructures, getTeacherSalaryStructure, upsertSalaryStructure,
  getSalaryPayments, generateMonthlySalaries, updateSalaryPayment, markSalaryPaid, getSalarySlip,
  bulkMarkSalaryPaid, exportSalary, getMySlips,
  getSalaryPolicy, updateSalaryPolicy,
  getTaxPreview,
  listAdvances, requestAdvance, approveAdvance, rejectAdvance,
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
router.get('/payments/my',               requireRole('teacher'),          getMySlips);
router.get('/payments/:id',              requireRole('admin', 'teacher'), getSalarySlip);   // own slip
router.put('/payments/:id',              requireRole('admin'),            updateSalaryPayment);
router.post('/payments/:id/mark-paid',   requireRole('admin'),            markSalaryPaid);

// ── Salary Policy ─────────────────────────────────────────────
router.get('/tax-preview', requireRole('admin', 'teacher'), getTaxPreview);
router.get('/policy',     requireRole('admin'), getSalaryPolicy);
router.put('/policy',     requireRole('admin'), updateSalaryPolicy);

// ── Salary Advances ────────────────────────────────────────────
router.get ('/advances',              requireRole('admin'),            listAdvances);
router.post('/advances',              requireRole('admin'),            requestAdvance);
router.patch('/advances/:id/approve', requireRole('admin'),            approveAdvance);
router.patch('/advances/:id/reject',  requireRole('admin'),            rejectAdvance);

module.exports = router;
