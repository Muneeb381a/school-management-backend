const { sendTemplate } = require('../services/whatsappService');
const { sendBulk, getRecipients } = require('../services/whatsappBulkService');
const db = require('../db');
const AppError = require('../utils/AppError');

// POST /api/whatsapp/send  — single message
async function sendMessage(req, res) {
  const { phone, template, params = [] } = req.body;
  if (!phone || !template) throw new AppError('phone and template are required', 400);
  const result = await sendTemplate(phone, template, params, {
    triggered_by: req.user?.role || 'manual',
  });
  res.json({ success: true, data: result });
}

// POST /api/whatsapp/bulk  — bulk send to class/section/all
async function sendBulkMessage(req, res) {
  const { scope, template, params = [] } = req.body;
  if (!template) throw new AppError('template is required', 400);
  const recipients = await getRecipients(scope || 'all');
  const result = await sendBulk(
    recipients,
    template,
    () => params,
    req.user?.role || 'bulk'
  );
  res.json({ success: true, data: result });
}

// GET /api/whatsapp/logs
async function getLogs(req, res) {
  const { limit = 50, offset = 0, status } = req.query;
  let where = '';
  const vals = [+limit, +offset];
  if (status) { vals.push(status); where = `WHERE status = $${vals.length}`; }
  const { rows } = await db.query(
    `SELECT * FROM whatsapp_logs ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    vals
  );
  res.json({ success: true, data: rows });
}

// GET /api/whatsapp/stats
async function getStats(req, res) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*) AS count
     FROM whatsapp_logs
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY status`
  );
  const stats = rows.reduce((acc, r) => { acc[r.status] = +r.count; return acc; }, {});
  res.json({ success: true, data: stats });
}

module.exports = { sendMessage, sendBulkMessage, getLogs, getStats };
