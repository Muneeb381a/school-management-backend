const { sendTemplate } = require('./whatsappService');
const db = require('../db');

async function sendBulk(recipients, template, getParams, triggeredBy = 'bulk') {
  let sent = 0, failed = 0;
  const BATCH = 20;
  const DELAY = 1000;

  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH);
    await Promise.all(batch.map(async (r) => {
      if (!r.phone) { failed++; return; }
      const result = await sendTemplate(r.phone, template, getParams(r),
        { student_id: r.student_id, triggered_by: triggeredBy });
      result.status === 'sent' ? sent++ : failed++;
    }));
    if (i + BATCH < recipients.length) {
      await new Promise(res => setTimeout(res, DELAY));
    }
  }
  return { sent, failed, total: recipients.length };
}

async function getRecipients(scope = 'all') {
  let where = '';
  const params = [];
  if (scope?.class_id) {
    params.push(scope.class_id);
    where = `AND s.class_id = $${params.length}`;
  } else if (scope?.section_id) {
    params.push(scope.section_id);
    where = `AND s.section_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT s.id AS student_id, s.name, s.parent_phone AS phone
     FROM students s
     WHERE s.status = 'active' AND s.parent_phone IS NOT NULL ${where}`,
    params
  );
  return rows;
}

module.exports = { sendBulk, getRecipients };
