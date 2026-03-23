const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getItems, createItem, updateItem, deleteItem,
  getSales, createSale, deleteSale, getMonthlySalesReport,
} = require('../controllers/canteenController');

router.use(auditMiddleware('canteen'));

// Items
router.get('/items',       requireRole('admin', 'teacher'), getItems);
router.post('/items',      requireRole('admin'),            createItem);
router.put('/items/:id',   requireRole('admin'),            updateItem);
router.delete('/items/:id',requireRole('admin'),            deleteItem);

// Sales — monthly report must come before /:id pattern
router.get('/sales/monthly-report', requireRole('admin'), getMonthlySalesReport);
router.get('/sales',                requireRole('admin', 'teacher'), getSales);
router.post('/sales',               requireRole('admin', 'teacher'), createSale);
router.delete('/sales/:id',         requireRole('admin'),            deleteSale);

module.exports = router;
