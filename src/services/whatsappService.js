const axios = require('axios');
const db    = require('../db');

const BASE_URL     = 'https://graph.facebook.com/v19.0';
const PHONE_ID     = () => process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = () => process.env.WA_ACCESS_TOKEN;

async function sendTemplate(to, template, components = [], meta = {}) {
  if (!PHONE_ID() || !ACCESS_TOKEN()) {
    console.warn('[WhatsApp] Not configured — skipping send');
    return { status: 'skipped' };
  }

  const parameters = components.map(text => ({ type: 'text', text: String(text) }));
  const payload = {
    messaging_product: 'whatsapp',
    to: to.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: template,
      language: { code: 'en' },
      components: parameters.length ? [{ type: 'body', parameters }] : [],
    },
  };

  let waMessageId = null, status = 'sent', error = null;
  try {
    const { data } = await axios.post(
      `${BASE_URL}/${PHONE_ID()}/messages`, payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN()}`, 'Content-Type': 'application/json' } }
    );
    waMessageId = data?.messages?.[0]?.id || null;
  } catch (err) {
    status = 'failed';
    error  = err.response?.data?.error?.message || err.message;
    console.error('[WhatsApp] Send failed:', error);
  }

  // Log attempt
  try {
    await db.query(
      `INSERT INTO whatsapp_logs
         (to_phone, template, params, status, wa_message_id, error, student_id, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [to, template, JSON.stringify(components), status, waMessageId, error,
       meta.student_id || null, meta.triggered_by || null]
    );
  } catch { /* non-fatal */ }

  return { status, waMessageId, error };
}

module.exports = { sendTemplate };
