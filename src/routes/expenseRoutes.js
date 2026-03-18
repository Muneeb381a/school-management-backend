const express = require('express');
const router  = express.Router();

const {
  getCategories,
  createCategory,
  updateCategory,
  getExpenses,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense,
  getMonthlyReport,
  getYearlyReport,
  getByCategoryReport,
  getSummary,
} = require('../controllers/expenseController');

// ── Categories ─────────────────────────────────────────────
router.get   ('/categories',       getCategories);
router.post  ('/categories',       createCategory);
router.put   ('/categories/:id',   updateCategory);

// ── Reports (static paths BEFORE /:id) ──────────────────────
router.get('/reports/summary',     getSummary);
router.get('/reports/monthly',     getMonthlyReport);
router.get('/reports/yearly',      getYearlyReport);
router.get('/reports/by-category', getByCategoryReport);

// ── Expenses CRUD ────────────────────────────────────────────
router.get   ('/',     getExpenses);
router.post  ('/',     createExpense);
router.get   ('/:id',  getExpenseById);
router.put   ('/:id',  updateExpense);
router.delete('/:id',  deleteExpense);

module.exports = router;
