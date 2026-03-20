const jwt      = require('jsonwebtoken');
const AppError = require('../utils/AppError');

const ACCESS_SECRET = process.env.JWT_SECRET;

if (!ACCESS_SECRET) {
  throw new Error('FATAL: JWT_SECRET must be set in environment variables.');
}

/**
 * Verify the Bearer access token from the Authorization header.
 * On success, populates req.user with the decoded JWT payload.
 * On failure, passes an AppError to the next error handler.
 */
function verifyToken(req, _res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return next(new AppError('Authentication required. Please log in.', 401, 'NO_TOKEN'));
  }

  try {
    req.user = jwt.verify(token, ACCESS_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Access token expired.', 401, 'TOKEN_EXPIRED'));
    }
    return next(new AppError('Invalid token.', 401, 'INVALID_TOKEN'));
  }
}

/**
 * Role-based access control middleware.
 * Usage: router.delete('/:id', requireRole('admin'), handler)
 *
 * @param {...string} roles  Allowed roles e.g. 'admin', 'teacher'
 */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required.', 401, 'UNAUTHORIZED'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(
        `Access denied. Required role: ${roles.join(' or ')}.`,
        403, 'FORBIDDEN'
      ));
    }
    next();
  };
}

/**
 * Ownership guard — ensures the authenticated user owns the resource
 * OR is an admin.
 *
 * Usage: requireOwnerOrAdmin((req) => req.params.id)
 *
 * @param {Function} getResourceId  Extracts the resource owner entity_id from req
 */
function requireOwnerOrAdmin(getResourceId) {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError('Authentication required.', 401, 'UNAUTHORIZED'));
    if (req.user.role === 'admin') return next();

    const resourceId = String(getResourceId(req));
    const userId     = String(req.user.entity_id || req.user.id);

    if (resourceId !== userId) {
      return next(new AppError('You can only access your own records.', 403, 'FORBIDDEN'));
    }
    next();
  };
}

module.exports = { verifyToken, requireRole, requireOwnerOrAdmin };
