/**
 * Thin nodemailer wrapper.
 * Configure via environment variables:
 *   EMAIL_HOST    — SMTP host     (e.g. smtp.gmail.com)
 *   EMAIL_PORT    — SMTP port     (default 587)
 *   EMAIL_SECURE  — 'true' for port 465 TLS (default false)
 *   EMAIL_USER    — SMTP username / Gmail address
 *   EMAIL_PASS    — SMTP password / Gmail App Password
 *   EMAIL_FROM    — Sender display name + address (default: EMAIL_USER)
 *
 * If EMAIL_HOST is not set, sendMail() logs a warning and does nothing —
 * so the app still works in development without email configured.
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const { EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE, EMAIL_USER, EMAIL_PASS } = process.env;

  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASS) {
    return null; // email not configured
  }

  _transporter = nodemailer.createTransport({
    host:   EMAIL_HOST,
    port:   parseInt(EMAIL_PORT || '587', 10),
    secure: EMAIL_SECURE === 'true',
    auth:   { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  return _transporter;
}

/**
 * Send an email.
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 * @returns {Promise<void>}
 */
async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn('[mailer] EMAIL_HOST/USER/PASS not configured — skipping email send.');
    return;
  }

  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  await transporter.sendMail({ from, to, subject, html, text });
}

module.exports = { sendMail };
