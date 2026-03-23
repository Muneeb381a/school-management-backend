/**
 * Database read replica pool.
 * If DATABASE_REPLICA_URL is set, creates a separate pool for read queries.
 * Otherwise falls back to the primary pool.
 *
 * Usage:
 *   const { read, write } = require('../db/replica');
 *   const { rows } = await read.query('SELECT ...');
 *   await write.query('INSERT ...');
 */

const { Pool } = require('pg');
const primary = require('./index'); // existing primary pool

let replicaPool = null;

const replicaUrl = process.env.DATABASE_REPLICA_URL;

if (replicaUrl) {
  const isLocal = replicaUrl.includes('localhost') || replicaUrl.includes('127.0.0.1');
  replicaPool = new Pool({
    connectionString: replicaUrl,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: true } }),
    max: parseInt(process.env.DB_REPLICA_POOL_MAX || '5', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  replicaPool.on('error', (err) => {
    console.warn('[replica] Pool error (falling back to primary):', err.message);
    replicaPool = null;
  });
  console.log('✅  DB read replica connected.');
} else {
  console.log('ℹ️   DATABASE_REPLICA_URL not set — using primary for reads.');
}

// read: use replica if available, else primary
const read = replicaPool || primary;
// write: always primary
const write = primary;

module.exports = { read, write, primary };
