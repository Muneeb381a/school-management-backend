const { Pool }            = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

// ── Connection pool ───────────────────────────────────────────────────────────
const dbUrl      = process.env.DATABASE_URL || '';
const isLocal    = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
const isServerless = !!process.env.VERCEL;

const rawPool = new Pool({
  connectionString: dbUrl,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  max:                      parseInt(process.env.DB_POOL_MAX || (isServerless ? '5' : '10'), 10),
  min:                      0,
  idleTimeoutMillis:        isServerless ? 10_000 : 30_000,
  connectionTimeoutMillis:  8_000,
});

rawPool.on('connect', () => {
  try { require('../utils/logger').info('Connected to PostgreSQL database'); }
  catch { console.log('Connected to PostgreSQL database'); }
});
rawPool.on('error', (err) => {
  try { require('../utils/logger').error({ err: err.message }, 'Unexpected database error'); }
  catch { console.error('Unexpected database error:', err); }
});

// ── Slow-query logger ─────────────────────────────────────────────────────────
const SLOW_MS       = parseInt(process.env.DB_SLOW_MS || '500', 10);
const _rawPoolQuery = rawPool.query.bind(rawPool);

function logSlowQuery(text, duration) {
  try {
    const { slowQueryLogger } = require('../utils/logger');
    slowQueryLogger(text.replace(/\s+/g, ' ').slice(0, 200), duration, SLOW_MS);
  } catch {
    console.warn(`[slow-query] ${duration}ms — ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

// ── Multi-tenant schema store ─────────────────────────────────────────────────
//
// Each authenticated request stores its tenant schema here.
// Middleware calls: schemaStore.run(schema, next)
// pool.query / pool.connect then pick it up automatically.
//
const schemaStore = new AsyncLocalStorage();

// ── Wrapped pool.connect ──────────────────────────────────────────────────────
// Returns a pg Client with search_path already set to the current tenant schema.
// Controllers using pool.connect() for transactions get isolation for free.
//
const _rawPoolConnect = rawPool.connect.bind(rawPool);

async function connect() {
  const client = await _rawPoolConnect();
  const schema = schemaStore.getStore();
  if (schema) {
    // search_path persists for this client's lifetime (until release)
    await _rawClientQuery(client, `SET search_path TO "${schema}", public`);
  }
  return client;
}

// Helper to call pg client query directly (bypasses our wrapper, avoids recursion)
function _rawClientQuery(client, text, params) {
  return new Promise((resolve, reject) => {
    client.query(text, params, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

// ── Wrapped pool.query ────────────────────────────────────────────────────────
// For simple (non-transaction) queries.
// If a tenant schema is active: acquires a client, sets search_path, runs, releases.
// If no schema (super-admin / public): delegates to raw pool directly.
//
async function query(text, params) {
  const queryText = typeof text === 'string' ? text : text?.text ?? String(text);
  const start     = Date.now();

  let result;
  const schema = schemaStore.getStore();

  if (schema) {
    // Tenant path — use a dedicated client so search_path is isolated
    const client = await _rawPoolConnect();
    try {
      await _rawClientQuery(client, `SET search_path TO "${schema}", public`);
      result = await _rawClientQuery(client, text, params);
    } finally {
      client.release();
    }
  } else {
    // Non-tenant path — direct pool query (same as before)
    result = await _rawPoolQuery(text, params);
  }

  const duration = Date.now() - start;
  if (duration >= SLOW_MS) logSlowQuery(queryText, duration);

  return result;
}

// ── Public db object ──────────────────────────────────────────────────────────
// Drop-in replacement for the old `pool`:
//   const pool = require('../db');
//   pool.query(...)    → schema-aware
//   pool.connect()     → schema-aware client
//   pool.schemaStore   → for middleware use
//   pool.raw           → raw pg Pool (migrations, super-admin provisioning)
//
const db = {
  query,
  connect,
  schemaStore,
  raw: rawPool,          // used by schoolController provisioning (needs direct schema DDL)

  // Pass-through events so callers doing pool.on('error') still work
  on:  rawPool.on.bind(rawPool),
  off: rawPool.off.bind(rawPool),
  end: rawPool.end.bind(rawPool),
};

module.exports = db;
