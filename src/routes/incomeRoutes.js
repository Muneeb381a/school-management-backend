const express = require('express');
const router  = express.Router();
const {
  getCategories, createCategory, updateCategory,
  getIncomes, getIncome,
  createIncome, updateIncome, deleteIncome,
  getSummary, getMonthlyReport,
} = require('../controllers/incomeController');

// Categories
router.get   ('/categories',     getCategories);
router.post  ('/categories',     createCategory);
router.put   ('/categories/:id', updateCategory);

// Reports (before /:id)
router.get('/reports/summary', getSummary);
router.get('/reports/monthly', getMonthlyReport);

// CRUD
router.get   ('/',    getIncomes);
router.post  ('/',    createIncome);
router.get   ('/:id', getIncome);
router.put   ('/:id', updateIncome);
router.delete('/:id', deleteIncome);

module.exports = router;
