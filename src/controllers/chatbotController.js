/**
 * chatbotController.js
 * Handles POST /api/chatbot/query
 *
 * Flow:
 *   1. Receive { message } from authenticated user
 *   2. Detect intent via rule-based engine
 *   3. Query DB for real data (role-scoped)
 *   4. Return human-readable response
 *   5. Log query asynchronously (fire-and-forget)
 */

const AppError = require('../utils/AppError');
const { detectIntent, resolveIntent } = require('../services/chatbotService');
const db = require('../db');

async function handleQuery(req, res) {
  const { message } = req.body;
  if (!message?.trim()) throw new AppError('message is required', 400);

  const user    = req.user;               // injected by verifyToken middleware
  const msgText = message.trim().substring(0, 500); // cap length

  const intent   = detectIntent(msgText);
  const response = await resolveIntent(intent, user);

  // Fire-and-forget log — table may not exist in all environments, hence the catch
  db.query(
    `INSERT INTO chatbot_logs (user_id, message, intent, response_preview, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [user.id, msgText, intent, response.substring(0, 200)]
  ).catch(() => {});

  res.json({ success: true, data: { intent, response } });
}

module.exports = { handleQuery };
