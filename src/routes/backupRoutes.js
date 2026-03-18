const express = require('express');
const { requireRole } = require('../middleware/authMiddleware');
const { exportBackup, restoreBackup } = require('../controllers/backupController');

const router = express.Router();

// Both endpoints admin-only — backup contains all school data
router.get('/export',   requireRole('admin'), exportBackup);
router.post('/restore', requireRole('admin'), restoreBackup);

module.exports = router;
