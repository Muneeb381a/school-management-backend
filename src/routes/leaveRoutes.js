const express = require('express');
const router  = express.Router();
const {
  getLeaveTypes,
  getLeaves, getLeave,
  applyLeave, reviewLeave, cancelLeave, deleteLeave,
  getLeaveBalance, getStats,
} = require('../controllers/leaveController');

router.get('/types',           getLeaveTypes);
router.get('/stats',           getStats);
router.get('/balance',         getLeaveBalance);

router.get   ('/',    getLeaves);
router.post  ('/',    applyLeave);
router.get   ('/:id', getLeave);
router.put   ('/:id/review',  reviewLeave);
router.put   ('/:id/cancel',  cancelLeave);
router.delete('/:id',         deleteLeave);

module.exports = router;
