const db = require('../db');
const { metricsStore } = require('../services/metricsService');

let redisClient = null;
try { redisClient = require('../cache/redis').client; } catch {}

// GET /api/health  — basic liveness (no auth)
async function liveness(req, res) {
  res.json({ status: 'ok', ts: new Date().toISOString() });
}

// GET /api/health/ready  — readiness: checks DB + Redis
async function readiness(req, res) {
  const checks = {};
  let allOk = true;

  // DB check
  try {
    await db.raw.query('SELECT 1');
    checks.database = { status: 'ok' };
  } catch (err) {
    checks.database = { status: 'error', error: err.message };
    allOk = false;
  }

  // Redis check (optional)
  if (redisClient) {
    try {
      await redisClient.ping();
      checks.redis = { status: 'ok' };
    } catch (err) {
      checks.redis = { status: 'error', error: err.message };
      // Redis is optional — not a hard failure
    }
  } else {
    checks.redis = { status: 'not_configured' };
  }

  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks, ts: new Date().toISOString() });
}

// GET /api/health/metrics  — performance metrics (admin only)
async function getMetrics(req, res) {
  const summary = metricsStore.getSummary();
  const timeSeries = metricsStore.getTimeSeries();
  res.json({ success: true, data: { summary, timeSeries } });
}

// GET /api/health/info  — version/env info (admin only)
async function getInfo(req, res) {
  res.json({
    success: true,
    data: {
      version: process.env.npm_package_version || '1.0.0',
      node: process.version,
      env: process.env.NODE_ENV || 'development',
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  });
}

module.exports = { liveness, readiness, getMetrics, getInfo };
