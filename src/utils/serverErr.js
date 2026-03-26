/**
 * Shared serverErr helper — safe for production use.
 *
 * - Logs the full error internally (module tag + stack)
 * - Translates known PostgreSQL constraint codes into friendly 4xx messages
 * - Never leaks raw err.message or stack to the client for 500s
 *
 * Usage:
 *   const { serverErr } = require('../utils/serverErr');
 *   ...
 *   } catch (err) { serverErr(res, err, 'ATTENDANCE'); }
 */

const isProd = process.env.NODE_ENV === 'production';

/** Map PG error codes to safe client messages. */
function pgMessage(err) {
  switch (err.code) {
    case '23505': {
      const match = (err.detail || '').match(/\((.+?)\)=\((.+?)\)/);
      const field = match ? match[1] : 'value';
      const val   = match ? ` (${match[2]})` : '';
      return { status: 409, message: `A record with this ${field}${val} already exists.` };
    }
    case '23503':
      return { status: 400, message: 'Referenced record does not exist.' };
    case '23502':
      return { status: 400, message: `Required field "${err.column}" is missing.` };
    case '22P02':
      return { status: 400, message: 'Invalid data format provided.' };
    case '42P01':
      return { status: 500, message: 'Database configuration error. Please contact support.' };
    default:
      return null;
  }
}

function serverErr(res, err, module = 'SERVER') {
  // Always log the real error server-side
  console.error(`[${module}]`, err.message, isProd ? '' : err.stack);

  // Known PG constraint → friendly 4xx
  const pg = pgMessage(err);
  if (pg) {
    return res.status(pg.status).json({ success: false, message: pg.message });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }

  // Generic 500 — never expose internal details in production
  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
    ...(isProd ? {} : { detail: err.message }),
  });
}

module.exports = { serverErr };
