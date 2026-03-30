/**
 * automationService.js
 * Core logic for all smart automated features:
 *   1. Attendance insights (consecutive absences, at-risk students)
 *   2. Monthly fee auto-generation
 *   3. Fee reminder escalation (Day 1 / 7 / 15)
 *   4. Weekly fee defaulter report email to admin
 */

const pool = require('../db');
const { sendMail } = require('../utils/mailer');

// ─── helpers ──────────────────────────────────────────────────────────────────

function today()     { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }

/** Insert a notification row (fire-and-forget safe) */
async function notify(client, { userId, title, message, type = 'info', link = null }) {
  await client.query(
    `INSERT INTO notifications (user_id, title, message, type, link)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId ?? null, title, message, type, link]
  );
}

// ─── 1. ATTENDANCE INSIGHTS ───────────────────────────────────────────────────

/**
 * Returns all active students annotated with:
 *   - attendance_pct  (this month, 0-100)
 *   - consecutive_absences  (streak ending today or yesterday)
 *   - is_at_risk  (pct < threshold)
 *   - is_chronic_absent (consecutive >= 3)
 */
async function getAttendanceInsights({ threshold = 75 } = {}) {
  const month = thisMonth();

  const { rows } = await pool.query(`
    WITH monthly AS (
      SELECT
        a.entity_id                                        AS student_id,
        COUNT(*) FILTER (WHERE a.status IN ('present','late')) AS present_count,
        COUNT(*)                                           AS total_marked
      FROM attendance a
      WHERE a.entity_type = 'student'
        AND TO_CHAR(a.date, 'YYYY-MM') = $1
        AND a.period_id IS NULL
      GROUP BY a.entity_id
    ),
    streak AS (
      SELECT
        a.entity_id AS student_id,
        COUNT(*)    AS consecutive_absences
      FROM attendance a
      WHERE a.entity_type = 'student'
        AND a.status = 'absent'
        AND a.period_id IS NULL
        AND a.date >= (
          SELECT COALESCE(MAX(a2.date), CURRENT_DATE - INTERVAL '30 days')
          FROM attendance a2
          WHERE a2.entity_id = a.entity_id
            AND a2.entity_type = 'student'
            AND a2.status != 'absent'
            AND a2.period_id IS NULL
        )
      GROUP BY a.entity_id
    )
    SELECT
      s.id, s.full_name, s.roll_number, s.photo_url, s.father_phone,
      c.id   AS class_id,
      c.name AS class_name, c.section AS class_section,
      COALESCE(m.present_count, 0)                  AS present_count,
      COALESCE(m.total_marked,  0)                  AS total_marked,
      CASE WHEN COALESCE(m.total_marked,0) > 0
           THEN ROUND(m.present_count * 100.0 / m.total_marked)
           ELSE NULL END                            AS attendance_pct,
      COALESCE(str.consecutive_absences, 0)         AS consecutive_absences
    FROM students s
    LEFT JOIN classes   c   ON c.id = s.class_id
    LEFT JOIN monthly   m   ON m.student_id = s.id
    LEFT JOIN streak    str ON str.student_id = s.id
    WHERE s.status = 'active'
    ORDER BY consecutive_absences DESC, attendance_pct ASC NULLS LAST
  `, [month]);

  return rows.map(r => ({
    ...r,
    is_at_risk:        r.attendance_pct !== null && r.attendance_pct < threshold,
    is_chronic_absent: r.consecutive_absences >= 3,
  }));
}

/**
 * Run daily: find students with 3+ consecutive absences and create
 * a notification for each (deduped per student per day).
 */
async function runAttendanceInsights() {
  const insights = await getAttendanceInsights();
  const chronic  = insights.filter(s => s.is_chronic_absent);
  if (!chronic.length) return { flagged: 0 };

  const client = await pool.connect();
  let flagged = 0;
  try {
    await client.query('BEGIN');
    const dt = today();
    for (const s of chronic) {
      // Dedup: skip if we already notified today
      const { rows: dup } = await client.query(
        `SELECT 1 FROM notifications
         WHERE link = $1 AND created_at::date = $2 LIMIT 1`,
        [`/students/${s.id}`, dt]
      );
      if (dup.length) continue;

      await notify(client, {
        title:   `⚠️ Attendance Alert: ${s.full_name}`,
        message: `${s.full_name} (${s.class_name}${s.class_section ? ' ' + s.class_section : ''}) has been absent for ${s.consecutive_absences} consecutive day(s).`,
        type:    'warning',
        link:    `/students/${s.id}`,
      });
      flagged++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { flagged };
}

// ─── 2. MONTHLY FEE AUTO-GENERATION ──────────────────────────────────────────

/**
 * Auto-generate monthly fee invoices for all active students.
 * Safe to call multiple times — skips already-generated invoices.
 * Designed to run on the 1st of every month.
 */
async function runMonthlyFeeGeneration({ billing_month, academic_year } = {}) {
  const month = billing_month || thisMonth();
  const year  = academic_year || '2024-25';

  // Get all active students with a class
  const { rows: students } = await pool.query(
    `SELECT id, class_id FROM students WHERE status='active' AND class_id IS NOT NULL`
  );
  if (!students.length) return { created: 0, skipped: 0 };

  const classIds = [...new Set(students.map(s => s.class_id))];

  // Get monthly fee structures for those classes
  const { rows: structures } = await pool.query(
    `SELECT fs.class_id, fs.amount, fh.name AS head_name, fh.id AS fee_head_id,
            fh.description AS head_desc
     FROM fee_structures fs
     JOIN fee_heads fh ON fh.id = fs.fee_head_id
     WHERE fh.category = 'monthly' AND fh.is_active = TRUE
       AND fs.is_active = TRUE AND fs.academic_year = $1
       AND fs.class_id = ANY($2::int[])`,
    [year, classIds]
  );

  const byClass = {};
  structures.forEach(s => {
    if (!byClass[s.class_id]) byClass[s.class_id] = [];
    byClass[s.class_id].push(s);
  });

  const client = await pool.connect();
  let created = 0, skipped = 0;
  try {
    await client.query('BEGIN');

    for (const student of students) {
      const classStructures = byClass[student.class_id];
      if (!classStructures?.length) { skipped++; continue; }

      const { rows: existing } = await client.query(
        `SELECT id FROM fee_invoices
         WHERE student_id=$1 AND billing_month=$2
           AND invoice_type='monthly' AND status!='cancelled'`,
        [student.id, month]
      );
      if (existing.length) { skipped++; continue; }

      const total = classStructures.reduce((s, r) => s + parseFloat(r.amount), 0);
      const dueDate = `${month}-${new Date(new Date(month + '-01').setDate(15)).getDate()}`;

      const { rows: inv } = await client.query(
        `INSERT INTO fee_invoices
           (student_id, class_id, invoice_type, billing_month, due_date, total_amount, academic_year)
         VALUES ($1,$2,'monthly',$3,$4,$5,$6) RETURNING id`,
        [student.id, student.class_id, month, dueDate, total, year]
      );
      const invoiceId = inv[0].id;

      // Insert items
      for (const s of classStructures) {
        await client.query(
          `INSERT INTO fee_invoice_items (invoice_id, fee_head_id, description, amount)
           VALUES ($1,$2,$3,$4)`,
          [invoiceId, s.fee_head_id, s.head_name, s.amount]
        );
      }
      created++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Create admin notification
  if (created > 0) {
    await pool.query(
      `INSERT INTO notifications (title, message, type, link)
       VALUES ($1,$2,'info','/fees')`,
      [`Fee Invoices Generated: ${month}`,
       `${created} monthly fee invoice(s) were auto-generated for ${month}.`]
    );
  }

  return { created, skipped, month };
}

// ─── 3. FEE REMINDER ESCALATION ───────────────────────────────────────────────

/**
 * Run daily. For each unpaid/partial invoice, send reminders at:
 *   Day 1  after due date → in-app notification
 *   Day 7  after due date → in-app notification (escalated)
 *   Day 15 after due date → in-app notification (principal level)
 */
async function runFeeReminders() {
  const { rows: overdue } = await pool.query(`
    SELECT
      fi.id, fi.student_id, fi.billing_month, fi.total_amount, fi.due_date,
      fi.status,
      CURRENT_DATE - fi.due_date AS days_overdue,
      s.full_name, s.father_name, s.father_phone,
      c.name AS class_name, c.section AS class_section
    FROM fee_invoices fi
    JOIN students s ON s.id = fi.student_id
    LEFT JOIN classes c ON c.id = fi.class_id
    WHERE fi.status IN ('unpaid','partial')
      AND fi.due_date < CURRENT_DATE
      AND fi.invoice_type = 'monthly'
    ORDER BY days_overdue DESC
  `);

  let reminded = 0;
  for (const inv of overdue) {
    const days = parseInt(inv.days_overdue);
    if (![1, 7, 15].includes(days)) continue;

    const level   = days === 1 ? 'Reminder' : days === 7 ? 'Second Notice' : '⚠️ Final Notice';
    const amount  = parseFloat(inv.total_amount).toLocaleString('en-PK');
    const student = `${inv.full_name} (${inv.class_name}${inv.class_section ? ' ' + inv.class_section : ''})`;

    await pool.query(
      `INSERT INTO notifications (title, message, type, link)
       VALUES ($1,$2,$3,$4)`,
      [
        `Fee ${level}: ${inv.full_name}`,
        `${student} — PKR ${amount} due ${inv.billing_month}. ${days} day(s) overdue.`,
        days >= 15 ? 'error' : days >= 7 ? 'warning' : 'info',
        `/fees?student_id=${inv.student_id}`,
      ]
    );
    reminded++;
  }

  return { reminded, checked: overdue.length };
}

// ─── 4. WEEKLY FEE DEFAULTER REPORT ──────────────────────────────────────────

/**
 * Run every Monday. Email admin a summary of students with unpaid fees.
 */
async function runFeeDefaulterReport() {
  const { rows: defaulters } = await pool.query(`
    SELECT
      s.full_name, s.father_name, s.father_phone,
      c.name AS class_name, c.section,
      COUNT(fi.id)        AS invoice_count,
      SUM(fi.total_amount - COALESCE(fi.paid_amount, 0)) AS outstanding
    FROM fee_invoices fi
    JOIN students s ON s.id = fi.student_id
    LEFT JOIN classes c ON c.id = fi.class_id
    WHERE fi.status IN ('unpaid','partial')
    GROUP BY s.id, s.full_name, s.father_name, s.father_phone, c.name, c.section
    ORDER BY outstanding DESC
  `);

  if (!defaulters.length) return { sent: false, count: 0 };

  // Get admin emails
  const { rows: admins } = await pool.query(
    `SELECT email FROM users WHERE role='admin' AND email IS NOT NULL`
  );
  if (!admins.length) return { sent: false, count: defaulters.length };

  const rows = defaulters.map((d, i) =>
    `<tr>
       <td>${i + 1}</td>
       <td>${d.full_name}</td>
       <td>${d.class_name || ''}${d.section ? ' ' + d.section : ''}</td>
       <td>${d.father_name || '—'}</td>
       <td>${d.father_phone || '—'}</td>
       <td>${d.invoice_count}</td>
       <td><strong>PKR ${parseFloat(d.outstanding).toLocaleString('en-PK')}</strong></td>
     </tr>`
  ).join('');

  const html = `
    <h2>Weekly Fee Defaulter Report</h2>
    <p>Generated: ${new Date().toLocaleDateString('en-PK', { dateStyle: 'full' })}</p>
    <p><strong>${defaulters.length}</strong> student(s) have outstanding fees.</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead style="background:#f3f4f6">
        <tr><th>#</th><th>Student</th><th>Class</th><th>Father</th><th>Phone</th><th>Invoices</th><th>Outstanding</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  for (const admin of admins) {
    await sendMail({
      to:      admin.email,
      subject: `Fee Defaulter Report — ${new Date().toLocaleDateString('en-PK')}`,
      html,
    });
  }

  return { sent: true, count: defaulters.length };
}

module.exports = {
  getAttendanceInsights,
  runAttendanceInsights,
  runMonthlyFeeGeneration,
  runFeeReminders,
  runFeeDefaulterReport,
};
