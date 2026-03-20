const express = require('express');
const router  = express.Router();
const { getStats } = require('../controllers/dashboardController');
const { requireRole } = require('../middleware/authMiddleware');

router.get('/stats', requireRole('admin', 'teacher'), getStats);

module.exports = router;
