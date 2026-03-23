'use strict';

const pino = require('pino');

// ---------------------------------------------------------------------------
// Base logger
// ---------------------------------------------------------------------------
const isDev = process.env.NODE_ENV !== 'production';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    base: { service: 'school-mgmt-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  },
  transport ? pino.transport(transport) : undefined
);

// ---------------------------------------------------------------------------
// Child logger factory
// ---------------------------------------------------------------------------
/**
 * Create a child logger scoped to a module.
 *
 * @param {string} module  Short module/controller name, e.g. 'FEE', 'STUDENT'
 * @returns {import('pino').Logger}
 *
 * @example
 * const { childLogger } = require('../utils/logger');
 * const log = childLogger('FEE');
 * log.info({ invoiceId: 1 }, 'Invoice created');
 * log.error({ err }, 'Failed to create invoice');
 */
function childLogger(module) {
  return logger.child({ module });
}

// ---------------------------------------------------------------------------
// Request logger middleware  (res.on('finish') pattern — no pino-http dep)
// ---------------------------------------------------------------------------
/**
 * Express middleware that logs every HTTP request/response via Pino.
 * Attaches structured fields: method, url, statusCode, responseTime,
 * requestId (req.id), userId (req.user?.id).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requestLogger(req, res, next) {
  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1e6;

    const fields = {
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      responseTime: parseFloat(durationMs.toFixed(2)),
      requestId: req.id || req.headers['x-request-id'] || undefined,
      userId: req.user?.id || undefined,
    };

    // Slow-request threshold (default 1 000 ms)
    const slowThresholdMs = Number(process.env.SLOW_REQUEST_THRESHOLD_MS) || 1000;

    if (res.statusCode >= 500) {
      logger.error(fields, 'request completed');
    } else if (res.statusCode >= 400) {
      logger.warn(fields, 'request completed');
    } else if (durationMs > slowThresholdMs) {
      logger.warn({ ...fields, slow: true }, 'slow request');
    } else {
      logger.info(fields, 'request completed');
    }
  });

  next();
}

// ---------------------------------------------------------------------------
// Slow-query logger  (replaces console.warn in DB layer)
// ---------------------------------------------------------------------------
/**
 * Log a slow database query.  Drop-in replacement for console.warn calls.
 *
 * @param {string} query        SQL string (may be truncated)
 * @param {number} durationMs   Elapsed time in milliseconds
 * @param {number} thresholdMs  Configured threshold
 */
function slowQueryLogger(query, durationMs, thresholdMs) {
  logger.warn(
    { query, durationMs, thresholdMs },
    'slow query detected'
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = logger;
module.exports.requestLogger = requestLogger;
module.exports.childLogger = childLogger;
module.exports.slowQueryLogger = slowQueryLogger;
