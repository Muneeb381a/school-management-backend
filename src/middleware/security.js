const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

/**
 * Security headers via helmet.
 * Applied globally in index.js.
 */
const securityHeaders = helmet({
  contentSecurityPolicy: false, // Managed by frontend
  crossOriginEmbedderPolicy: false,
});

/**
 * General API rate limiter — 200 req/min per IP.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/**
 * Strict limiter for auth endpoints — 10 attempts per 15 min per IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' },
  skipSuccessfulRequests: true,
});

/**
 * WhatsApp webhook / bulk sender limiter — 60 req/min.
 */
const whatsappLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'WhatsApp rate limit exceeded.' },
});

module.exports = { securityHeaders, apiLimiter, authLimiter, whatsappLimiter };
