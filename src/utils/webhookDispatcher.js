'use strict';

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const pool   = require('../db');

/**
 * Fire webhooks for a given event (fire-and-forget — never throws).
 *
 * @param {string} event  e.g. 'fee.paid', 'student.enrolled'
 * @param {object} data   event payload (will be JSON-serialised)
 */
async function fireWebhooks(event, data) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM webhook_endpoints WHERE is_active = TRUE AND $1 = ANY(events)`,
      [event]
    );
    for (const endpoint of rows) {
      // Intentionally fire-and-forget — response goes to the log table, not the caller
      _dispatch(endpoint, event, data).catch(() => {});
    }
  } catch {
    // Never crash the calling controller if webhooks fail to load
  }
}

/**
 * Dispatch one webhook and write the result to webhook_logs.
 * Exposed so the test endpoint can await it and inspect the result.
 */
async function _dispatch(endpoint, event, data) {
  const body      = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');
  const headers   = {
    'Content-Type':        'application/json',
    'Content-Length':      String(Buffer.byteLength(body)),
    'X-Webhook-Event':     event,
    'X-Webhook-Signature': `sha256=${signature}`,
    'X-Webhook-Timestamp': new Date().toISOString(),
    'User-Agent':          'SchoolMS-Webhooks/1.0',
  };

  const startMs = Date.now();
  try {
    const { statusCode, responseBody } = await _httpPost(endpoint.url, body, headers);
    const durationMs = Date.now() - startMs;
    const ok = statusCode >= 200 && statusCode < 300;

    await pool.query(
      `INSERT INTO webhook_logs
         (endpoint_id, event, payload, status, http_status, response, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [endpoint.id, event, JSON.parse(body), ok ? 'success' : 'failed',
       statusCode, responseBody.slice(0, 500), durationMs]
    );
    return { ok, statusCode, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    await pool.query(
      `INSERT INTO webhook_logs
         (endpoint_id, event, payload, status, error, duration_ms)
       VALUES ($1,$2,$3,'failed',$4,$5)`,
      [endpoint.id, event, JSON.parse(body), err.message, durationMs]
    ).catch(() => {});
    return { ok: false, error: err.message, durationMs };
  }
}

/** Minimal http/https POST using only Node built-ins (no dependencies). */
function _httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers,
      timeout:  10_000,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end',  () => resolve({ statusCode: res.statusCode, responseBody: data }));
    });

    req.on('timeout', () => { req.destroy(new Error('Webhook request timed out after 10 s')); });
    req.on('error',   reject);
    req.write(body);
    req.end();
  });
}

module.exports = { fireWebhooks, _dispatch };
