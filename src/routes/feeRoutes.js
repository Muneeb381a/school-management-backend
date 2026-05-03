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
  getSiblingGroups, getSiblingVoucher,
} = require('../controllers/feeController');

const {
  getLateRules, createLateRule, updateLateRule, deleteLateRule, runLateFeeEngine,
  getFeePolicy, upsertFeePolicy,
  getStudentLedger,
  getRevenueTrend, getClassComparison, getCollectionRate, getForecast, getDefaulterHeatmap,
  getAdjustments, createAdjustment, approveAdjustment, rejectAdjustment,
  getDefaulterActions, addDefaulterAction, getDefaultersList,
  rolloverFeeStructures,
  getCollectionTargets, setCollectionTarget, deleteCollectionTarget,
  getCollectorReport,
  verifyReceipt,
} = require('../controllers/feeAdvancedController');

const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const { csvUpload }       = require('../middleware/upload');
const { recordPaymentValidator, createInvoiceValidator } = require('../middleware/validate');

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
router.post('/invoices',                               requireRole('admin'), createInvoiceValidator, createInvoice);
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
router.post('/payments',               requireRole('admin'), recordPaymentValidator, recordPayment);
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

// Sibling vouchers (read-only, no DB writes)
router.get('/sibling-groups',  requireRole('admin', 'teacher'), getSiblingGroups);
router.get('/sibling-voucher', requireRole('admin', 'teacher'), getSiblingVoucher);

// ── ADVANCED FEE MODULE ────────────────────────────────────────────────────

// Late fee rules engine
router.get('/late-rules',          requireRole('admin'),            getLateRules);
router.post('/late-rules',         requireRole('admin'),            createLateRule);
router.put('/late-rules/:id',      requireRole('admin'),            updateLateRule);
router.delete('/late-rules/:id',   requireRole('admin'),            deleteLateRule);
router.post('/late-rules/run',     requireRole('admin'),            runLateFeeEngine);

// Fee policy (per academic year)
router.get('/policy/:year',        requireRole('admin'),            getFeePolicy);
router.put('/policy/:year',        requireRole('admin'),            upsertFeePolicy);

// Student ledger (bank-statement view)
router.get('/ledger/:studentId',   requireRole('admin', 'teacher'), getStudentLedger);

// Revenue analytics
router.get('/analytics/revenue-trend',    requireRole('admin', 'teacher'), getRevenueTrend);
router.get('/analytics/class-comparison', requireRole('admin', 'teacher'), getClassComparison);
router.get('/analytics/collection-rate',  requireRole('admin', 'teacher'), getCollectionRate);
router.get('/analytics/forecast',         requireRole('admin', 'teacher'), getForecast);
router.get('/analytics/defaulter-heatmap',requireRole('admin', 'teacher'), getDefaulterHeatmap);

// Fee adjustments (waiver / refund / correction)
router.get('/adjustments',              requireRole('admin', 'teacher'), getAdjustments);
router.post('/adjustments',             requireRole('admin', 'teacher'), createAdjustment);
router.post('/adjustments/:id/approve', requireRole('admin'),            approveAdjustment);
router.post('/adjustments/:id/reject',  requireRole('admin'),            rejectAdjustment);

// Defaulter workflow
router.get('/defaulters/list',    requireRole('admin', 'teacher'), getDefaultersList);
router.get('/defaulters/actions', requireRole('admin', 'teacher'), getDefaulterActions);
router.post('/defaulters/actions',requireRole('admin', 'teacher'), addDefaulterAction);

// Per-collector daily report
router.get('/reports/collector', requireRole('admin'), getCollectorReport);

// Annual rollover
router.post('/rollover', requireRole('admin'), rolloverFeeStructures);

// Collection targets
router.get('/targets',        requireRole('admin', 'teacher'), getCollectionTargets);
router.post('/targets',       requireRole('admin'),            setCollectionTarget);
router.delete('/targets/:id', requireRole('admin'),            deleteCollectionTarget);

// Public receipt verification (no auth — for QR scanning)
router.get('/verify-receipt/:receiptNo', verifyReceipt);

module.exports = router;
