/**
 * Redis client — best-effort caching.
 * If Redis is unavailable the app continues normally (cache miss).
 */
let client = null;
let connected = false;

// Only init Redis if REDIS_URL or REDIS_HOST is configured
const REDIS_URL  = process.env.REDIS_URL;
const REDIS_HOST = process.env.REDIS_HOST;

if (REDIS_URL || REDIS_HOST) {
  try {
    const Redis = require('ioredis');
    client = new Redis(REDIS_URL || {
      host:     REDIS_HOST || '127.0.0.1',
      port:     parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect:         true,
      enableOfflineQueue:  false,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });

    client.on('connect', () => { connected = true; });
    client.on('error',   () => { connected = false; });
    client.connect().catch(() => { connected = false; });
  } catch {
    client = null;
  }
}

async function get(key) {
  if (!client || !connected) return null;
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function set(key, value, ttlSeconds = 60) {
  if (!client || !connected) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch { /* no-op */ }
}

async function del(pattern) {
  if (!client || !connected) return;
  try {
    if (pattern.includes('*')) {
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== '0');
    } else {
      await client.del(pattern);
    }
  } catch { /* no-op */ }
}

module.exports = { client: client || { ping: async () => { throw new Error('Redis not configured'); } }, get, set, del, connected: () => connected };
