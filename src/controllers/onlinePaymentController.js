'use strict';

const pool       = require('../db');
const AppError   = require('../utils/AppError');
const { serverErr } = require('../utils/serverErr');
const {
  initiateJazzCash, verifyJazzCashCallback,
  initiateEasyPaisa, verifyEasyPaisaCallback,
  isSuccess,
} = require('../services/onlinePaymentService');

// ── POST /api/online-payments/initiate ────────────────────────────────────────
// Body: { invoice_id, gateway: 'jazzcash'|'easypaisa', phone }
const initiate = async (req, res, next) => {
  const { invoice_id, gateway, phone } = req.body;
  try {
    if (!invoice_id || !gateway || !phone) {
      return next(new AppError('invoice_id, gateway, and phone are required.', 400));
    }
    if (!['jazzcash', 'easypaisa'].includes(gateway)) {
      return next(new AppError('gateway must be jazzcash or easypaisa.', 400));
    }

    // Fetch invoice
    const { rows } = await pool.query(
      `SELECT fi.id, fi.invoice_no, fi.status, fi.student_id,
              (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
              s.full_name AS student_name
       FROM fee_invoices fi
       JOIN students s ON s.id = fi.student_id
       WHERE fi.id = $1`,
      [invoice_id]
    );
    const inv = rows[0];
    if (!inv) return next(new AppError('Invoice not found.', 404));
    if (inv.status === 'paid') return next(new AppError('Invoice is already paid.', 400));
    if (parseFloat(inv.balance) <= 0) return next(new AppError('No outstanding balance.', 400));

    const amountPKR = parseFloat(inv.balance);
    const description = `School Fee — ${inv.student_name} — ${inv.invoice_no}`;

    // Prevent duplicate pending requests for same invoice
    await pool.query(
      `UPDATE online_payments SET status='expired'
       WHERE invoice_id=$1 AND status='pending' AND initiated_at < NOW() - INTERVAL '1 hour'`,
      [invoice_id]
    );

    let result;
    if (gateway === 'jazzcash') {
      result = await initiateJazzCash({ invoiceNo: inv.invoice_no, amountPKR, phone, description });
    } else {
      result = await initiateEasyPaisa({ invoiceNo: inv.invoice_no, amountPKR, phone, description });
    }

    // Save to DB
    const { rows: saved } = await pool.query(
      `INSERT INTO online_payments
         (invoice_id, student_id, gateway, amount, phone, txn_ref, status, response_code, response_desc, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)
       RETURNING id, txn_ref, status`,
      [
        invoice_id, inv.student_id, gateway, amountPKR, phone,
        result.txnRef, result.responseCode, result.responseDesc,
        JSON.stringify(result.raw),
      ]
    );

    res.json({
      success: true,
      data: {
        id:           saved[0].id,
        txn_ref:      saved[0].txn_ref,
        gateway,
        amount:       amountPKR,
        response_code: result.responseCode,
        response_desc: result.responseDesc,
        message: gateway === 'jazzcash'
          ? 'OTP sent to parent JazzCash number. Ask parent to confirm.'
          : 'OTP sent to parent EasyPaisa number. Ask parent to confirm.',
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ── POST /api/online-payments/jazzcash/callback ───────────────────────────────
// JazzCash posts back to this URL after payment
const jazzcashCallback = async (req, res) => {
  try {
    const params = req.body;

    if (!verifyJazzCashCallback(params)) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const txnRef = params.pp_TxnRefNo;
    const { rows } = await pool.query(
      'SELECT * FROM online_payments WHERE txn_ref=$1', [txnRef]
    );
    const op = rows[0];
    if (!op) return res.status(404).json({ success: false, message: 'Transaction not found' });

    const success = isSuccess('jazzcash', params.pp_ResponseCode);
    const newStatus = success ? 'completed' : 'failed';

    await pool.query(
      `UPDATE online_payments
       SET status=$1, gateway_txn_id=$2, response_code=$3, response_desc=$4,
           raw_response=$5, completed_at=NOW()
       WHERE txn_ref=$6`,
      [newStatus, params.pp_TxnRefNo, params.pp_ResponseCode, params.pp_ResponseMessage,
       JSON.stringify(params), txnRef]
    );

    if (success) await _recordPaymentFromGateway(op, 'jazzcash', params.pp_TxnRefNo);

    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

// ── POST /api/online-payments/easypaisa/callback ──────────────────────────────
const easypaisaCallback = async (req, res) => {
  try {
    const params = req.body;

    if (!verifyEasyPaisaCallback(params)) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const txnRef = params.orderRefNum;
    const { rows } = await pool.query(
      'SELECT * FROM online_payments WHERE txn_ref=$1', [txnRef]
    );
    const op = rows[0];
    if (!op) return res.status(404).json({ success: false, message: 'Transaction not found' });

    const success = isSuccess('easypaisa', params.responseCode);
    const newStatus = success ? 'completed' : 'failed';

    await pool.query(
      `UPDATE online_payments
       SET status=$1, gateway_txn_id=$2, response_code=$3, response_desc=$4,
           raw_response=$5, completed_at=NOW()
       WHERE txn_ref=$6`,
      [newStatus, params.transactionId || '', params.responseCode, params.responseDesc || '',
       JSON.stringify(params), txnRef]
    );

    if (success) await _recordPaymentFromGateway(op, 'easypaisa', params.transactionId || txnRef);

    res.json({ success: true });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/online-payments/status/:txnRef ───────────────────────────────────
const getStatus = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT op.*, fi.invoice_no, s.full_name AS student_name
       FROM online_payments op
       JOIN fee_invoices fi ON fi.id = op.invoice_id
       JOIN students s ON s.id = op.student_id
       WHERE op.txn_ref=$1`,
      [req.params.txnRef]
    );
    if (!rows[0]) return next(new AppError('Transaction not found.', 404));
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/online-payments ──────────────────────────────────────────────────
const list = async (req, res) => {
  try {
    const { invoice_id, student_id, status, gateway, limit = 50, offset = 0 } = req.query;
    const p = []; let q = `
      SELECT op.*, fi.invoice_no, s.full_name AS student_name
      FROM online_payments op
      JOIN fee_invoices fi ON fi.id = op.invoice_id
      JOIN students s ON s.id = op.student_id
      WHERE 1=1`;
    if (invoice_id) { p.push(invoice_id); q += ` AND op.invoice_id=$${p.length}`; }
    if (student_id) { p.push(student_id); q += ` AND op.student_id=$${p.length}`; }
    if (status)     { p.push(status);     q += ` AND op.status=$${p.length}`; }
    if (gateway)    { p.push(gateway);    q += ` AND op.gateway=$${p.length}`; }
    q += ` ORDER BY op.initiated_at DESC LIMIT $${p.push(limit)} OFFSET $${p.push(offset)}`;
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// ── Internal: record payment in fee_payments after successful gateway callback ─
async function _recordPaymentFromGateway(op, gateway, gatewayTxnId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ym = new Date().toISOString().slice(0, 7).replace('-', '');
    const receiptNo = `${gateway === 'jazzcash' ? 'JC' : 'EP'}-${ym}-${String(op.id).padStart(5, '0')}`;

    await client.query(
      `INSERT INTO fee_payments
         (invoice_id, student_id, amount, payment_date, payment_method, transaction_ref, receipt_no)
       VALUES ($1,$2,$3,CURRENT_DATE,'online',$4,$5)
       ON CONFLICT DO NOTHING`,
      [op.invoice_id, op.student_id, op.amount, gatewayTxnId, receiptNo]
    );

    const { rows } = await client.query(
      `SELECT total_amount, fine_amount, discount_amount,
              COALESCE((SELECT SUM(amount) FROM fee_payments WHERE invoice_id=$1 AND is_void=FALSE),0) AS paid
       FROM fee_invoices WHERE id=$1`,
      [op.invoice_id]
    );
    const inv = rows[0];
    const net  = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount) - parseFloat(inv.discount_amount);
    const paid = parseFloat(inv.paid);
    const status = paid >= net - 0.01 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

    await client.query(
      'UPDATE fee_invoices SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3',
      [paid, status, op.invoice_id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

module.exports = { initiate, jazzcashCallback, easypaisaCallback, getStatus, list };
