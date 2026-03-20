/**
 * Standardized API response helpers.
 * Every successful response: { success: true, data, message?, meta? }
 * Every error response:      { success: false, message, code? }
 *
 * Usage:
 *   res.success(data)
 *   res.created(data, 'Student enrolled')
 *   send.success(res, data, 'OK', 200, { total: 100, page: 1 })
 */

const send = {
  success(res, data, message = null, statusCode = 200, meta = null) {
    const payload = { success: true };
    if (message)                         payload.message = message;
    if (data !== undefined && data !== null) payload.data = data;
    if (meta && Object.keys(meta).length)   payload.meta = meta;
    return res.status(statusCode).json(payload);
  },

  created(res, data, message = 'Created successfully.', meta = null) {
    return send.success(res, data, message, 201, meta);
  },

  noContent(res) {
    return res.status(204).send();
  },

  error(res, message = 'Something went wrong.', statusCode = 500, code = null) {
    const payload = { success: false, message };
    if (code) payload.code = code;
    return res.status(statusCode).json(payload);
  },
};

module.exports = send;
