const express = require('express');
const router  = express.Router();
const {
  getFeeHeads, createFeeHead, updateFeeHead, deleteFeeHead,
  getFeeStructures, upsertFeeStructure, deleteFeeStructure,
  getInvoices, getInvoice, createInvoice, generateMonthlyFees, generateAdmissionInvoice,
  updateInvoice, cancelInvoice,
  recordPayment, getPayments, voidPayment, bulkRecordPayments,
  getMonthlySummary, getOutstandingBalances, getStudentFeeHistory, exportCSV, getDashboardStats,
  getInvoicePrint, getReceiptPrint, getBulkPrintData, getByClassReport, getDailyReport,
  getConcessions, saveConcession, deleteConcession, applyLateFees,
  getChallanPrint,
  getPaymentImportTemplate, importFeePayments, exportFeesExcel,
  sendFeeReminders,
} = require('../controllers/feeController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const { csvUpload }       = require('../middleware/upload');

router.use(auditMiddleware('fee'));

// Dashboard — admin + teacher can see fee stats
router.get('/dashboard-stats', requireRole('admin', 'teacher'), getDashboardStats);

// Fee Heads — admin only for mutations
router.get('/heads',       requireRole('admin', 'teacher'), getFeeHeads);
router.post('/heads',      requireRole('admin'),            createFeeHead);
router.put('/heads/:id',   requireRole('admin'),            updateFeeHead);
router.delete('/heads/:id',requireRole('admin'),            deleteFeeHead);

// Fee Structures
router.get('/structures',     requireRole('admin', 'teacher'), getFeeStructures);
router.post('/structures',    requireRole('admin'),            upsertFeeStructure);
router.delete('/structures/:id', requireRole('admin'),         deleteFeeStructure);

// Concessions
router.get('/concessions',    requireRole('admin', 'teacher'), getConcessions);
router.post('/concessions',   requireRole('admin'),            saveConcession);
router.delete('/concessions/:id', requireRole('admin'),        deleteConcession);

// Invoices
router.get('/bulk-print',                              requireRole('admin'), getBulkPrintData);
router.post('/invoices/generate-monthly',              requireRole('admin'), generateMonthlyFees);
router.post('/invoices/generate-admission/:studentId', requireRole('admin'), generateAdmissionInvoice);
router.post('/invoices/apply-late-fees',               requireRole('admin'), applyLateFees);
router.get('/invoices/:id/print',                      requireRole('admin', 'teacher'), getInvoicePrint);
router.get('/invoices/:id/challan',                    requireRole('admin', 'teacher'), getChallanPrint);
router.get('/invoices',                                requireRole('admin', 'teacher'), getInvoices);
router.post('/invoices',                               requireRole('admin'),            createInvoice);
router.get('/invoices/:id',                            requireRole('admin', 'teacher'), getInvoice);
router.put('/invoices/:id',                            requireRole('admin'),            updateInvoice);
router.delete('/invoices/:id',                         requireRole('admin'),            cancelInvoice);

// Payment import
router.get('/payments/import/template', requireRole('admin'), getPaymentImportTemplate);
router.post('/payments/import',         requireRole('admin'), csvUpload.single('file'), importFeePayments);

// Payments
router.post('/payments/bulk',          requireRole('admin'),            bulkRecordPayments);
router.get('/payments/:id/receipt',    requireRole('admin', 'teacher'), getReceiptPrint);
router.get('/payments',                requireRole('admin', 'teacher'), getPayments);
router.post('/payments',               requireRole('admin'),            recordPayment);
router.delete('/payments/:id',         requireRole('admin'),            voidPayment);

// Reports
router.get('/reports/monthly-summary', requireRole('admin', 'teacher'), getMonthlySummary);
router.get('/reports/outstanding',     requireRole('admin', 'teacher'), getOutstandingBalances);
router.get('/reports/by-class',        requireRole('admin', 'teacher'), getByClassReport);
router.get('/reports/daily',           requireRole('admin', 'teacher'), getDailyReport);
router.get('/reports/student/:id',     requireRole('admin', 'teacher'), getStudentFeeHistory);
router.get('/export',                  requireRole('admin'),            exportFeesExcel);

// Fee reminders (email + SMS)
router.post('/send-reminders',         requireRole('admin'),            sendFeeReminders);

module.exports = router;
