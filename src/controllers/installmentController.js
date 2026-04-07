const db = require('../db');
const AppError = require('../utils/AppError');

// ── helpers ──────────────────────────────────────────────────────────────────
function calcStatus(amount, paid) {
  const a = parseFloat(amount), p = parseFloat(paid || 0);
  if (p >= a - 0.01) return 'paid';
  if (p > 0) return 'partial';
  return 'unpaid';
}

function installmentDates(startDate, count, intervalDays = 30) {
  const dates = [];
  const base  = new Date(startDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i * intervalDays);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ── GET /api/installments?invoice_id=X ───────────────────────────────────────
async function getInstallments(req, res) {
  const { invoice_id, student_id, status } = req.query;
  const conditions = [];
  const vals = [];

  if (invoice_id) {
    vals.push(invoice_id);
    conditions.push(`fi.invoice_id = $${vals.length}`);
  }
  if (student_id) {
    vals.push(student_id);
    conditions.push(`inv.student_id = $${vals.length}`);
  }
  if (status) {
    vals.push(status);
    conditions.push(`fi.status = $${vals.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT fi.*,
            inv.invoice_no, inv.month, inv.total_amount,
            s.name AS student_name, s.roll_number
     FROM fee_installments fi
     JOIN fee_invoices inv ON inv.id = fi.invoice_id
     JOIN students s       ON s.id   = inv.student_id
     ${where}
     ORDER BY fi.invoice_id, fi.installment_no`,
    vals
  );
  res.json({ success: true, data: rows });
}

// ── POST /api/installments/create ─────────────────────────────────────────────
// Body: { invoice_id, count, start_date, interval_days? }
async function createInstallmentPlan(req, res) {
  const { invoice_id, count, start_date, interval_days = 30 } = req.body;
  if (!invoice_id || !count || !start_date) {
    throw new AppError('invoice_id, count and start_date are required', 400);
  }
  if (count < 2 || count > 12) throw new AppError('count must be between 2 and 12', 400);

  // Load invoice
  const { rows: [inv] } = await db.query(
    `SELECT id, total_amount, discount_amount, fine_amount, paid_amount, has_installments
     FROM fee_invoices WHERE id = $1`, [invoice_id]
  );
  if (!inv) throw new AppError('Invoice not found', 404);
  if (inv.has_installments) throw new AppError('Installment plan already exists for this invoice', 409);

  const net = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount || 0) - parseFloat(inv.discount_amount || 0);
  const perInstallment = net / count;
  const dates = installmentDates(start_date, count, interval_days);

  await db.query('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      await db.query(
        `INSERT INTO fee_installments (invoice_id, installment_no, amount, due_date, status)
         VALUES ($1, $2, $3, $4, 'unpaid')`,
        [invoice_id, i + 1, perInstallment.toFixed(2), dates[i]]
      );
    }
    await db.query(
      `UPDATE fee_invoices SET has_installments = true, installment_count = $1 WHERE id = $2`,
      [count, invoice_id]
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  const { rows } = await db.query(
    `SELECT * FROM fee_installments WHERE invoice_id = $1 ORDER BY installment_no`,
    [invoice_id]
  );
  res.status(201).json({ success: true, data: rows });
}

// ── POST /api/installments/:id/pay ────────────────────────────────────────────
async function payInstallment(req, res) {
  const { id } = req.params;
  const { amount, payment_method = 'cash', notes } = req.body;
  if (!amount) throw new AppError('amount is required', 400);

  const { rows: [inst] } = await db.query(
    `SELECT * FROM fee_installments WHERE id = $1`, [id]
  );
  if (!inst) throw new AppError('Installment not found', 404);
  if (inst.status === 'paid') throw new AppError('Installment already paid', 409);

  const newPaid = parseFloat(inst.paid_amount) + parseFloat(amount);
  const status  = calcStatus(inst.amount, newPaid);

  const { rows: [updated] } = await db.query(
    `UPDATE fee_installments
     SET paid_amount = $1, payment_method = $2, notes = $3,
         status = $4, paid_at = CASE WHEN $4 = 'paid' THEN NOW() ELSE paid_at END
     WHERE id = $5 RETURNING *`,
    [newPaid, payment_method, notes || null, status, id]
  );

  // Sync fee_invoices.paid_amount
  await db.query(
    `UPDATE fee_invoices SET paid_amount = (
       SELECT COALESCE(SUM(paid_amount), 0) FROM fee_installments WHERE invoice_id = $1
     ) WHERE id = $1`,
    [inst.invoice_id]
  );

  res.json({ success: true, data: updated });
}

// ── DELETE /api/installments/invoice/:invoiceId ───────────────────────────────
async function deleteInstallmentPlan(req, res) {
  const { invoiceId } = req.params;
  const { rows: [inv] } = await db.query(
    `SELECT has_installments FROM fee_invoices WHERE id = $1`, [invoiceId]
  );
  if (!inv) throw new AppError('Invoice not found', 404);

  await db.query(`DELETE FROM fee_installments WHERE invoice_id = $1`, [invoiceId]);
  await db.query(
    `UPDATE fee_invoices SET has_installments = false, installment_count = NULL WHERE id = $1`,
    [invoiceId]
  );
  res.json({ success: true, message: 'Installment plan deleted' });
}

// ── GET /api/installments/upcoming ───────────────────────────────────────────
async function getUpcomingInstallments(req, res) {
  const { days = 7 } = req.query;
  const { rows } = await db.query(
    `SELECT fi.*, inv.invoice_no, s.name AS student_name, s.roll_number, c.name AS class_name
     FROM fee_installments fi
     JOIN fee_invoices inv ON inv.id = fi.invoice_id
     JOIN students s       ON s.id   = inv.student_id
     LEFT JOIN classes c   ON c.id   = s.class_id
     WHERE fi.status IN ('unpaid','partial')
       AND fi.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
     ORDER BY fi.due_date, s.name`,
    [+days]
  );
  res.json({ success: true, data: rows });
}

// ── GET /api/installments/overdue ─────────────────────────────────────────────
async function getOverdueInstallments(req, res) {
  const { rows } = await db.query(
    `UPDATE fee_installments
     SET status = 'overdue'
     WHERE status = 'unpaid' AND due_date < CURRENT_DATE
     RETURNING *`
  );
  // Now fetch all overdue
  const { rows: all } = await db.query(
    `SELECT fi.*, inv.invoice_no, s.name AS student_name, s.roll_number, c.name AS class_name
     FROM fee_installments fi
     JOIN fee_invoices inv ON inv.id = fi.invoice_id
     JOIN students s       ON s.id   = inv.student_id
     LEFT JOIN classes c   ON c.id   = s.class_id
     WHERE fi.status = 'overdue'
     ORDER BY fi.due_date, s.name`
  );
  res.json({ success: true, data: all, newly_marked_overdue: rows.length });
}

module.exports = {
  getInstallments, createInstallmentPlan, payInstallment,
  deleteInstallmentPlan, getUpcomingInstallments, getOverdueInstallments,
};
