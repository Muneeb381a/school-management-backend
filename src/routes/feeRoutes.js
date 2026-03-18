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
} = require('../controllers/feeController');

// Dashboard
router.get('/dashboard-stats', getDashboardStats);

// Fee Heads
router.route('/heads').get(getFeeHeads).post(createFeeHead);
router.route('/heads/:id').put(updateFeeHead).delete(deleteFeeHead);

// Fee Structures
router.route('/structures').get(getFeeStructures).post(upsertFeeStructure);
router.delete('/structures/:id', deleteFeeStructure);

// Concessions
router.route('/concessions').get(getConcessions).post(saveConcession);
router.delete('/concessions/:id', deleteConcession);

// Invoices — static sub-paths BEFORE /:id
router.get('/bulk-print',                              getBulkPrintData);
router.post('/invoices/generate-monthly',              generateMonthlyFees);
router.post('/invoices/generate-admission/:studentId', generateAdmissionInvoice);
router.post('/invoices/apply-late-fees',               applyLateFees);
router.get('/invoices/:id/print',                      getInvoicePrint);
router.get('/invoices/:id/challan',                    getChallanPrint);
router.get('/invoices',                                getInvoices);
router.post('/invoices',                               createInvoice);
router.get('/invoices/:id',                            getInvoice);
router.put('/invoices/:id',                            updateInvoice);
router.delete('/invoices/:id',                         cancelInvoice);

// Payments
router.post('/payments/bulk', bulkRecordPayments);
router.get('/payments/:id/receipt', getReceiptPrint);
router.route('/payments').get(getPayments).post(recordPayment);
router.delete('/payments/:id', voidPayment);

// Reports
router.get('/reports/monthly-summary', getMonthlySummary);
router.get('/reports/outstanding',     getOutstandingBalances);
router.get('/reports/by-class',        getByClassReport);
router.get('/reports/daily',           getDailyReport);
router.get('/reports/student/:id',     getStudentFeeHistory);
router.get('/export',                  exportCSV);

module.exports = router;
