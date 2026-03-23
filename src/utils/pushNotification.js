/**
 * Expo Push Notification utility.
 * Sends notifications via Expo's push API (HTTP v2).
 * Does NOT require Firebase or APNs setup — Expo handles it.
 *
 * Usage:
 *   const { sendPush, sendPushToUsers } = require('../utils/pushNotification');
 *   await sendPush({ token: 'ExponentPushToken[xxx]', title: 'Fee Due', body: 'Rs 5000 is due' });
 */

const https = require('https');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a single push notification.
 * @param {{ token: string, title: string, body: string, data?: object, sound?: string }} msg
 */
async function sendPush({ token, title, body, data = {}, sound = 'default' }) {
  if (!token || !token.startsWith('ExponentPushToken')) {
    return { status: 'skipped', reason: 'invalid token' };
  }

  const payload = JSON.stringify({ to: token, title, body, data, sound });

  return new Promise((resolve) => {
    const req = https.request(
      EXPO_PUSH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed?.data ?? parsed);
          } catch {
            resolve({ status: 'error', raw });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ status: 'error', message: err.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * Send to multiple tokens. Returns array of results.
 */
async function sendPushToMany(messages) {
  return Promise.all(messages.map(sendPush));
}

/**
 * Send push to all users of a given role.
 * Queries users table for push_token WHERE role = role AND push_token IS NOT NULL
 */
async function sendPushToRole(role, { title, body, data = {} }) {
  const pool = require('../db');
  const { rows } = await pool.query(
    `SELECT push_token FROM users WHERE role=$1 AND push_token IS NOT NULL`,
    [role]
  );
  const results = await sendPushToMany(
    rows.map(r => ({ token: r.push_token, title, body, data }))
  );
  return { sent: rows.length, results };
}

/**
 * Send push to a specific user by user.id
 */
async function sendPushToUser(userId, { title, body, data = {} }) {
  const pool = require('../db');
  const { rows: [user] } = await pool.query(
    `SELECT push_token FROM users WHERE id=$1 AND push_token IS NOT NULL`,
    [userId]
  );
  if (!user?.push_token) return { status: 'no_token' };
  return sendPush({ token: user.push_token, title, body, data });
}

module.exports = { sendPush, sendPushToMany, sendPushToRole, sendPushToUser };
