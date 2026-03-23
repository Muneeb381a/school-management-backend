/**
 * Bulk email job processor.
 * job.data: { recipients: Array<{to, name}>, subject, template, vars }
 */

/**
 * Process a bulk email job.
 * Sends one email per recipient with a small delay to avoid SMTP rate limits.
 */
async function processBulkEmail(job) {
  const { sendMail } = require('../../utils/mailer');
  const { recipients, subject, html } = job.data;
  const results = { sent: 0, failed: 0, errors: [] };

  for (const recipient of recipients) {
    try {
      await sendMail({ to: recipient.to, subject, html: html.replace('{{name}}', recipient.name || 'Student') });
      results.sent++;
    } catch (err) {
      results.failed++;
      results.errors.push({ to: recipient.to, message: err.message });
    }
    // Small delay to avoid SMTP rate limits
    await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

module.exports = { processBulkEmail };
