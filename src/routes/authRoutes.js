const express = require('express');
const {
  login, refresh, logout, me, changePassword, setup,
  getSessions, revokeSession,
  forgotPassword, resetPassword,
} = require('../controllers/authController');
const { verifyToken }                              = require('../middleware/authMiddleware');
const { loginValidator, setupValidator, changePasswordValidator } = require('../middleware/validate');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const router = express.Router();

// Tight rate limit for password reset — 3 requests/hour per IP
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, message: 'Too many password reset requests. Try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
});

// ── Public ────────────────────────────────────────────────────────
router.post('/login',           loginValidator, login);
router.post('/setup',           setupValidator, setup);
router.post('/refresh',         refresh);   // no access token needed
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password',  resetPassword);

// ── Protected ─────────────────────────────────────────────────────
router.post('/logout',            verifyToken, logout);
router.get('/me',                 verifyToken, me);
router.put('/change-password',    verifyToken, changePasswordValidator, changePassword);

// Session management
router.get('/sessions',           verifyToken, getSessions);
router.delete('/sessions/:id',    verifyToken, revokeSession);

module.exports = router;
