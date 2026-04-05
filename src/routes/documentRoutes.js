const router = require('express').Router();
const ctrl = require('../controllers/documentController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

router.use(verifyToken);

router.get('/',       asyncHandler(ctrl.getDocuments));
router.get('/:id',    asyncHandler(ctrl.getDocument));
router.post('/',      requireRole('admin', 'teacher'), asyncHandler(ctrl.uploadDocument));
router.put('/:id',    requireRole('admin', 'teacher'), asyncHandler(ctrl.updateDocument));
router.delete('/:id', requireRole('admin'),            asyncHandler(ctrl.deleteDocument));

module.exports = router;
