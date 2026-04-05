const db = require('../db');

const SENSITIVE = new Set(['password', 'password_hash', 'token', 'refresh_token', 'pin', 'secret']);

function sanitise(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, SENSITIVE.has(k.toLowerCase()) ? '[REDACTED]' : v])
  );
}

async function logAudit(req, action, meta = {}) {
  try {
    const u = req.user || {};
    await db.query(
      `INSERT INTO audit_logs
         (user_id, username, role, action, entity, entity_id,
          method, path, ip, user_agent, payload, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
      [
        u.id       || null,
        u.username || null,
        u.role     || null,
        action,
        meta.entity    || null,
        meta.entity_id ? String(meta.entity_id) : null,
        req.method,
        req.originalUrl,
        req.ip,
        req.headers?.['user-agent'] || null,
        JSON.stringify(sanitise(req.body || {})),
        JSON.stringify(meta),
      ]
    );
  } catch (err) {
    // Never crash the request due to audit failure
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Audit] Failed to write log:', err.message);
    }
  }
}

module.exports = { logAudit };
