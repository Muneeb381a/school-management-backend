const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  recordLate, getLateArrivals, getMonthlyRegister, deleteLate,
} = require('../controllers/lateArrivalController');

router.use(auditMiddleware('late-arrivals'));

router.post('/',        requireRole('admin', 'teacher'), recordLate);
router.get('/',         requireRole('admin', 'teacher'), getLateArrivals);
router.get('/register', requireRole('admin', 'teacher'), getMonthlyRegister);
router.delete('/:id',   requireRole('admin'),            deleteLate);

module.exports = router;
