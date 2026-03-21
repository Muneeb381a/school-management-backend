/**
 * HTML email templates for SchoolMS.
 * All functions return { subject, html, text } ready for sendMail().
 */

const SCHOOL_NAME = process.env.SCHOOL_NAME || 'SchoolMS';
const PRIMARY     = '#4f46e5'; // indigo-600
const ACCENT      = '#7c3aed'; // violet-600

function base(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${SCHOOL_NAME}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,${PRIMARY},${ACCENT});padding:28px 32px;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-.3px;">${SCHOOL_NAME}</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,.7);font-size:13px;">School Management System</p>
        </td>
      </tr>

      <!-- Body -->
      <tr><td style="padding:32px;">${bodyHtml}</td></tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">
            This is an automated message from ${SCHOOL_NAME}.<br/>
            Please do not reply to this email.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

const PRIORITY_COLORS = {
  urgent: '#ef4444',
  high:   '#f97316',
  normal: '#6366f1',
  low:    '#94a3b8',
};

const TYPE_LABELS = {
  general: 'General Notice',
  exam:    'Exam Notice',
  fee:     'Fee Notice',
  event:   'Event',
  holiday: 'Holiday Notice',
};

/**
 * Announcement broadcast email.
 * @param {{ title, message, type, priority, schoolName? }} opts
 */
function announcementEmail({ title, message, type = 'general', priority = 'normal', schoolName }) {
  const sn       = schoolName || SCHOOL_NAME;
  const typeLabel = TYPE_LABELS[type] || 'Notice';
  const pColor    = PRIORITY_COLORS[priority] || PRIORITY_COLORS.normal;
  const subject   = `[${sn}] ${typeLabel}: ${title}`;

  const html = base(`
    <div style="margin-bottom:20px;">
      <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${pColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">${typeLabel} · ${priority.toUpperCase()}</span>
    </div>
    <h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:700;line-height:1.3;">${title}</h2>
    <div style="background:#f8fafc;border-left:4px solid ${pColor};padding:16px 20px;border-radius:0 8px 8px 0;margin-bottom:24px;">
      <p style="margin:0;color:#334155;font-size:15px;line-height:1.7;">${message.replace(/\n/g, '<br/>')}</p>
    </div>
    <p style="margin:0;color:#94a3b8;font-size:12px;">Sent by ${sn} administration.</p>
  `);

  const text = `${typeLabel.toUpperCase()}: ${title}\n\n${message}\n\n— ${sn}`;
  return { subject, html, text };
}

/**
 * Fee reminder email.
 * @param {{ studentName, invoiceNo, amount, dueDate, status, schoolName? }} opts
 */
function feeReminderEmail({ studentName, invoiceNo, amount, dueDate, status, schoolName }) {
  const sn      = schoolName || SCHOOL_NAME;
  const isOverdue = status === 'overdue';
  const color   = isOverdue ? '#ef4444' : '#f59e0b';
  const label   = isOverdue ? 'OVERDUE' : 'DUE SOON';
  const subject = `[${sn}] Fee ${label}: ${studentName} — ${invoiceNo}`;

  const html = base(`
    <div style="margin-bottom:20px;">
      <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${color};color:#fff;font-size:11px;font-weight:700;letter-spacing:.5px;">FEE ${label}</span>
    </div>
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:700;">Fee Payment Reminder</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">Dear Parent/Guardian of <strong>${studentName}</strong></p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;overflow:hidden;margin-bottom:24px;">
      ${[
        ['Student',    studentName],
        ['Invoice No', invoiceNo],
        ['Amount Due', `PKR ${Number(amount || 0).toLocaleString('en-PK')}`],
        ['Due Date',   dueDate || '—'],
        ['Status',     `<span style="color:${color};font-weight:700;">${label}</span>`],
      ].map(([k, v], i) => `
        <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#ffffff'}">
          <td style="padding:12px 16px;color:#64748b;font-size:13px;font-weight:600;width:140px;">${k}</td>
          <td style="padding:12px 16px;color:#1e293b;font-size:14px;font-weight:500;">${v}</td>
        </tr>`).join('')}
    </table>

    <p style="margin:0 0 8px;color:#334155;font-size:14px;line-height:1.6;">
      Please clear the outstanding fee at the earliest to avoid any inconvenience.
      ${isOverdue ? 'Late payment may incur additional charges.' : ''}
    </p>
    <p style="margin:0;color:#94a3b8;font-size:12px;">Contact the accounts office for any queries.</p>
  `);

  const text = `Fee ${label}\n\nDear Parent/Guardian of ${studentName},\n\nInvoice: ${invoiceNo}\nAmount: PKR ${amount}\nDue Date: ${dueDate}\nStatus: ${label}\n\nPlease clear the outstanding fee.\n\n— ${sn}`;
  return { subject, html, text };
}

/**
 * Absence alert email to parent.
 * @param {{ studentName, absentDays, dateRange, className, schoolName? }} opts
 */
function absenceAlertEmail({ studentName, absentDays, dateRange, className, schoolName }) {
  const sn      = schoolName || SCHOOL_NAME;
  const subject = `[${sn}] Absence Alert: ${studentName} — ${absentDays} day(s)`;

  const html = base(`
    <div style="margin-bottom:20px;">
      <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:#f97316;color:#fff;font-size:11px;font-weight:700;letter-spacing:.5px;">ABSENCE ALERT</span>
    </div>
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:700;">Student Absence Notification</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">Dear Parent/Guardian of <strong>${studentName}</strong></p>

    <div style="background:#fff7ed;border-left:4px solid #f97316;padding:16px 20px;border-radius:0 8px 8px 0;margin-bottom:24px;">
      <p style="margin:0;color:#9a3412;font-size:15px;line-height:1.7;">
        Your child <strong>${studentName}</strong>${className ? ` (${className})` : ''} has been marked
        <strong>absent for ${absentDays} day(s)</strong>${dateRange ? ` (${dateRange})` : ''}.
      </p>
    </div>

    <p style="margin:0 0 8px;color:#334155;font-size:14px;line-height:1.6;">
      If this absence was unplanned, please contact the school administration at your earliest convenience.
    </p>
    <p style="margin:0;color:#94a3b8;font-size:12px;">— ${sn} Administration</p>
  `);

  const text = `Absence Alert\n\nDear Parent/Guardian of ${studentName},\n\nYour child has been absent for ${absentDays} day(s)${dateRange ? ` (${dateRange})` : ''}.\n\nPlease contact the school.\n\n— ${sn}`;
  return { subject, html, text };
}

module.exports = { announcementEmail, feeReminderEmail, absenceAlertEmail };
