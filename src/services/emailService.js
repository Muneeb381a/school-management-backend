const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587'),
    secure: SMTP_PORT === '465',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[Email] Not configured — skipping send');
    return { status: 'skipped' };
  }
  try {
    const info = await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    return { status: 'sent', messageId: info.messageId };
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return { status: 'failed', error: err.message };
  }
}

async function sendFeeReminder({ parentEmail, studentName, amount, dueDate }) {
  return sendEmail({
    to: parentEmail,
    subject: `Fee Reminder — ${studentName}`,
    html: `<p>Dear Parent,</p><p>This is a reminder that a fee of <strong>PKR ${amount}</strong> for <strong>${studentName}</strong> is due on <strong>${dueDate}</strong>.</p><p>Please ensure timely payment to avoid any inconvenience.</p>`,
    text: `Fee reminder: PKR ${amount} for ${studentName} due on ${dueDate}.`,
  });
}

async function sendPasswordReset({ email, resetUrl }) {
  return sendEmail({
    to: email,
    subject: 'Password Reset Request',
    html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
    text: `Reset your password: ${resetUrl}`,
  });
}

module.exports = { sendEmail, sendFeeReminder, sendPasswordReset };
