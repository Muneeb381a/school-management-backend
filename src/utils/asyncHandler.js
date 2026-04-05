/**
 * Wraps an async route handler so any thrown error is forwarded to
 * Express's next(err) — no try/catch needed in controllers.
 *
 * Usage: router.get('/path', asyncHandler(myAsyncController))
 */
module.exports = function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
