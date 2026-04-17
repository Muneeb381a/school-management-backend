const jwt      = require('jsonwebtoken');
const AppError = require('../utils/AppError');
const db       = require('../db');
const { hasPermissionInDb } = require('../services/permissionService');

const ACCESS_SECRET = process.env.JWT_SECRET;
if (!ACCESS_SECRET) {
  throw new Error('FATAL: JWT_SECRET must be set in environment variables.');
}

/**
 * Verify the Bearer access token from the Authorization header.
 * On success:
 *  - populates req.user with the decoded JWT payload
 *  - if the token carries a `schema` field (multi-tenant mode), wraps the
 *    remainder of the request in AsyncLocalStorage so pool.query / pool.connect
 *    automatically target that school's schema — zero controller changes needed.
 */
function verifyToken(req, _res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return next(new AppError('Authentication required. Please log in.', 401, 'NO_TOKEN'));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, ACCESS_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Access token expired.', 401, 'TOKEN_EXPIRED'));
    }
    return next(new AppError('Invalid token.', 401, 'INVALID_TOKEN'));
  }

  req.user = decoded;

  // ── Multi-tenant schema injection ────────────────────────────────────────
  // If the JWT contains a `schema` field (e.g. "school_greenvalley"), run all
  // downstream middleware + the controller inside the schema's async context.
  // pool.query() and pool.connect() pick this up automatically via AsyncLocalStorage.
  //
  // If there is no schema (super-admin tokens, legacy single-tenant tokens),
  // the request proceeds normally using the public schema.
  if (decoded.schema) {
    return db.schemaStore.run(decoded.schema, next);
  }

  next();
}

/**
 * Role-based access control.
 * Usage: router.delete('/:id', requireRole('admin'), handler)
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
 * Super-admin guard — only for platform-level operations
 * (create/manage schools, view all tenants, billing etc.)
 */
function requireSuperAdmin(req, _res, next) {
  if (!req.user) {
    return next(new AppError('Authentication required.', 401, 'UNAUTHORIZED'));
  }
  if (!req.user.is_super_admin) {
    return next(new AppError('Super-admin access required.', 403, 'FORBIDDEN'));
  }
  next();
}

/**
 * Ownership guard — user must own the resource OR be an admin.
 * Usage: requireOwnerOrAdmin((req) => req.params.id)
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

/**
 * Blocks all API access for users whose temporary password hasn't been changed.
 */
function requirePasswordChanged(req, _res, next) {
  if (req.user?.mustChangePassword) {
    return next(new AppError(
      'You must change your temporary password before continuing.',
      403,
      'PASSWORD_CHANGE_REQUIRED'
    ));
  }
  next();
}

/**
 * Permission-based access control (RBAC).
 * Usage: router.post('/', checkPermission('students:create'), handler)
 *
 * Check order:
 *  1. Admin role → always passes
 *  2. JWT-embedded permissions (fast, no DB) → pass if found
 *  3. DB lookup (fallback for stale tokens or fresh permission changes)
 *
 * @param {string} permKey - e.g. 'students:create', 'fees:export'
 */
function checkPermission(permKey) {
  return async (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required.', 401, 'UNAUTHORIZED'));
    }

    // 1. Admin bypasses all permission checks
    if (req.user.role === 'admin') return next();

    // 2. Fast path: check JWT-embedded permissions array (set at login)
    const jwtPerms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (jwtPerms.includes(permKey)) return next();

    // 3. DB fallback — handles stale tokens or permission changes made after login
    try {
      const allowed = await hasPermissionInDb(req.user.role, permKey, req.user.id);
      if (allowed) return next();
    } catch {
      // If permission tables don't exist yet (cold deploy), fail open for admins,
      // fail closed for everyone else — already handled above.
    }

    return next(new AppError(
      `Access denied. You do not have permission to perform this action.`,
      403, 'FORBIDDEN'
    ));
  };
}

module.exports = {
  verifyToken,
  requireRole,
  requireSuperAdmin,
  requireOwnerOrAdmin,
  requirePasswordChanged,
  checkPermission,
};
