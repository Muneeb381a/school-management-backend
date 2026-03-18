const express = require('express');
const router  = express.Router();
const {
  getRegistrations, getRegistration,
  createRegistration, updateRegistration, deleteRegistration,
  getStats,
} = require('../controllers/boardExamController');

router.get('/stats',  getStats);
router.route('/')
  .get(getRegistrations)
  .post(createRegistration);
router.route('/:id')
  .get(getRegistration)
  .put(updateRegistration)
  .delete(deleteRegistration);

module.exports = router;
