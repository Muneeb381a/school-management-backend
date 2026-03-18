const express = require('express');
const router  = express.Router();
const {
  getSalaryStructures, getTeacherSalaryStructure, upsertSalaryStructure,
  getSalaryPayments, generateMonthlySalaries, updateSalaryPayment, markSalaryPaid, getSalarySlip,
  bulkMarkSalaryPaid,
} = require('../controllers/salaryController');

// ── Salary Structures ──────────────────────────────────────────
// GET  /api/salary/structures                   → all structures
// GET  /api/salary/structures/:teacherId        → single teacher
// POST /api/salary/structures                   → create/update (upsert)
router.get('/structures',              getSalaryStructures);
router.get('/structures/:teacherId',   getTeacherSalaryStructure);
router.post('/structures',             upsertSalaryStructure);

// ── Salary Payments ────────────────────────────────────────────
// GET  /api/salary/payments?month=&status=&teacher_id=  → list payments
// POST /api/salary/payments/generate              → generate for a month
// GET  /api/salary/payments/:id                   → single slip
// PUT  /api/salary/payments/:id                   → update (deductions etc.)
// POST /api/salary/payments/:id/mark-paid         → quick mark paid
router.get('/payments',                  getSalaryPayments);
router.post('/payments/generate',        generateMonthlySalaries);
router.post('/payments/bulk-mark-paid',  bulkMarkSalaryPaid);
router.get('/payments/:id',              getSalarySlip);
router.put('/payments/:id',              updateSalaryPayment);
router.post('/payments/:id/mark-paid',   markSalaryPaid);

module.exports = router;
