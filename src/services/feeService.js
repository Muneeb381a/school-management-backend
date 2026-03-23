const pool = require('../db');

// Calculate net amount for a fee invoice
function calcNet(totalAmount, fineAmount = 0, discountAmount = 0) {
  return Number(totalAmount) + Number(fineAmount) - Number(discountAmount);
}

// Determine invoice status from amounts and due date
function calcStatus(totalAmount, discountAmount, fineAmount, paidAmount, dueDate) {
  const net = calcNet(totalAmount, fineAmount, discountAmount);
  const paid = Number(paidAmount) || 0;

  if (paid >= net - 0.01) return 'paid';
  if (paid > 0) return 'partial';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  if (due < today) return 'overdue';

  return 'unpaid';
}

// Generate invoice number: INV-YYYYMM-00001
function invoiceNo(month, id) {
  const yyyymm = String(month).replace('-', '');
  const seq = String(id).padStart(5, '0');
  return `INV-${yyyymm}-${seq}`;
}

// Generate receipt number: REC-YYYYMM-00001
function receiptNo(id) {
  const now = new Date();
  const yyyymm =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0');
  const seq = String(id).padStart(5, '0');
  return `REC-${yyyymm}-${seq}`;
}

// Get outstanding balance for a student
async function getStudentOutstanding(studentId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_amount + fine_amount - discount_amount - paid_amount), 0)::numeric AS outstanding
     FROM fee_invoices
     WHERE student_id = $1
       AND status != 'paid'
       AND status != 'cancelled'`,
    [studentId]
  );
  return Number(rows[0].outstanding);
}

// Get monthly fee collection summary for a given month (YYYY-MM)
async function getMonthlyCollection(month) {
  const [colResult, invResult] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS collected
       FROM fee_payments
       WHERE TO_CHAR(payment_date, 'YYYY-MM') = $1`,
      [month]
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_amount), 0)::numeric AS invoiced
       FROM fee_invoices
       WHERE TO_CHAR(due_date, 'YYYY-MM') = $1
         AND status != 'cancelled'`,
      [month]
    ),
  ]);

  const collected = Number(colResult.rows[0].collected);
  const invoiced = Number(invResult.rows[0].invoiced);
  const rate = invoiced > 0 ? (collected / invoiced) * 100 : 0;

  return { collected, invoiced, rate };
}

// Check if a student has overdue fees (returns boolean)
async function hasOverdueFees(studentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM fee_invoices
     WHERE student_id = $1
       AND status = 'overdue'`,
    [studentId]
  );
  return rows[0].cnt > 0;
}

module.exports = {
  calcNet,
  calcStatus,
  invoiceNo,
  receiptNo,
  getStudentOutstanding,
  getMonthlyCollection,
  hasOverdueFees,
};
