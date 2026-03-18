const express = require('express');
const router  = express.Router();
const { getEvents, getEventById, createEvent, updateEvent, deleteEvent } =
  require('../controllers/eventsController');

// GET    /api/events            → list (filter: ?academic_year=&type=&month=YYYY-MM&is_holiday=)
// POST   /api/events            → create
// GET    /api/events/:id        → single
// PUT    /api/events/:id        → update
// DELETE /api/events/:id        → delete

router.route('/').get(getEvents).post(createEvent);
router.route('/:id').get(getEventById).put(updateEvent).delete(deleteEvent);

module.exports = router;
