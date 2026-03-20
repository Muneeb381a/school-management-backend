const express = require('express');
const router  = express.Router();
const {
  getCategories, createCategory, updateCategory,
  getIncomes, getIncome, createIncome, updateIncome, deleteIncome,
  getSummary, getMonthlyReport,
} = require('../controllers/incomeController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('income'));

// Categories
router.get('/categories',      requireRole('admin'), getCategories);
router.post('/categories',     requireRole('admin'), createCategory);
router.put('/categories/:id',  requireRole('admin'), updateCategory);

// Reports
router.get('/reports/summary', requireRole('admin'), getSummary);
router.get('/reports/monthly', requireRole('admin'), getMonthlyReport);

// CRUD
router.get('/',     requireRole('admin'), getIncomes);
router.post('/',    requireRole('admin'), createIncome);
router.get('/:id',  requireRole('admin'), getIncome);
router.put('/:id',  requireRole('admin'), updateIncome);
router.delete('/:id', requireRole('admin'), deleteIncome);

module.exports = router;
