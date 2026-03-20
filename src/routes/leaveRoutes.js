const express = require('express');
const router  = express.Router();
const {
  getLeaveTypes,
  getLeaves, getLeave,
  applyLeave, reviewLeave, cancelLeave, deleteLeave,
  getLeaveBalance, getStats,
} = require('../controllers/leaveController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('leave'));

router.get('/types',   requireRole('admin', 'teacher'), getLeaveTypes);
router.get('/stats',   requireRole('admin'),            getStats);        // admin dashboard
router.get('/balance', requireRole('admin', 'teacher'), getLeaveBalance); // own balance

router.get('/',    requireRole('admin', 'teacher'), getLeaves);
router.post('/',   requireRole('admin', 'teacher'), applyLeave);       // any staff applies
router.get('/:id', requireRole('admin', 'teacher'), getLeave);
router.put('/:id/review', requireRole('admin'),     reviewLeave);      // admin approves/rejects
router.put('/:id/cancel', requireRole('admin', 'teacher'), cancelLeave); // own leave only
router.delete('/:id',     requireRole('admin'),     deleteLeave);

module.exports = router;
