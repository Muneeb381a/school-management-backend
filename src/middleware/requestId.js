const { v4: uuidv4 } = require('uuid');

/**
 * Assigns a unique X-Request-ID to every request.
 * - Reuses the client-supplied header if present (useful for tracing across services).
 * - Attaches the ID to `req.id` and echoes it in the response header.
 */
function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || uuidv4();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
}

module.exports = requestId;
