const express = require('express');
const router  = express.Router();
const {
  getItems, getItem, createItem, updateItem, deleteItem, getSummary,
  getImportTemplate, importInventory, exportInventory,
} = require('../controllers/inventoryController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const { csvUpload }       = require('../middleware/upload');

router.use(auditMiddleware('inventory'));

router.get('/import/template', requireRole('admin'), getImportTemplate);
router.post('/import',         requireRole('admin'), csvUpload.single('file'), importInventory);
router.get('/export',          requireRole('admin', 'teacher'), exportInventory);

router.get('/summary', requireRole('admin', 'teacher'), getSummary);
router.get('/',        requireRole('admin', 'teacher'), getItems);
router.get('/:id',     requireRole('admin', 'teacher'), getItem);
router.post('/',       requireRole('admin'),            createItem);
router.put('/:id',     requireRole('admin'),            updateItem);
router.delete('/:id',  requireRole('admin'),            deleteItem);

module.exports = router;
