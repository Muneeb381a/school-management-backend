const AppError = require('../utils/AppError');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Translate PostgreSQL error codes into clean AppErrors.
 */
function handlePgError(err) {
  switch (err.code) {
    case '23505': {
      // Parse the constraint detail to give a useful message
      const detail = err.detail || '';
      const match  = detail.match(/\((.+?)\)=\((.+?)\)/);
      const field  = match ? match[1] : 'value';
      const value  = match ? match[2] : '';
      return new AppError(
        `A record with this ${field}${value ? ` (${value})` : ''} already exists.`,
        409, 'DUPLICATE_ENTRY'
      );
    }
    case '23503':
      return new AppError('Referenced record does not exist.', 400, 'FOREIGN_KEY_VIOLATION');
    case '23502':
      return new AppError(
        `Required field "${err.column}" is missing.`, 400, 'MISSING_FIELD'
      );
    case '22P02':
      return new AppError('Invalid data format provided.', 400, 'INVALID_FORMAT');
    case '42P01':
      return new AppError('Database table not found. Run migrations.', 500, 'TABLE_NOT_FOUND');
    default:
      return null;
  }
}

/**
 * Central error-handling middleware.
 * Must be registered LAST in Express (4 params).
 *
 * Guarantees:
 *  - No stack traces leak to the client in production
 *  - Operational errors (AppError) return their message as-is
 *  - PostgreSQL constraint errors produce friendly messages
 *  - JWT errors are mapped to 401
 *  - Everything else returns a generic 500
 */
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, _req, res, _next) {
  // 1. Operational error (thrown deliberately)
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }

  // 2. PostgreSQL error
  const pgError = err.code ? handlePgError(err) : null;
  if (pgError) {
    return res.status(pgError.statusCode).json({
      success: false,
      message: pgError.message,
      code:    pgError.code,
    });
  }

  // 3. JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.', code: 'INVALID_TOKEN' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Access token expired.', code: 'TOKEN_EXPIRED' });
  }

  // 4. Multer / file upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File is too large. Maximum size is 5 MB.', code: 'FILE_TOO_LARGE' });
  }

  // 5. Unknown / programmer error — log it, send generic message
  console.error('[UNHANDLED ERROR]', {
    name:    err.name,
    message: err.message,
    stack:   err.stack,
  });

  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
    ...(isProd ? {} : { detail: err.message }),
  });
};
