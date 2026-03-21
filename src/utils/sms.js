/**
 * Generic SMS utility for Pakistani SMS gateways.
 *
 * Supports two providers via env vars:
 *
 *   SMS_PROVIDER   = 'generic' (default) | 'twilio'
 *
 * ── Generic HTTP Gateway (most Pakistani providers) ──────────
 *   SMS_API_URL    = Full endpoint URL, e.g. https://api.yourprovider.com/send
 *                    The URL may contain placeholders:
 *                      {to}      → recipient number
 *                      {message} → URL-encoded message
 *                      {key}     → your API key
 *                    OR the params are sent as query string / JSON body
 *   SMS_API_KEY    = API key / username
 *   SMS_SENDER_ID  = Sender ID / mask (e.g. SchoolMS, SCHOOL)
 *   SMS_METHOD     = 'GET' or 'POST' (default: POST)
 *
 * ── Twilio ────────────────────────────────────────────────────
 *   SMS_PROVIDER        = 'twilio'
 *   TWILIO_ACCOUNT_SID  = ACxxxxxxxx
 *   TWILIO_AUTH_TOKEN   = your auth token
 *   TWILIO_FROM         = +1xxxxxxxxxx (your Twilio number)
 *
 * If no provider is configured, sendSMS() logs a warning and no-ops.
 *
 * Phone number normalisation:
 *   Pakistani numbers like 0300xxxxxxx → +92300xxxxxxx
 */

const https = require('https');
const http  = require('http');

/**
 * Normalise a Pakistani phone number to E.164 format.
 * Strips spaces/dashes, converts 03xx to +9203xx.
 */
function normalisePhone(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[\s\-().]/g, '');
  if (n.startsWith('0')) n = '+92' + n.slice(1);
  if (!n.startsWith('+')) n = '+' + n;
  return n;
}

async function sendViaTwilio(to, message) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM)');
  }
  // Use Twilio REST API directly (no SDK dependency)
  const body = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: message }).toString();
  const auth  = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url   = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Twilio error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendViaGeneric(to, message) {
  const { SMS_API_URL, SMS_API_KEY, SMS_SENDER_ID, SMS_METHOD = 'POST' } = process.env;
  if (!SMS_API_URL) throw new Error('SMS_API_URL not configured');

  const params = {
    to,
    message,
    key:       SMS_API_KEY  || '',
    sender_id: SMS_SENDER_ID || '',
    sender:    SMS_SENDER_ID || '',
    apikey:    SMS_API_KEY  || '',
    from:      SMS_SENDER_ID || '',
  };

  if (SMS_METHOD.toUpperCase() === 'GET') {
    // Build query string, expand placeholders in URL if present
    let url = SMS_API_URL
      .replace('{to}',      encodeURIComponent(to))
      .replace('{message}', encodeURIComponent(message))
      .replace('{key}',     encodeURIComponent(SMS_API_KEY || ''));

    // If no placeholders were used, append as query string
    if (url === SMS_API_URL) {
      url += '?' + new URLSearchParams(params).toString();
    }

    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  // POST (default)
  const body    = JSON.stringify(params);
  const parsed  = new URL(SMS_API_URL);
  const lib     = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(SMS_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send an SMS message.
 * @param {{ to: string, message: string }} opts
 * @returns {Promise<{ ok: boolean, info?: string }>}
 */
async function sendSMS({ to, message }) {
  const phone = normalisePhone(to);
  if (!phone) {
    console.warn('[sms] No phone number provided — skipping');
    return { ok: false, info: 'no_phone' };
  }

  const provider = (process.env.SMS_PROVIDER || 'generic').toLowerCase();

  if (provider === 'twilio') {
    if (!process.env.TWILIO_ACCOUNT_SID) {
      console.warn('[sms] Twilio not configured — skipping');
      return { ok: false, info: 'not_configured' };
    }
    await sendViaTwilio(phone, message);
    return { ok: true };
  }

  // Generic
  if (!process.env.SMS_API_URL) {
    console.warn('[sms] SMS_API_URL not configured — skipping');
    return { ok: false, info: 'not_configured' };
  }
  await sendViaGeneric(phone, message);
  return { ok: true };
}

module.exports = { sendSMS, normalisePhone };
