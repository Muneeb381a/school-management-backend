'use strict';

const express = require('express');
const router  = express.Router();
const { initiate, jazzcashCallback, easypaisaCallback, getStatus, list } = require('../controllers/onlinePaymentController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

// Public callbacks — JazzCash / EasyPaisa POST to these (no JWT)
router.post('/jazzcash/callback',  jazzcashCallback);
router.post('/easypaisa/callback', easypaisaCallback);

// Public status check (for polling from frontend)
router.get('/status/:txnRef', verifyToken, getStatus);

// Admin / teacher protected
router.post('/',  verifyToken, requireRole('admin', 'teacher'), initiate);
router.get('/',   verifyToken, requireRole('admin', 'teacher'), list);

module.exports = router;
