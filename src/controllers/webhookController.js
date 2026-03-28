'use strict';

const crypto = require('crypto');
const pool   = require('../db');
const { serverErr } = require('../utils/serverErr');
const { _dispatch } = require('../utils/webhookDispatcher');

const VALID_EVENTS = [
  'fee.paid', 'fee.partial',
  'salary.paid', 'salary.generated',
  'student.enrolled', 'student.promoted',
  'webhook.test',
];

// GET /api/settings/webhooks
const getWebhooks = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*,
              COUNT(l.id)::int                                         AS total_deliveries,
              COUNT(l.id) FILTER (WHERE l.status = 'success')::int    AS successful,
              MAX(l.fired_at)                                          AS last_fired_at
       FROM webhook_endpoints w
       LEFT JOIN webhook_logs l ON l.endpoint_id = w.id
       GROUP BY w.id
       ORDER BY w.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /api/settings/webhooks
const createWebhook = async (req, res) => {
  try {
    const { url, events, description, is_active } = req.body;
    if (!url)           return res.status(400).json({ success: false, message: 'url is required' });
    if (!events?.length) return res.status(400).json({ success: false, message: 'at least one event is required' });

    // Validate URL
    try { new URL(url); } catch {
      return res.status(400).json({ success: false, message: 'url must be a valid HTTP/HTTPS URL' });
    }

    // Validate events
    const invalid = events.filter(e => !VALID_EVENTS.includes(e));
    if (invalid.length) return res.status(400).json({ success: false, message: `Unknown events: ${invalid.join(', ')}` });

    const secret = crypto.randomBytes(24).toString('hex'); // 48-char hex secret
    const { rows } = await pool.query(
      `INSERT INTO webhook_endpoints (url, secret, events, description, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [url.trim(), secret, events, description?.trim() || null, is_active !== false]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Webhook created. Copy the secret — it will not be shown again.' });
  } catch (err) { serverErr(res, err); }
};

// PUT /api/settings/webhooks/:id
const updateWebhook = async (req, res) => {
  try {
    const { url, events, description, is_active } = req.body;
    if (!url)           return res.status(400).json({ success: false, message: 'url is required' });
    if (!events?.length) return res.status(400).json({ success: false, message: 'at least one event is required' });

    try { new URL(url); } catch {
      return res.status(400).json({ success: false, message: 'url must be a valid HTTP/HTTPS URL' });
    }
    const invalid = events.filter(e => !VALID_EVENTS.includes(e));
    if (invalid.length) return res.status(400).json({ success: false, message: `Unknown events: ${invalid.join(', ')}` });

    const { rows } = await pool.query(
      `UPDATE webhook_endpoints
       SET url=$1, events=$2, description=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [url.trim(), events, description?.trim() || null, is_active !== false, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Webhook not found' });
    res.json({ success: true, data: rows[0], message: 'Webhook updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/settings/webhooks/:id
const deleteWebhook = async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM webhook_endpoints WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Webhook not found' });
    res.json({ success: true, message: 'Webhook deleted' });
  } catch (err) { serverErr(res, err); }
};

// POST /api/settings/webhooks/:id/test
const testWebhook = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM webhook_endpoints WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Webhook not found' });

    const result = await _dispatch(rows[0], 'webhook.test', {
      message:   'Test delivery from SchoolMS',
      timestamp: new Date().toISOString(),
    });

    if (result.ok) {
      res.json({ success: true, message: `Test delivered — HTTP ${result.statusCode} in ${result.durationMs}ms` });
    } else {
      res.status(502).json({ success: false, message: result.error || `Endpoint returned HTTP ${result.statusCode}` });
    }
  } catch (err) { serverErr(res, err); }
};

// GET /api/settings/webhooks/:id/logs
const getWebhookLogs = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, event, status, http_status, response, error, duration_ms, fired_at
       FROM webhook_logs
       WHERE endpoint_id = $1
       ORDER BY fired_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, getWebhookLogs, VALID_EVENTS };
