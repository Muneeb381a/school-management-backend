const pool = require('../db');
const { sendPushToRole, sendPushToUser } = require('../utils/pushNotification');
const { childLogger } = require('../utils/logger');
const log = childLogger('PUSH');

/**
 * POST /api/push/token
 * Save the device push token for the current user.
 * Body: { token: "ExponentPushToken[...]" }
 */
const savePushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, message: 'token is required' });
    }
    await pool.query(
      `UPDATE users SET push_token=$1, push_token_updated_at=NOW() WHERE id=$2`,
      [token.trim(), req.user.id]
    );
    res.json({ success: true, message: 'Push token saved' });
  } catch (err) {
    log.error({ err: err.message }, 'savePushToken error');
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/push/token
 * Remove push token (on logout)
 */
const removePushToken = async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET push_token=NULL, push_token_updated_at=NOW() WHERE id=$1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/push/send — admin broadcasts a push to a role or specific user
 * Body: { role?, userId?, title, body, data? }
 */
const sendPush = async (req, res) => {
  try {
    const { role, userId, title, body, data } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, message: 'title and body required' });

    let result;
    if (userId) {
      result = await sendPushToUser(Number(userId), { title, body, data });
    } else if (role) {
      result = await sendPushToRole(role, { title, body, data });
    } else {
      return res.status(400).json({ success: false, message: 'Provide role or userId' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    log.error({ err: err.message }, 'sendPush error');
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { savePushToken, removePushToken, sendPush };
