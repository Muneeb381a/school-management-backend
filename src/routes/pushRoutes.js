const express = require('express');
const { requireRole } = require('../middleware/authMiddleware');
const { savePushToken, removePushToken, sendPush } = require('../controllers/pushController');

const router = express.Router();

// Any authenticated user can save/remove their own push token
router.post('/token',   savePushToken);
router.delete('/token', removePushToken);

// Admin only: send push to role or user
router.post('/send', requireRole('admin'), sendPush);

module.exports = router;
