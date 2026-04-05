const cache = require('./redis');

/**
 * Route-level cache middleware.
 * Usage: router.get('/', cacheRoute(60), handler)
 */
function cacheRoute(ttl = 60) {
  return async (req, res, next) => {
    const schema = req.user?.schema || 'public';
    const qs     = new URLSearchParams(req.query).toString();
    const key    = `${schema}|${req.method}|${req.path}|${qs}`;

    const cached = await cache.get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, body, ttl);
      }
      res.setHeader('X-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
}

module.exports = { cacheRoute };
