const { logAudit } = require('./auditLogger');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function auditMiddleware(req, res, next) {
  if (!MUTATING.has(req.method) || !req.user) return next();

  const start = Date.now();
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const parts    = req.path.replace(/^\//, '').split('/');
    const entity   = parts[0] || 'unknown';
    const action   = `${req.method}_${entity.toUpperCase().replace(/-/g, '_')}`;

    logAudit(req, action, {
      entity,
      entity_id:   parts[1] || null,
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
    });

    return originalJson(body);
  };

  next();
}

module.exports = { auditMiddleware };
