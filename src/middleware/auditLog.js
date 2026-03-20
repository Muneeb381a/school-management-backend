/**
 * Audit logging — records critical actions to the audit_logs table.
 *
 * Two usage patterns:
 *
 * 1. Direct call inside a controller (fine-grained):
 *    await logAction({ userId: req.user.id, username: req.user.username,
 *                      action: 'LOGIN', resource: 'auth', req });
 *
 * 2. Router-level middleware (automatic coverage):
 *    router.use(auditMiddleware('student'));
 *    // All POST/PUT/PATCH/DELETE to this router are logged automatically.
 */

const pool = require('../db');

const METHOD_TO_ACTION = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'PATCH', DELETE: 'DELETE' };

/**
 * Insert one audit row. Non-blocking — errors are swallowed so they
 * never disrupt the actual request/response cycle.
 *
 * @param {{ userId, username, action, resource, resourceId, details, req }} opts
 */
async function logAction({ userId, username, action, resource, resourceId, details, req } = {}) {
  try {
    const ip        = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
                      || req?.ip
                      || null;
    const userAgent = req?.headers?.['user-agent']?.slice(0, 250) || null;

    await pool.query(
      `INSERT INTO audit_logs
         (user_id, username, action, resource, resource_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId     || null,
        username   || null,
        action,
        resource   || null,
        resourceId ? parseInt(resourceId, 10) : null,
        details    ? JSON.stringify(details) : null,
        ip,
        userAgent,
      ]
    );
  } catch (_err) {
    // Audit logging must never break the main flow.
    // In production, consider piping _err to a secondary logger (e.g. Sentry).
  }
}

/**
 * Express router-level middleware that automatically logs all
 * state-mutating requests (POST, PUT, PATCH, DELETE) after a
 * successful response.
 *
 * @param {string} resource  Name of the domain being audited, e.g. 'student'
 */
function auditMiddleware(resource) {
  return (req, res, next) => {
    // Only instrument mutating methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    // Wrap res.json to intercept after response is sent
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Only log successful operations
      if (body?.success !== false) {
        const action     = METHOD_TO_ACTION[req.method] || req.method;
        const resourceId = req.params?.id || null;
        logAction({
          userId:     req.user?.id,
          username:   req.user?.username,
          action,
          resource,
          resourceId,
          details: { path: req.path, method: req.method },
          req,
        });
      }
      return originalJson(body);
    };

    next();
  };
}

/**
 * GET /api/audit-logs — Admin-only endpoint to query the audit trail.
 * Attach directly to a route, not used as middleware.
 */
async function getAuditLogs(req, res, next) {
  try {
    const { user_id, action, resource, from, to, page = 1, limit = 50 } = req.query;
    const params = [];
    let   where  = 'WHERE 1=1';

    if (user_id)  { params.push(user_id);  where += ` AND al.user_id = $${params.length}`; }
    if (action)   { params.push(action);   where += ` AND al.action  = $${params.length}`; }
    if (resource) { params.push(resource); where += ` AND al.resource = $${params.length}`; }
    if (from)     { params.push(from);     where += ` AND al.created_at >= $${params.length}`; }
    if (to)       { params.push(to);       where += ` AND al.created_at <= $${params.length}`; }

    const lim    = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;
    params.push(lim, offset);

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT al.*, u.name AS user_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         ${where}
         ORDER BY al.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM audit_logs al ${where}`,
        params.slice(0, -2)
      ),
    ]);

    res.json({
      success: true,
      data: dataRes.rows,
      meta: {
        total:      parseInt(countRes.rows[0].total, 10),
        page:       parseInt(page, 10),
        limit:      lim,
        totalPages: Math.ceil(countRes.rows[0].total / lim),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { logAction, auditMiddleware, getAuditLogs };
