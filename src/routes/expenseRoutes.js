const express = require('express');
const router  = express.Router();
const {
  getCategories, createCategory, updateCategory,
  getExpenses, getExpenseById, createExpense, updateExpense, deleteExpense,
  getMonthlyReport, getYearlyReport, getByCategoryReport, getSummary,
  getImportTemplate, importExpenses, exportExpenses,
} = require('../controllers/expenseController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const { csvUpload }       = require('../middleware/upload');
const { createExpenseValidator } = require('../middleware/validate');

router.use(auditMiddleware('expense'));

// Import / Export
router.get('/import/template', requireRole('admin'), getImportTemplate);
router.post('/import',         requireRole('admin'), csvUpload.single('file'), importExpenses);
router.get('/export',          requireRole('admin', 'teacher'), exportExpenses);

// Categories — admin only for mutations
router.get('/categories',      requireRole('admin', 'teacher'), getCategories);
router.post('/categories',     requireRole('admin'),            createCategory);
router.put('/categories/:id',  requireRole('admin'),            updateCategory);

// Reports
router.get('/reports/summary',     requireRole('admin', 'teacher'), getSummary);
router.get('/reports/monthly',     requireRole('admin', 'teacher'), getMonthlyReport);
router.get('/reports/yearly',      requireRole('admin', 'teacher'), getYearlyReport);
router.get('/reports/by-category', requireRole('admin', 'teacher'), getByCategoryReport);

// Expenses CRUD
router.get('/',     requireRole('admin', 'teacher'), getExpenses);
router.post('/',    requireRole('admin'), createExpenseValidator, createExpense);
router.get('/:id',  requireRole('admin', 'teacher'), getExpenseById);
router.put('/:id',  requireRole('admin'),            updateExpense);
router.delete('/:id', requireRole('admin'),          deleteExpense);

module.exports = router;
