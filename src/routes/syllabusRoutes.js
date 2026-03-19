const express = require('express');
const { getTopics, getStats, createTopic, updateTopic, markComplete, deleteTopic } = require('../controllers/syllabusController');

const router = express.Router();

router.get('/',           getTopics);
router.get('/stats',      getStats);
router.post('/',          createTopic);
router.put('/:id',        updateTopic);
router.patch('/:id/complete', markComplete);
router.delete('/:id',     deleteTopic);

module.exports = router;
