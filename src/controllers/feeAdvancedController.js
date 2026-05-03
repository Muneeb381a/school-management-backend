/**
 * feeAdvancedController.js
 * Advanced fee module: late-fee rules engine, student ledger, revenue analytics,
 * fee adjustments (waiver/refund), defaulter actions, fee policy, annual rollover,
 * collection targets, per-collector report, QR receipt data.
 */

const pool      = require('../db');
const { serverErr } = require('../utils/serverErr');

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function calcStatus(total, discount, fine, paid, dueDate) {
  const net  = parseFloat(total) + parseFloat(fine) - parseFloat(discount);
  const p    = parseFloat(paid);
  if (p >= net - 0.01) return 'paid';
  if (p > 0)           return 'partial';
  if (dueDate && new Date(dueDate) < new Date()) return 'overdue';
  return 'unpaid';
}

// ═══════════════════════════════════════════════════════════════
//  LATE FEE RULES ENGINE
// ═══════════════════════════════════════════════════════════════

// GET /fees/late-rules
const getLateRules = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, c.name AS class_name
       FROM fee_late_rules r
       LEFT JOIN classes c ON c.id = r.class_id
       ORDER BY r.is_active DESC, r.id`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /fees/late-rules
const createLateRule = async (req, res) => {
  try {
    const { name, applies_to = 'all', class_id, grade, grace_days = 0,
            fine_type = 'percent', fine_value, max_fine, recurs = false, recur_days } = req.body;
    if (!name || !fine_value)
      return res.status(400).json({ success: false, message: 'name and fine_value required' });

    const { rows } = await pool.query(
      `INSERT INTO fee_late_rules
         (name, applies_to, class_id, grade, grace_days, fine_type, fine_value, max_fine, recurs, recur_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, applies_to, class_id || null, grade || null, grace_days,
       fine_type, fine_value, max_fine || null, recurs, recur_days || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// PUT /fees/late-rules/:id
const updateLateRule = async (req, res) => {
  try {
    const { name, applies_to, class_id, grade, grace_days, fine_type,
            fine_value, max_fine, recurs, recur_days, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE fee_late_rules
       SET name=$1, applies_to=$2, class_id=$3, grade=$4, grace_days=$5,
           fine_type=$6, fine_value=$7, max_fine=$8, recurs=$9, recur_days=$10, is_active=$11
       WHERE id=$12 RETURNING *`,
      [name, applies_to, class_id || null, grade || null, grace_days,
       fine_type, fine_value, max_fine || null, recurs, recur_days || null,
       is_active ?? true, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Rule not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// DELETE /fees/late-rules/:id
const deleteLateRule = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM fee_late_rules WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Rule not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { serverErr(res, err); }
};

// POST /fees/late-rules/run  — evaluate all active rules against overdue invoices
const runLateFeeEngine = async (req, res) => {
  const { billing_month, class_id, dry_run = false } = req.body;
  const client = await pool.connect();
  try {
    const today = new Date();

    // Fetch all active rules
    const { rows: rules } = await client.query(
      `SELECT * FROM fee_late_rules WHERE is_active = TRUE ORDER BY id`
    );
    if (rules.length === 0)
      return res.json({ success: true, updated: 0, message: 'No active rules' });

    // Fetch eligible overdue invoices (unpaid/partial/overdue, past due_date)
    const p = [today.toISOString().slice(0, 10)];
    let q = `
      SELECT fi.id, fi.student_id, fi.class_id,
             fi.total_amount, fi.fine_amount, fi.discount_amount, fi.paid_amount,
             fi.due_date, c.grade
      FROM fee_invoices fi
      LEFT JOIN classes c ON c.id = fi.class_id
      WHERE fi.status IN ('unpaid','partial','overdue')
        AND fi.due_date IS NOT NULL
        AND fi.due_date < $1`;
    if (billing_month) { p.push(billing_month); q += ` AND fi.billing_month=$${p.length}`; }
    if (class_id)      { p.push(class_id);      q += ` AND fi.class_id=$${p.length}`; }

    const { rows: invoices } = await client.query(q, p);
    if (invoices.length === 0)
      return res.json({ success: true, updated: 0, message: 'No eligible overdue invoices' });

    let updated = 0;
    const preview = [];

    if (!dry_run) await client.query('BEGIN');

    for (const inv of invoices) {
      const daysOverdue = Math.floor(
        (today - new Date(inv.due_date)) / (1000 * 60 * 60 * 24)
      );

      // Find the most specific matching rule
      const rule = rules.find(r => {
        if (!r.is_active) return false;
        if (daysOverdue < r.grace_days) return false;
        if (r.applies_to === 'class' && r.class_id && r.class_id !== inv.class_id) return false;
        if (r.applies_to === 'grade' && r.grade && r.grade !== inv.grade) return false;
        return true;
      });
      if (!rule) continue;

      const base = parseFloat(inv.total_amount) - parseFloat(inv.discount_amount || 0);
      let newFine;

      if (rule.recurs) {
        // Recurring: fine multiplied by how many intervals have passed
        const intervals = rule.recur_days > 0
          ? Math.floor((daysOverdue - rule.grace_days) / rule.recur_days) + 1
          : 1;
        const perInterval = rule.fine_type === 'percent'
          ? parseFloat(((base * parseFloat(rule.fine_value)) / 100).toFixed(2))
          : parseFloat(parseFloat(rule.fine_value).toFixed(2));
        newFine = perInterval * intervals;
      } else {
        newFine = rule.fine_type === 'percent'
          ? parseFloat(((base * parseFloat(rule.fine_value)) / 100).toFixed(2))
          : parseFloat(parseFloat(rule.fine_value).toFixed(2));
      }

      // Apply cap
      if (rule.max_fine !== null && newFine > parseFloat(rule.max_fine)) {
        newFine = parseFloat(rule.max_fine);
      }

      // Only update if fine increased
      if (newFine <= parseFloat(inv.fine_amount || 0)) continue;

      const paid      = parseFloat(inv.paid_amount || 0);
      const net       = base + newFine;
      const newStatus = paid >= net - 0.01 ? 'paid' : paid > 0 ? 'partial' : 'overdue';

      if (dry_run) {
        preview.push({ invoice_id: inv.id, old_fine: inv.fine_amount, new_fine: newFine, rule: rule.name });
      } else {
        await client.query(
          `UPDATE fee_invoices SET fine_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
          [newFine, newStatus, inv.id]
        );
      }
      updated++;
    }

    if (!dry_run) await client.query('COMMIT');
    res.json({
      success: true,
      updated,
      dry_run,
      preview: dry_run ? preview : undefined,
      message: dry_run
        ? `Dry run: ${updated} invoice(s) would be updated`
        : `${updated} invoice(s) updated by late-fee engine`,
    });
  } catch (err) {
    if (!dry_run) await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════════
//  FEE POLICY
// ═══════════════════════════════════════════════════════════════

// GET /fees/policy/:year
const getFeePolicy = async (req, res) => {
  try {
    const year = req.params.year || '2024-25';
    const { rows } = await pool.query(
      'SELECT * FROM fee_policy WHERE academic_year=$1', [year]
    );
    if (!rows[0]) {
      // Return sensible defaults if not configured yet
      return res.json({
        success: true,
        data: {
          academic_year: year,
          auto_generate_day: 1,
          carry_forward: false,
          carry_forward_label: 'Arrears',
          lock_after_days: null,
        }
      });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// PUT /fees/policy/:year
const upsertFeePolicy = async (req, res) => {
  try {
    const year = req.params.year;
    const { auto_generate_day = 1, carry_forward = false,
            carry_forward_label = 'Arrears', lock_after_days } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO fee_policy (academic_year, auto_generate_day, carry_forward, carry_forward_label, lock_after_days)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (academic_year) DO UPDATE SET
         auto_generate_day   = EXCLUDED.auto_generate_day,
         carry_forward       = EXCLUDED.carry_forward,
         carry_forward_label = EXCLUDED.carry_forward_label,
         lock_after_days     = EXCLUDED.lock_after_days,
         updated_at          = NOW()
       RETURNING *`,
      [year, auto_generate_day, carry_forward, carry_forward_label, lock_after_days || null]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  STUDENT LEDGER  — bank-statement style
// ═══════════════════════════════════════════════════════════════

// GET /fees/ledger/:studentId?from=YYYY-MM-DD&to=YYYY-MM-DD
const getStudentLedger = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { from, to } = req.query;

    const [stuRes, invRes, payRes] = await Promise.all([
      pool.query(
        `SELECT s.*, c.name AS class_name
         FROM students s LEFT JOIN classes c ON c.id = s.class_id
         WHERE s.id = $1`,
        [studentId]
      ),
      pool.query(
        `SELECT fi.id, fi.invoice_no, fi.invoice_type, fi.billing_month,
                fi.total_amount, fi.discount_amount, fi.fine_amount,
                fi.paid_amount, fi.status, fi.due_date, fi.created_at,
                (fi.total_amount + fi.fine_amount - fi.discount_amount) AS net_amount
         FROM fee_invoices fi
         WHERE fi.student_id = $1 AND fi.status != 'cancelled'
           ${from ? `AND fi.created_at::date >= '${from}'` : ''}
           ${to   ? `AND fi.created_at::date <= '${to}'`   : ''}
         ORDER BY fi.created_at ASC, fi.id ASC`,
        [studentId]
      ),
      pool.query(
        `SELECT fp.id, fp.receipt_no, fp.amount, fp.payment_date,
                fp.payment_method, fp.invoice_id, fp.created_at
         FROM fee_payments fp
         WHERE fp.student_id = $1 AND fp.is_void = FALSE
           ${from ? `AND fp.payment_date >= '${from}'` : ''}
           ${to   ? `AND fp.payment_date <= '${to}'`   : ''}
         ORDER BY fp.payment_date ASC, fp.id ASC`,
        [studentId]
      ),
    ]);

    if (!stuRes.rows[0])
      return res.status(404).json({ success: false, message: 'Student not found' });

    // Build chronological entries
    const entries = [];

    for (const inv of invRes.rows) {
      // Invoice charge
      entries.push({
        date:        inv.created_at,
        type:        'invoice',
        reference:   inv.invoice_no,
        description: `${inv.invoice_type === 'monthly'
          ? `Monthly Fees — ${inv.billing_month}`
          : inv.invoice_type === 'admission'
            ? 'Admission Fees'
            : `Fee Invoice (${inv.invoice_type})`}`,
        debit:       parseFloat(inv.total_amount),
        credit:      0,
        invoice_id:  inv.id,
      });
      // Discount line if any
      if (parseFloat(inv.discount_amount) > 0) {
        entries.push({
          date:        inv.created_at,
          type:        'discount',
          reference:   inv.invoice_no,
          description: 'Concession / Discount',
          debit:       0,
          credit:      parseFloat(inv.discount_amount),
          invoice_id:  inv.id,
        });
      }
      // Fine line if any
      if (parseFloat(inv.fine_amount) > 0) {
        entries.push({
          date:        inv.due_date || inv.created_at,
          type:        'fine',
          reference:   inv.invoice_no,
          description: 'Late Payment Fine',
          debit:       parseFloat(inv.fine_amount),
          credit:      0,
          invoice_id:  inv.id,
        });
      }
    }

    for (const pay of payRes.rows) {
      entries.push({
        date:        pay.payment_date,
        type:        'payment',
        reference:   pay.receipt_no,
        description: `Payment — ${pay.payment_method.charAt(0).toUpperCase() + pay.payment_method.slice(1)}`,
        debit:       0,
        credit:      parseFloat(pay.amount),
        invoice_id:  pay.invoice_id,
        payment_id:  pay.id,
      });
    }

    // Sort all entries by date ascending
    entries.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Attach running balance
    let runningBalance = 0;
    for (const entry of entries) {
      runningBalance += entry.debit - entry.credit;
      entry.balance = parseFloat(runningBalance.toFixed(2));
    }

    const totalBilled    = invRes.rows.reduce((s, r) => s + parseFloat(r.total_amount), 0);
    const totalFines     = invRes.rows.reduce((s, r) => s + parseFloat(r.fine_amount || 0), 0);
    const totalDiscounts = invRes.rows.reduce((s, r) => s + parseFloat(r.discount_amount || 0), 0);
    const totalPaid      = payRes.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    const currentBalance = totalBilled + totalFines - totalDiscounts - totalPaid;

    res.json({
      success: true,
      student: stuRes.rows[0],
      entries,
      summary: {
        total_billed:    parseFloat(totalBilled.toFixed(2)),
        total_fines:     parseFloat(totalFines.toFixed(2)),
        total_discounts: parseFloat(totalDiscounts.toFixed(2)),
        total_paid:      parseFloat(totalPaid.toFixed(2)),
        current_balance: parseFloat(currentBalance.toFixed(2)),
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  REVENUE ANALYTICS
// ═══════════════════════════════════════════════════════════════

// GET /fees/analytics/revenue-trend?months=12
const getRevenueTrend = async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 24);
    const { rows } = await pool.query(
      `SELECT
         fi.billing_month                                                              AS month,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0)      AS invoiced,
         COALESCE(SUM(fi.paid_amount), 0)                                              AS collected,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount
                      - fi.paid_amount), 0)                                            AS pending,
         COUNT(fi.id)::INT                                                             AS invoice_count,
         COUNT(fi.id) FILTER (WHERE fi.status = 'paid')::INT                          AS paid_count
       FROM fee_invoices fi
       WHERE fi.invoice_type = 'monthly'
         AND fi.status != 'cancelled'
         AND fi.billing_month IS NOT NULL
         AND fi.billing_month >= TO_CHAR(NOW() - ($1 || ' months')::interval, 'YYYY-MM')
       GROUP BY fi.billing_month
       ORDER BY fi.billing_month ASC`,
      [months]
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// GET /fees/analytics/class-comparison?billing_month=YYYY-MM
const getClassComparison = async (req, res) => {
  try {
    const { billing_month, academic_year = '2024-25' } = req.query;
    const month = billing_month || new Date().toISOString().slice(0, 7);

    const { rows } = await pool.query(
      `SELECT
         c.id AS class_id,
         c.name AS class_name,
         c.grade,
         c.section,
         COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'active')::INT  AS student_count,
         COUNT(fi.id)::INT                                               AS invoice_count,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0) AS total_billed,
         COALESCE(SUM(fi.paid_amount), 0)                                AS total_collected,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount), 0) AS total_pending,
         ROUND(
           COALESCE(SUM(fi.paid_amount),0) * 100.0 /
           NULLIF(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0), 1
         )                                                               AS collection_pct,
         fct.target_amount
       FROM classes c
       LEFT JOIN students s ON s.class_id = c.id AND s.deleted_at IS NULL
       LEFT JOIN fee_invoices fi
         ON fi.class_id = c.id
         AND fi.billing_month = $1
         AND fi.invoice_type = 'monthly'
         AND fi.status != 'cancelled'
       LEFT JOIN fee_collection_targets fct
         ON fct.class_id = c.id AND fct.month = $1
       WHERE c.status = 'active'
       GROUP BY c.id, c.name, c.grade, c.section, fct.target_amount
       ORDER BY c.grade, c.section`,
      [month]
    );
    res.json({ success: true, data: rows, month });
  } catch (err) { serverErr(res, err); }
};

// GET /fees/analytics/collection-rate
const getCollectionRate = async (req, res) => {
  try {
    const { rows: rateRows } = await pool.query(
      `SELECT
         fi.billing_month,
         ROUND(
           SUM(fi.paid_amount) * 100.0 /
           NULLIF(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0), 1
         ) AS rate
       FROM fee_invoices fi
       WHERE fi.invoice_type = 'monthly'
         AND fi.status != 'cancelled'
         AND fi.billing_month >= TO_CHAR(NOW() - INTERVAL '12 months', 'YYYY-MM')
       GROUP BY fi.billing_month
       ORDER BY fi.billing_month ASC`
    );

    const { rows: avgDaysRows } = await pool.query(
      `SELECT
         ROUND(AVG(fp.payment_date - fi.due_date)) AS avg_days_to_pay
       FROM fee_payments fp
       JOIN fee_invoices fi ON fi.id = fp.invoice_id
       WHERE fp.is_void = FALSE
         AND fi.due_date IS NOT NULL
         AND fp.payment_date >= NOW() - INTERVAL '90 days'`
    );

    const { rows: methodRows } = await pool.query(
      `SELECT payment_method,
              COUNT(*)::INT AS count,
              COALESCE(SUM(amount), 0) AS total
       FROM fee_payments
       WHERE is_void = FALSE
         AND payment_date >= NOW() - INTERVAL '30 days'
       GROUP BY payment_method
       ORDER BY total DESC`
    );

    res.json({
      success: true,
      monthly_rates: rateRows,
      avg_days_to_pay: avgDaysRows[0]?.avg_days_to_pay ?? null,
      payment_methods_30d: methodRows,
    });
  } catch (err) { serverErr(res, err); }
};

// GET /fees/analytics/forecast?months=3
const getForecast = async (req, res) => {
  try {
    const periods = Math.min(parseInt(req.query.months) || 3, 6);

    // Average collection rate from past 6 months
    const { rows: rateRow } = await pool.query(
      `SELECT
         AVG(
           CASE WHEN SUM(fi.total_amount + fi.fine_amount - fi.discount_amount) > 0
                THEN SUM(fi.paid_amount)::float / SUM(fi.total_amount + fi.fine_amount - fi.discount_amount)
                ELSE NULL
           END
         ) AS avg_rate
       FROM fee_invoices fi
       WHERE fi.invoice_type = 'monthly'
         AND fi.status != 'cancelled'
         AND fi.billing_month >= TO_CHAR(NOW() - INTERVAL '6 months', 'YYYY-MM')
       GROUP BY fi.billing_month
       HAVING SUM(fi.total_amount + fi.fine_amount - fi.discount_amount) > 0`
    );

    const avgRate = rateRow.length > 0
      ? rateRow.reduce((s, r) => s + parseFloat(r.avg_rate || 0), 0) / rateRow.length
      : 0.8;

    // Get average monthly invoiced amount
    const { rows: avgRow } = await pool.query(
      `SELECT AVG(monthly_total) AS avg_monthly
       FROM (
         SELECT fi.billing_month,
                SUM(fi.total_amount + fi.fine_amount - fi.discount_amount) AS monthly_total
         FROM fee_invoices fi
         WHERE fi.invoice_type = 'monthly'
           AND fi.status != 'cancelled'
           AND fi.billing_month >= TO_CHAR(NOW() - INTERVAL '3 months', 'YYYY-MM')
         GROUP BY fi.billing_month
       ) monthly`
    );

    const avgMonthly = parseFloat(avgRow[0]?.avg_monthly || 0);

    // Build forecast for next N months
    const forecast = [];
    for (let i = 1; i <= periods; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() + i);
      const month = d.toISOString().slice(0, 7);
      forecast.push({
        month,
        projected_invoiced:  parseFloat(avgMonthly.toFixed(2)),
        projected_collected: parseFloat((avgMonthly * avgRate).toFixed(2)),
        collection_rate_pct: parseFloat((avgRate * 100).toFixed(1)),
      });
    }

    res.json({ success: true, data: forecast, avg_rate_pct: parseFloat((avgRate * 100).toFixed(1)) });
  } catch (err) { serverErr(res, err); }
};

// GET /fees/analytics/defaulter-heatmap
const getDefaulterHeatmap = async (req, res) => {
  try {
    const { billing_month } = req.query;
    const month = billing_month || new Date().toISOString().slice(0, 7);

    const { rows } = await pool.query(
      `SELECT
         c.id AS class_id,
         c.name AS class_name,
         c.grade,
         c.section,
         COUNT(fi.id) FILTER (WHERE fi.status IN ('unpaid','partial','overdue'))::INT AS defaulters,
         COUNT(fi.id)::INT                                                              AS total_invoices,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount)
                  FILTER (WHERE fi.status IN ('unpaid','partial','overdue')), 0)        AS outstanding_amount,
         ROUND(
           COUNT(fi.id) FILTER (WHERE fi.status IN ('unpaid','partial','overdue'))::float * 100
           / NULLIF(COUNT(fi.id), 0), 1
         ) AS defaulter_pct
       FROM classes c
       LEFT JOIN fee_invoices fi
         ON fi.class_id = c.id
         AND fi.billing_month = $1
         AND fi.invoice_type = 'monthly'
         AND fi.status != 'cancelled'
       WHERE c.status = 'active'
       GROUP BY c.id, c.name, c.grade, c.section
       HAVING COUNT(fi.id) > 0
       ORDER BY defaulter_pct DESC NULLS LAST, outstanding_amount DESC`,
      [month]
    );
    res.json({ success: true, data: rows, month });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  FEE ADJUSTMENTS (Waiver / Refund / Correction)
// ═══════════════════════════════════════════════════════════════

// GET /fees/adjustments
const getAdjustments = async (req, res) => {
  try {
    const { status, student_id, invoice_id } = req.query;
    const p = [];
    let where = 'WHERE 1=1';
    if (status)     { p.push(status);     where += ` AND fa.status=$${p.length}`; }
    if (student_id) { p.push(student_id); where += ` AND fa.student_id=$${p.length}`; }
    if (invoice_id) { p.push(invoice_id); where += ` AND fa.invoice_id=$${p.length}`; }

    const { rows } = await pool.query(
      `SELECT fa.*,
              s.full_name AS student_name, s.roll_number,
              fi.invoice_no,
              c.name AS class_name,
              req.name AS requested_by_name,
              apv.name AS approved_by_name
       FROM fee_adjustments fa
       JOIN students s       ON s.id  = fa.student_id
       JOIN fee_invoices fi  ON fi.id = fa.invoice_id
       LEFT JOIN classes c   ON c.id  = s.class_id
       LEFT JOIN users req   ON req.id = fa.requested_by
       LEFT JOIN users apv   ON apv.id = fa.approved_by
       ${where}
       ORDER BY fa.requested_at DESC`,
      p
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /fees/adjustments
const createAdjustment = async (req, res) => {
  try {
    const { invoice_id, type, amount, reason } = req.body;
    if (!invoice_id || !type || !amount || !reason)
      return res.status(400).json({ success: false, message: 'invoice_id, type, amount, reason required' });
    if (!['waiver','refund','correction','fine_waiver'].includes(type))
      return res.status(400).json({ success: false, message: 'Invalid type' });

    const { rows: invRows } = await pool.query(
      'SELECT student_id FROM fee_invoices WHERE id=$1', [invoice_id]
    );
    if (!invRows[0]) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const { rows } = await pool.query(
      `INSERT INTO fee_adjustments (invoice_id, student_id, type, amount, reason, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [invoice_id, invRows[0].student_id, type, amount, reason, req.user?.id || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// POST /fees/adjustments/:id/approve
const approveAdjustment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { notes } = req.body;

    const { rows: adjRows } = await client.query(
      'SELECT * FROM fee_adjustments WHERE id=$1 FOR UPDATE', [req.params.id]
    );
    if (!adjRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Adjustment not found' });
    }
    const adj = adjRows[0];
    if (adj.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: `Already ${adj.status}` });
    }

    // Apply adjustment to invoice
    const { rows: invRows } = await client.query(
      'SELECT * FROM fee_invoices WHERE id=$1 FOR UPDATE', [adj.invoice_id]
    );
    const inv = invRows[0];
    let updateQ;

    if (adj.type === 'waiver' || adj.type === 'correction') {
      const newDiscount = parseFloat(inv.discount_amount || 0) + parseFloat(adj.amount);
      const net = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount || 0) - newDiscount;
      const paid = parseFloat(inv.paid_amount || 0);
      const newStatus = paid >= net - 0.01 ? 'paid' : paid > 0 ? 'partial' : net <= 0 ? 'waived' : inv.status;
      updateQ = client.query(
        `UPDATE fee_invoices SET discount_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
        [newDiscount, newStatus, adj.invoice_id]
      );
    } else if (adj.type === 'fine_waiver') {
      const newFine = Math.max(0, parseFloat(inv.fine_amount || 0) - parseFloat(adj.amount));
      const net = parseFloat(inv.total_amount) + newFine - parseFloat(inv.discount_amount || 0);
      const paid = parseFloat(inv.paid_amount || 0);
      const newStatus = paid >= net - 0.01 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
      updateQ = client.query(
        `UPDATE fee_invoices SET fine_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
        [newFine, newStatus, adj.invoice_id]
      );
    } else if (adj.type === 'refund') {
      // Refund: add a negative payment (reduce paid_amount)
      const newPaid = Math.max(0, parseFloat(inv.paid_amount || 0) - parseFloat(adj.amount));
      const net = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount || 0) - parseFloat(inv.discount_amount || 0);
      const newStatus = newPaid >= net - 0.01 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';
      updateQ = client.query(
        `UPDATE fee_invoices SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
        [newPaid, newStatus, adj.invoice_id]
      );
    }

    await updateQ;
    await client.query(
      `UPDATE fee_adjustments SET status='approved', approved_by=$1, resolved_at=NOW(), notes=$2 WHERE id=$3`,
      [req.user?.id || null, notes || null, adj.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Adjustment approved and applied' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// POST /fees/adjustments/:id/reject
const rejectAdjustment = async (req, res) => {
  try {
    const { notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE fee_adjustments SET status='rejected', approved_by=$1, resolved_at=NOW(), notes=$2
       WHERE id=$3 AND status='pending' RETURNING id`,
      [req.user?.id || null, notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Pending adjustment not found' });
    res.json({ success: true, message: 'Adjustment rejected' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  DEFAULTER ACTIONS
// ═══════════════════════════════════════════════════════════════

// GET /fees/defaulters/actions?student_id=
const getDefaulterActions = async (req, res) => {
  try {
    const { student_id } = req.query;
    const p = [];
    let where = 'WHERE 1=1';
    if (student_id) { p.push(student_id); where += ` AND da.student_id=$${p.length}`; }

    const { rows } = await pool.query(
      `SELECT da.*,
              s.full_name AS student_name, s.roll_number,
              c.name AS class_name,
              u.name AS taken_by_name
       FROM fee_defaulter_actions da
       JOIN students s  ON s.id  = da.student_id
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN users u   ON u.id = da.taken_by
       ${where}
       ORDER BY da.taken_at DESC
       LIMIT 100`,
      p
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /fees/defaulters/actions
const addDefaulterAction = async (req, res) => {
  try {
    const { student_id, invoice_ids = [], action_type, notes, amount_owed } = req.body;
    if (!student_id || !action_type)
      return res.status(400).json({ success: false, message: 'student_id and action_type required' });

    const { rows } = await pool.query(
      `INSERT INTO fee_defaulter_actions (student_id, invoice_ids, action_type, notes, amount_owed, taken_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [student_id, invoice_ids, action_type, notes || null, amount_owed || null, req.user?.id || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// GET /fees/defaulters/list  — rich defaulter list with last action
const getDefaultersList = async (req, res) => {
  try {
    const { class_id, days_overdue, billing_month } = req.query;
    const p = [];
    let filters = `AND fi.status IN ('unpaid','partial','overdue')`;
    if (class_id)      { p.push(class_id);     filters += ` AND fi.class_id=$${p.length}`; }
    if (billing_month) { p.push(billing_month); filters += ` AND fi.billing_month=$${p.length}`; }

    const { rows } = await pool.query(
      `SELECT
         s.id AS student_id,
         s.full_name, s.roll_number, s.parent_phone,
         c.name AS class_name, c.grade, c.section,
         COUNT(fi.id)::INT                                                                AS invoice_count,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount), 0) AS total_owed,
         MIN(fi.due_date)                                                                  AS oldest_due_date,
         CURRENT_DATE - MIN(fi.due_date)                                                  AS days_overdue,
         (SELECT action_type FROM fee_defaulter_actions da2
          WHERE da2.student_id = s.id ORDER BY da2.taken_at DESC LIMIT 1)                AS last_action,
         (SELECT taken_at FROM fee_defaulter_actions da3
          WHERE da3.student_id = s.id ORDER BY da3.taken_at DESC LIMIT 1)                AS last_action_at
       FROM students s
       JOIN fee_invoices fi ON fi.student_id = s.id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.deleted_at IS NULL
         ${filters}
       GROUP BY s.id, s.full_name, s.roll_number, s.parent_phone, c.name, c.grade, c.section
       HAVING COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount), 0) > 0
         ${days_overdue ? `AND (CURRENT_DATE - MIN(fi.due_date)) >= ${parseInt(days_overdue)}` : ''}
       ORDER BY total_owed DESC, days_overdue DESC NULLS LAST`,
      p
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  ANNUAL ROLLOVER
// ═══════════════════════════════════════════════════════════════

// POST /fees/rollover   { from_year, to_year, increment_pct }
const rolloverFeeStructures = async (req, res) => {
  try {
    const { from_year, to_year, increment_pct = 0 } = req.body;
    if (!from_year || !to_year)
      return res.status(400).json({ success: false, message: 'from_year and to_year required' });
    if (from_year === to_year)
      return res.status(400).json({ success: false, message: 'from_year and to_year must differ' });

    // Check target year doesn't already exist
    const { rows: existing } = await pool.query(
      'SELECT COUNT(*)::INT AS cnt FROM fee_structures WHERE academic_year=$1', [to_year]
    );
    if (existing[0].cnt > 0)
      return res.status(409).json({
        success: false,
        message: `Fee structures for ${to_year} already exist (${existing[0].cnt} rows). Delete them first.`
      });

    const factor = 1 + parseFloat(increment_pct) / 100;

    const { rows: source } = await pool.query(
      `SELECT fee_head_id, class_id, grade, ROUND(amount * $1, 2) AS new_amount
       FROM fee_structures
       WHERE academic_year = $2 AND is_active = TRUE`,
      [factor, from_year]
    );
    if (source.length === 0)
      return res.status(404).json({ success: false, message: `No structures found for ${from_year}` });

    // Bulk insert
    const values = source.map((r, i) => {
      const base = i * 4;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4})`;
    }).join(',');
    const params = source.flatMap(r => [r.fee_head_id, r.class_id, r.grade, r.new_amount]);

    // Build placeholders manually for the INSERT
    const placeholders = [];
    const args = [to_year];
    source.forEach((r, i) => {
      const o = 1 + i * 4;
      placeholders.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$1)`);
      args.push(r.fee_head_id, r.class_id, r.grade, r.new_amount);
    });

    await pool.query(
      `INSERT INTO fee_structures (fee_head_id, class_id, grade, amount, academic_year)
       VALUES ${placeholders.join(',')}`,
      args
    );

    res.json({
      success: true,
      copied: source.length,
      increment_pct: parseFloat(increment_pct),
      message: `${source.length} structures rolled over from ${from_year} to ${to_year}` +
               (increment_pct > 0 ? ` with ${increment_pct}% increase` : ''),
    });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  COLLECTION TARGETS
// ═══════════════════════════════════════════════════════════════

// GET /fees/targets?month=YYYY-MM
const getCollectionTargets = async (req, res) => {
  try {
    const { month = new Date().toISOString().slice(0, 7) } = req.query;
    const { rows } = await pool.query(
      `SELECT fct.*, c.name AS class_name, c.grade, c.section
       FROM fee_collection_targets fct
       JOIN classes c ON c.id = fct.class_id
       WHERE fct.month = $1
       ORDER BY c.grade, c.section`,
      [month]
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /fees/targets  { class_id, month, target_amount, academic_year }
const setCollectionTarget = async (req, res) => {
  try {
    const { class_id, month, target_amount, academic_year = '2024-25' } = req.body;
    if (!class_id || !month || !target_amount)
      return res.status(400).json({ success: false, message: 'class_id, month, target_amount required' });

    const { rows } = await pool.query(
      `INSERT INTO fee_collection_targets (class_id, month, target_amount, academic_year)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (class_id, month)
       DO UPDATE SET target_amount = EXCLUDED.target_amount, academic_year = EXCLUDED.academic_year
       RETURNING *`,
      [class_id, month, target_amount, academic_year]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// DELETE /fees/targets/:id
const deleteCollectionTarget = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM fee_collection_targets WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Target not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  PER-COLLECTOR DAILY REPORT
// ═══════════════════════════════════════════════════════════════

// GET /fees/reports/collector?date=YYYY-MM-DD
const getCollectorReport = async (req, res) => {
  try {
    const { date = new Date().toISOString().slice(0, 10) } = req.query;
    const { rows } = await pool.query(
      `SELECT
         COALESCE(t.full_name, 'Self / Walk-in') AS collector_name,
         fp.collected_by,
         COUNT(fp.id)::INT                          AS payment_count,
         COALESCE(SUM(fp.amount), 0)                AS total_collected,
         COUNT(fp.id) FILTER (WHERE fp.payment_method = 'cash')::INT    AS cash_count,
         COALESCE(SUM(fp.amount) FILTER (WHERE fp.payment_method = 'cash'), 0)    AS cash_amount,
         COUNT(fp.id) FILTER (WHERE fp.payment_method = 'bank')::INT    AS bank_count,
         COALESCE(SUM(fp.amount) FILTER (WHERE fp.payment_method = 'bank'), 0)    AS bank_amount,
         COUNT(fp.id) FILTER (WHERE fp.payment_method = 'online')::INT  AS online_count,
         COALESCE(SUM(fp.amount) FILTER (WHERE fp.payment_method = 'online'), 0)  AS online_amount
       FROM fee_payments fp
       LEFT JOIN teachers t ON t.id = fp.collected_by
       WHERE fp.is_void = FALSE AND fp.payment_date = $1
       GROUP BY fp.collected_by, t.full_name
       ORDER BY total_collected DESC`,
      [date]
    );
    res.json({ success: true, data: rows, date });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  QR RECEIPT VERIFICATION  (public — no auth)
// ═══════════════════════════════════════════════════════════════

// GET /fees/verify-receipt/:receiptNo   (no auth required)
const verifyReceipt = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fp.receipt_no, fp.amount, fp.payment_date, fp.payment_method,
              fp.is_void,
              fi.invoice_no, fi.billing_month, fi.invoice_type,
              s.full_name AS student_name, s.roll_number,
              c.name AS class_name
       FROM fee_payments fp
       JOIN fee_invoices fi ON fi.id = fp.invoice_id
       JOIN students s      ON s.id  = fp.student_id
       LEFT JOIN classes c  ON c.id  = fi.class_id
       WHERE fp.receipt_no = $1`,
      [req.params.receiptNo]
    );
    if (!rows[0]) return res.status(404).json({ verified: false, message: 'Receipt not found' });

    const r = rows[0];
    if (r.is_void)
      return res.json({
        verified: false,
        voided:   true,
        receipt_no: r.receipt_no,
        message: 'This payment has been voided',
      });

    res.json({
      verified:       true,
      receipt_no:     r.receipt_no,
      student_name:   r.student_name,
      roll_number:    r.roll_number,
      class_name:     r.class_name,
      amount:         r.amount,
      payment_date:   r.payment_date,
      payment_method: r.payment_method,
      invoice_no:     r.invoice_no,
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  // Late fee rules
  getLateRules, createLateRule, updateLateRule, deleteLateRule, runLateFeeEngine,
  // Fee policy
  getFeePolicy, upsertFeePolicy,
  // Student ledger
  getStudentLedger,
  // Analytics
  getRevenueTrend, getClassComparison, getCollectionRate, getForecast, getDefaulterHeatmap,
  // Adjustments
  getAdjustments, createAdjustment, approveAdjustment, rejectAdjustment,
  // Defaulter actions
  getDefaulterActions, addDefaulterAction, getDefaultersList,
  // Rollover
  rolloverFeeStructures,
  // Targets
  getCollectionTargets, setCollectionTarget, deleteCollectionTarget,
  // Collector report
  getCollectorReport,
  // QR verify
  verifyReceipt,
};
