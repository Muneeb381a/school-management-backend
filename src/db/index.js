const { Pool } = require('pg');
require('dotenv').config();

// Use SSL for any remote DB (non-localhost). Works for Neon, Supabase, Railway etc.
const dbUrl = process.env.DATABASE_URL || '';
const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

const pool = new Pool({
  connectionString: dbUrl,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: true } }),

  // Pool tuning — sensible defaults for a single-server school management app.
  // Neon serverless free tier: keep max low to avoid connection exhaustion.
  max: parseInt(process.env.DB_POOL_MAX  || '10', 10),  // max concurrent clients
  min: parseInt(process.env.DB_POOL_MIN  || '2',  10),  // keep-alive baseline
  idleTimeoutMillis:    30_000,   // close idle clients after 30 s
  connectionTimeoutMillis: 5_000, // fail fast if no client available in 5 s
});

// Slow-query logger — logs any query taking longer than DB_SLOW_MS (default 500 ms)
const SLOW_MS = parseInt(process.env.DB_SLOW_MS || '500', 10);

const originalQuery = pool.query.bind(pool);

pool.query = function slowQueryLogger(text, params, callback) {
  // Normalise overloaded signatures
  const queryText = typeof text === 'string' ? text : text?.text ?? String(text);

  const start = Date.now();

  const handleResult = (err, result) => {
    const duration = Date.now() - start;
    if (duration >= SLOW_MS) {
      // Use Pino logger if available, fall back to console.warn
      try {
        const { slowQueryLogger: logSlowQuery } = require('../utils/logger');
        logSlowQuery(queryText.replace(/\s+/g, ' ').slice(0, 200), duration, SLOW_MS);
      } catch {
        console.warn(`[slow-query] ${duration}ms — ${queryText.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    if (typeof callback === 'function') callback(err, result);
  };

  if (typeof callback === 'function') {
    return originalQuery(text, params, handleResult);
  }

  // Promise path
  return originalQuery(text, params).then(
    (result) => { handleResult(null, result); return result; },
    (err)    => { handleResult(err,  null);   return Promise.reject(err); }
  );
};

pool.on('connect', () => {
  try {
    require('../utils/logger').info('Connected to PostgreSQL database');
  } catch {
    console.log('Connected to PostgreSQL database');
  }
});

pool.on('error', (err) => {
  try {
    require('../utils/logger').error({ err: err.message }, 'Unexpected database error');
  } catch {
    console.error('Unexpected database error:', err);
  }
});

module.exports = pool;
