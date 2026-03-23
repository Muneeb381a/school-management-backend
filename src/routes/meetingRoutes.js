const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  createSlots, getSlots, deleteSlot,
  bookSlot, cancelBooking, getBookings, getMeetingSchedulePrint,
} = require('../controllers/meetingController');

router.use(auditMiddleware('meetings'));

// Schedule print — before /:id routes
router.get('/schedule/print', requireRole('admin', 'teacher'), getMeetingSchedulePrint);

// Slots
router.post('/slots',          requireRole('admin', 'teacher'), createSlots);
router.get('/slots',           requireRole('admin', 'teacher'), getSlots);
router.delete('/slots/:id',    requireRole('admin', 'teacher'), deleteSlot);
router.post('/slots/:id/book', requireRole('admin', 'teacher'), bookSlot);

// Bookings
router.put('/bookings/:id/cancel', requireRole('admin', 'teacher'), cancelBooking);
router.get('/bookings',            requireRole('admin', 'teacher'), getBookings);

module.exports = router;
