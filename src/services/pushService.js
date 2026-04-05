const db = require('../db');

// Supports Expo Push Notifications (used by the mobile app)
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPush(tokens, { title, body, data = {} }) {
  if (!tokens || tokens.length === 0) return { sent: 0, failed: 0 };
  const messages = tokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  let sent = 0, failed = 0;
  const BATCH = 100;
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      const json = await res.json();
      (json.data || []).forEach(r => r.status === 'ok' ? sent++ : failed++);
    } catch (err) {
      console.error('[Push] Batch failed:', err.message);
      failed += batch.length;
    }
  }
  return { sent, failed };
}

async function getTokensForStudents(studentIds) {
  if (!studentIds || studentIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT token FROM push_tokens WHERE student_id = ANY($1::int[]) AND active = true`,
    [studentIds]
  );
  return rows.map(r => r.token);
}

async function getTokensForRole(role) {
  const { rows } = await db.query(
    `SELECT token FROM push_tokens WHERE role = $1 AND active = true`,
    [role]
  );
  return rows.map(r => r.token);
}

async function registerToken({ userId, role, token, platform }) {
  await db.query(
    `INSERT INTO push_tokens (user_id, role, token, platform, active, created_at)
     VALUES ($1, $2, $3, $4, true, NOW())
     ON CONFLICT (token) DO UPDATE SET active = true, updated_at = NOW()`,
    [userId, role, token, platform || 'unknown']
  );
}

async function unregisterToken(token) {
  await db.query(`UPDATE push_tokens SET active = false WHERE token = $1`, [token]);
}

module.exports = { sendPush, getTokensForStudents, getTokensForRole, registerToken, unregisterToken };
