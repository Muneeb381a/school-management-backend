/**
 * Cache utility — uses ioredis if REDIS_URL is set, falls back to an in-memory Map.
 * Graceful degradation: if Redis is unavailable, cache silently no-ops (app still works).
 *
 * Usage:
 *   const cache = require('../utils/cache');
 *   await cache.set('dashboard:stats', data, 300); // 300 second TTL
 *   const hit = await cache.get('dashboard:stats'); // null on miss
 *   await cache.del('dashboard:stats');
 *   await cache.delPattern('dashboard:*'); // delete all matching keys
 */

let client = null;
// In-memory fallback: Map<key, { value, expiresAt }>
const memStore = new Map();

// Try to connect to Redis if REDIS_URL is set
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    client.on('error', (err) => {
      console.warn('[cache] Redis error (falling back to memory):', err.message);
      client = null;
    });
    client.connect().catch(() => { client = null; });
  } catch (e) {
    console.warn('[cache] ioredis not available, using in-memory cache');
  }
}

/**
 * Get a value from cache.
 * Returns parsed JSON value, or null on miss/expiry.
 */
async function get(key) {
  if (client) {
    try {
      const raw = await client.get(key);
      if (raw === null || raw === undefined) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('[cache] get error:', err.message);
      return null;
    }
  }
  // In-memory fallback
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memStore.delete(key);
    return null;
  }
  return JSON.parse(entry.value);
}

/**
 * Set a value in cache with optional TTL in seconds.
 * Serializes value to JSON.
 */
async function set(key, value, ttlSeconds = 300) {
  const serialized = JSON.stringify(value);
  if (client) {
    try {
      if (ttlSeconds > 0) {
        await client.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await client.set(key, serialized);
      }
      return;
    } catch (err) {
      console.warn('[cache] set error:', err.message);
    }
  }
  // In-memory fallback
  const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
  memStore.set(key, { value: serialized, expiresAt });
}

/**
 * Delete a single key from cache.
 */
async function del(key) {
  if (client) {
    try {
      await client.del(key);
      return;
    } catch (err) {
      console.warn('[cache] del error:', err.message);
    }
  }
  memStore.delete(key);
}

/**
 * Delete all keys matching a glob pattern (e.g. 'dashboard:*').
 * Redis: uses SCAN + DEL.
 * Memory: iterates Map keys matching simple * glob.
 */
async function delPattern(pattern) {
  if (client) {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await client.del(...keys);
        }
      } while (cursor !== '0');
      return;
    } catch (err) {
      console.warn('[cache] delPattern error:', err.message);
    }
  }
  // In-memory fallback: convert glob pattern to a RegExp (support * wildcard only)
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);
  for (const key of memStore.keys()) {
    if (regex.test(key)) {
      memStore.delete(key);
    }
  }
}

/**
 * Flush all cache entries. Intended for dev/test use only.
 */
async function flush() {
  if (client) {
    try {
      await client.flushdb();
      return;
    } catch (err) {
      console.warn('[cache] flush error:', err.message);
    }
  }
  memStore.clear();
}

/**
 * Cache-aside helper: returns cached value if present, otherwise calls fn(),
 * caches the result, and returns it.
 *
 * @param {string}   key
 * @param {number}   ttlSeconds
 * @param {Function} fn  — async function that returns the value to cache
 */
async function remember(key, ttlSeconds, fn) {
  const hit = await get(key);
  if (hit !== null) return hit;
  const result = await fn();
  await set(key, result, ttlSeconds);
  return result;
}

module.exports = { get, set, del, delPattern, flush, remember };
