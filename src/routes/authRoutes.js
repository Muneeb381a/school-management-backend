const express = require('express');
const { login, me, changePassword } = require('../controllers/authController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login',           login);
router.get('/me',               verifyToken, me);
router.put('/change-password',  verifyToken, changePassword);

module.exports = router;
