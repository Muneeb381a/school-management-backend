/**
 * Operational error — safe to send to the client.
 * Anything thrown as AppError will be handled by errorHandler middleware
 * and returned as a clean JSON response without leaking stack traces.
 */
class AppError extends Error {
  /**
   * @param {string} message   Human-readable message (sent to client)
   * @param {number} statusCode  HTTP status code
   * @param {string} [code]    Machine-readable error code e.g. 'VALIDATION_ERROR'
   */
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode    = statusCode;
    this.code          = code;
    this.isOperational = true; // distinguishes from programmer errors
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
