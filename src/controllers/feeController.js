const pool     = require('../db');
const AppError = require('../utils/AppError');
const { invalidateDashboard, remember, del: cacheDelete } = require('../utils/cache');
const { serverErr }        = require('../utils/serverErr');
const { parseCSV, validateRows, buildTemplate } = require('../utils/csvImport');
const { buildWorkbook, sendWorkbook }           = require('../utils/excelExport');
const { fireWebhooks }                          = require('../utils/webhookDispatcher');
const { logLifecycleEvent }                     = require('../services/lifecycleService');


// ─── Helpers ────────────────────────────────────────────────
function calcStatus(totalAmount, discountAmount, fineAmount, paidAmount, dueDate) {
  const net = parseFloat(totalAmount) + parseFloat(fineAmount) - parseFloat(discountAmount);
  const paid = parseFloat(paidAmount);
  if (paid >= net - 0.01) return 'paid';
  if (paid > 0)           return 'partial';
  if (dueDate && new Date(dueDate) < new Date()) return 'overdue';
  return 'unpaid';
}

function invoiceNo(month, id) {
  const ym = month ? month.replace('-', '') : new Date().toISOString().slice(0, 7).replace('-', '');
  return `INV-${ym}-${String(id).padStart(5, '0')}`;
}
function receiptNo(id) {
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  return `REC-${ym}-${String(id).padStart(5, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
//  FEE HEADS CRUD
// ═══════════════════════════════════════════════════════════════

const getFeeHeads = async (req, res) => {
  try {
    const { category, is_active } = req.query;
    let q = 'SELECT * FROM fee_heads WHERE 1=1';
    const p = [];
    if (category)               { p.push(category);    q += ` AND category=$${p.length}`; }
    if (is_active !== undefined) { p.push(is_active);   q += ` AND is_active=$${p.length}`; }
    q += ' ORDER BY category, sort_order, name';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const createFeeHead = async (req, res) => {
  try {
    const { name, category, description, sort_order } = req.body;
    if (!name || !category) return res.status(400).json({ success: false, message: 'name and category required' });
    const { rows } = await pool.query(
      `INSERT INTO fee_heads (name, category, description, sort_order)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), category, description || null, sort_order || 0]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const updateFeeHead = async (req, res) => {
  try {
    const { name, category, description, is_active, sort_order } = req.body;
    const { rows } = await pool.query(
      `UPDATE fee_heads SET name=$1, category=$2, description=$3, is_active=$4, sort_order=$5
       WHERE id=$6 RETURNING *`,
      [name, category, description || null, is_active ?? true, sort_order || 0, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Fee head not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const deleteFeeHead = async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM fee_structures WHERE fee_head_id=$1', [req.params.id]
    );
    if (check[0].cnt > 0) return res.status(409).json({ success: false, message: 'Cannot delete: fee head is used in structures' });
    const { rows } = await pool.query('DELETE FROM fee_heads WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Fee head not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  FEE STRUCTURES CRUD
// ═══════════════════════════════════════════════════════════════

const getFeeStructures = async (req, res) => {
  try {
    const { class_id, academic_year, category } = req.query;
    const year = academic_year || '2024-25';
    const cacheKey = `fee:structures:${class_id || 'all'}:${year}:${category || 'all'}`;

    const rows = await remember(cacheKey, 300, async () => {
      let q = `
        SELECT fs.*, fh.name AS fee_head_name, fh.category,
               c.name AS class_name, c.grade, c.section
        FROM fee_structures fs
        JOIN fee_heads fh ON fh.id = fs.fee_head_id
        LEFT JOIN classes c ON c.id = fs.class_id
        WHERE 1=1`;
      const p = [];
      if (class_id)   { p.push(class_id);  q += ` AND fs.class_id=$${p.length}`; }
      if (year)       { p.push(year);       q += ` AND fs.academic_year=$${p.length}`; }
      if (category)   { p.push(category);   q += ` AND fh.category=$${p.length}`; }
      q += ' ORDER BY c.grade, c.section, fh.sort_order, fh.name';
      const { rows } = await pool.query(q, p);
      return rows;
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const upsertFeeStructure = async (req, res) => {
  try {
    const { fee_head_id, class_id, grade, amount, academic_year } = req.body;
    if (!fee_head_id || amount === undefined) {
      return res.status(400).json({ success: false, message: 'fee_head_id and amount required' });
    }
    const year = academic_year || '2024-25';
    const { rows } = await pool.query(
      `INSERT INTO fee_structures (fee_head_id, class_id, grade, amount, academic_year)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fee_head_id, class_id, academic_year) DO UPDATE
         SET amount=$4, grade=$3, is_active=TRUE
       RETURNING *`,
      [fee_head_id, class_id || null, grade || null, amount, year]
    );
    await cacheDelete(`fee:structures:${rows[0].class_id || 'all'}:${rows[0].academic_year}:all`);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const deleteFeeStructure = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM fee_structures WHERE id=$1 RETURNING id, class_id, academic_year', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Structure not found' });
    // Broad invalidation since we don't know which keys exist
    const { delPattern } = require('../utils/cache');
    await delPattern('fee:structures:*');
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  FEE INVOICES
// ═══════════════════════════════════════════════════════════════

// GET /api/fees/invoices
const getInvoices = async (req, res) => {
  try {
    const { student_id, class_id, billing_month, status, invoice_type, academic_year, search, limit = 100, offset = 0 } = req.query;
    let q = `
      SELECT
        fi.*,
        (fi.total_amount + fi.fine_amount - fi.discount_amount)  AS net_amount,
        (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
        s.full_name AS student_name, s.roll_number, s.b_form_no,
        c.name AS class_name, c.grade, c.section
      FROM fee_invoices fi
      JOIN students s ON s.id = fi.student_id
      LEFT JOIN classes c ON c.id = fi.class_id
      WHERE 1=1`;
    const p = [];
    // Teachers only see invoices for classes they are assigned to
    if (req.user.role === 'teacher') {
      p.push(req.user.entity_id);
      q += ` AND fi.class_id IN (SELECT class_id FROM teacher_classes WHERE teacher_id = $${p.length})`;
    }
    if (student_id)    { p.push(student_id);    q += ` AND fi.student_id=$${p.length}`; }
    if (class_id)      { p.push(class_id);      q += ` AND fi.class_id=$${p.length}`; }
    if (billing_month) { p.push(billing_month); q += ` AND fi.billing_month=$${p.length}`; }
    if (status)        { p.push(status);        q += ` AND fi.status=$${p.length}`; }
    if (invoice_type)  { p.push(invoice_type);  q += ` AND fi.invoice_type=$${p.length}`; }
    if (academic_year) { p.push(academic_year); q += ` AND fi.academic_year=$${p.length}`; }
    if (search) {
      p.push(`%${search}%`);
      q += ` AND (s.full_name ILIKE $${p.length} OR fi.invoice_no ILIKE $${p.length} OR s.roll_number ILIKE $${p.length})`;
    }
    // Count query (same WHERE, no ORDER/LIMIT)
    const countQ = q.replace(
      /SELECT[\s\S]+?FROM fee_invoices/,
      'SELECT COUNT(*) AS total FROM fee_invoices'
    );
    const { rows: countRows } = await pool.query(countQ, p);
    const totalCount = parseInt(countRows[0]?.total || 0, 10);

    q += ` ORDER BY fi.created_at DESC LIMIT $${p.push(limit)} OFFSET $${p.push(offset)}`;
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: totalCount, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
  } catch (err) { serverErr(res, err); }
};

// GET /api/fees/invoices/:id  (with items + payments)
const getInvoice = async (req, res) => {
  try {
    // Teachers can only access invoices for classes they are assigned to
    let scopeJoin = '';
    let scopeWhere = '';
    const p = [req.params.id];
    if (req.user.role === 'teacher') {
      p.push(req.user.entity_id);
      scopeJoin  = '';
      scopeWhere = ` AND fi.class_id IN (SELECT class_id FROM teacher_classes WHERE teacher_id = $${p.length})`;
    }

    const { rows: invRows } = await pool.query(
      `SELECT fi.*,
        (fi.total_amount + fi.fine_amount - fi.discount_amount)                  AS net_amount,
        (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
        s.full_name AS student_name, s.roll_number, s.gender, s.phone AS student_phone,
        s.father_name, s.father_phone,
        c.name AS class_name, c.grade, c.section
       FROM fee_invoices fi
       JOIN students s ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = fi.class_id
       WHERE fi.id = $1${scopeWhere}`,
      p
    );
    if (!invRows[0]) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const { rows: items } = await pool.query(
      `SELECT fii.*, fh.category FROM fee_invoice_items fii
       LEFT JOIN fee_heads fh ON fh.id = fii.fee_head_id
       WHERE fii.invoice_id = $1 ORDER BY fii.id`,
      [req.params.id]
    );
    const { rows: payments } = await pool.query(
      `SELECT fp.*, t.full_name AS collector_name
       FROM fee_payments fp
       LEFT JOIN teachers t ON t.id = fp.collected_by
       WHERE fp.invoice_id = $1 AND fp.is_void = FALSE
       ORDER BY fp.payment_date DESC`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...invRows[0], items, payments } });
  } catch (err) { serverErr(res, err); }
};

// POST /api/fees/invoices  — create a custom invoice with manual line items
const createInvoice = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { student_id, invoice_type = 'one_time', billing_month, due_date, notes, items, academic_year } = req.body;

    if (!student_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'student_id is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'At least one fee item is required' });
    }

    const { rows: stuRows } = await client.query('SELECT id, class_id FROM students WHERE id=$1', [student_id]);
    if (!stuRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const validItems = items.filter(it => it.description && parseFloat(it.amount || 0) > 0);
    if (validItems.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'All items must have a description and amount > 0' });
    }

    const total = validItems.reduce((s, it) => s + parseFloat(it.amount), 0);
    const year  = academic_year || '2024-25';

    const { rows: inv } = await client.query(
      `INSERT INTO fee_invoices
         (student_id, class_id, invoice_type, billing_month, due_date, total_amount, academic_year, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [student_id, stuRows[0].class_id, invoice_type, billing_month || null, due_date || null, total, year, notes || null]
    );
    const iid = inv[0].id;
    const ino = invoiceNo(billing_month, iid);
    await client.query('UPDATE fee_invoices SET invoice_no=$1 WHERE id=$2', [ino, iid]);

    for (const item of validItems) {
      await client.query(
        'INSERT INTO fee_invoice_items (invoice_id, fee_head_id, description, amount) VALUES ($1,$2,$3,$4)',
        [iid, item.fee_head_id || null, item.description.trim(), parseFloat(item.amount)]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { id: iid, invoice_no: ino, total_amount: total } });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// POST /api/fees/invoices/generate-monthly
const generateMonthlyFees = async (req, res) => {
  const { class_id, billing_month, academic_year, due_date, student_id } = req.body;
  if (!billing_month) return res.status(400).json({ success: false, message: 'billing_month (YYYY-MM) required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const year = academic_year || '2024-25';

    const { rows: students } = await client.query(
      student_id
        ? `SELECT id, class_id, full_name, transport_required, hostel_required
           FROM students WHERE status='active' AND deleted_at IS NULL AND id=$1`
        : class_id
          ? `SELECT id, class_id, full_name, transport_required, hostel_required
             FROM students WHERE status='active' AND deleted_at IS NULL AND class_id=$1`
          : `SELECT id, class_id, full_name, transport_required, hostel_required
             FROM students WHERE status='active' AND deleted_at IS NULL AND class_id IS NOT NULL`,
      student_id ? [student_id] : class_id ? [class_id] : []
    );

    if (students.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: true, created: 0, skipped: 0, message: 'No active students found' });
    }

    // Get fee structures (monthly)
    const classIds = [...new Set(students.map(s => s.class_id))];
    const { rows: structures } = await client.query(
      `SELECT fs.*, fh.name AS head_name, fh.description AS head_desc
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

    let created = 0, skipped = 0;

    for (const student of students) {
      // Skip if invoice already exists
      const { rows: existing } = await client.query(
        `SELECT id FROM fee_invoices
         WHERE student_id=$1 AND billing_month=$2 AND invoice_type='monthly' AND status!='cancelled'`,
        [student.id, billing_month]
      );
      if (existing.length > 0) { skipped++; continue; }

      const classStructures = byClass[student.class_id] || [];
      if (classStructures.length === 0) { skipped++; continue; }

      // Filter out transport/hostel if not applicable
      const applicable = classStructures.filter(s => {
        const n = (s.head_name || '').toLowerCase();
        if (n.includes('transport') && !student.transport_required) return false;
        if (n.includes('hostel')    && !student.hostel_required)    return false;
        return true;
      });
      if (applicable.length === 0) { skipped++; continue; }

      const total = applicable.reduce((sum, s) => sum + parseFloat(s.amount), 0);

      // Insert invoice
      const { rows: inv } = await client.query(
        `INSERT INTO fee_invoices (student_id, class_id, invoice_type, billing_month, due_date, total_amount, academic_year)
         VALUES ($1,$2,'monthly',$3,$4,$5,$6) RETURNING id`,
        [student.id, student.class_id, billing_month, due_date || null, total, year]
      );
      const iid = inv[0].id;
      const ino = invoiceNo(billing_month, iid);
      await client.query('UPDATE fee_invoices SET invoice_no=$1 WHERE id=$2', [ino, iid]);

      // Insert items
      for (const s of applicable) {
        await client.query(
          `INSERT INTO fee_invoice_items (invoice_id, fee_head_id, description, amount)
           VALUES ($1,$2,$3,$4)`,
          [iid, s.fee_head_id, s.head_name, s.amount]
        );
      }

      // Auto-apply student concessions as discount_amount
      const { rows: concessions } = await client.query(
        `SELECT * FROM student_concessions WHERE student_id=$1 AND is_active=TRUE`,
        [student.id]
      );
      if (concessions.length > 0) {
        let totalDiscount = 0;
        for (const conc of concessions) {
          if (conc.discount_type === 'fixed') {
            totalDiscount += parseFloat(conc.discount_value);
          } else {
            // percent: apply to specific fee head item or to total
            if (conc.fee_head_id) {
              const item = applicable.find(s => s.fee_head_id === conc.fee_head_id);
              if (item) totalDiscount += parseFloat(item.amount) * parseFloat(conc.discount_value) / 100;
            } else {
              totalDiscount += total * parseFloat(conc.discount_value) / 100;
            }
          }
        }
        totalDiscount = Math.min(parseFloat(totalDiscount.toFixed(2)), total);
        if (totalDiscount > 0) {
          await client.query(
            `UPDATE fee_invoices SET discount_amount=$1 WHERE id=$2`,
            [totalDiscount, iid]
          );
        }
      }

      created++;
    }

    await client.query('COMMIT');
    res.json({ success: true, created, skipped, message: `${created} invoices generated, ${skipped} skipped (already exist or no structure)` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// POST /api/fees/invoices/generate-admission/:studentId
const generateAdmissionInvoice = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const studentId = req.params.studentId;
    const { academic_year, due_date, notes } = req.body;
    const year = academic_year || '2024-25';

    // Check student
    const { rows: stuRows } = await client.query(
      'SELECT id, class_id, full_name FROM students WHERE id=$1', [studentId]
    );
    if (!stuRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const student = stuRows[0];

    // Check already has admission invoice
    const { rows: existing } = await client.query(
      `SELECT id FROM fee_invoices WHERE student_id=$1 AND invoice_type='admission' AND status!='cancelled'`,
      [studentId]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Admission invoice already exists for this student' });
    }

    // Get admission fee structures for the class
    const { rows: structures } = await client.query(
      `SELECT fs.*, fh.name AS head_name
       FROM fee_structures fs
       JOIN fee_heads fh ON fh.id = fs.fee_head_id
       WHERE fh.category = 'admission' AND fh.is_active = TRUE
         AND fs.is_active = TRUE AND fs.academic_year = $1
         AND (fs.class_id = $2 OR fs.class_id IS NULL)
       ORDER BY fh.sort_order`,
      [year, student.class_id]
    );

    if (structures.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No admission fee structure defined. Set up fee structures first.' });
    }

    const total = structures.reduce((sum, s) => sum + parseFloat(s.amount), 0);

    const { rows: inv } = await client.query(
      `INSERT INTO fee_invoices (student_id, class_id, invoice_type, due_date, total_amount, academic_year, notes)
       VALUES ($1,$2,'admission',$3,$4,$5,$6) RETURNING id`,
      [studentId, student.class_id, due_date || null, total, year, notes || null]
    );
    const iid = inv[0].id;
    const ino = invoiceNo(null, iid);
    await client.query('UPDATE fee_invoices SET invoice_no=$1 WHERE id=$2', [ino, iid]);

    for (const s of structures) {
      await client.query(
        `INSERT INTO fee_invoice_items (invoice_id, fee_head_id, description, amount) VALUES ($1,$2,$3,$4)`,
        [iid, s.fee_head_id, s.head_name, s.amount]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, invoice_id: iid, invoice_no: ino, total_amount: total });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// PUT /api/fees/invoices/:id
const updateInvoice = async (req, res) => {
  try {
    const { discount_amount, fine_amount, notes, due_date, status } = req.body;
    const { rows: old } = await pool.query('SELECT * FROM fee_invoices WHERE id=$1', [req.params.id]);
    if (!old[0]) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const inv = old[0];

    const disc  = discount_amount !== undefined ? discount_amount : inv.discount_amount;
    const fine  = fine_amount     !== undefined ? fine_amount     : inv.fine_amount;
    const newStatus = status || calcStatus(inv.total_amount, disc, fine, inv.paid_amount, due_date || inv.due_date);

    const { rows } = await pool.query(
      `UPDATE fee_invoices SET discount_amount=$1, fine_amount=$2, notes=$3, due_date=$4,
       status=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [disc, fine, notes || inv.notes, due_date || inv.due_date, newStatus, req.params.id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/fees/invoices/:id  (cancel)
const cancelInvoice = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE fee_invoices SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND paid_amount=0 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(409).json({ success: false, message: 'Cannot cancel: invoice has payments or not found' });
    res.json({ success: true, message: 'Invoice cancelled' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  PAYMENTS
// ═══════════════════════════════════════════════════════════════

// POST /api/fees/payments
const recordPayment = async (req, res) => {
  const { invoice_id, amount, payment_date, payment_method, bank_name, transaction_ref, collected_by, remarks } = req.body;
  if (!invoice_id || !amount) return res.status(400).json({ success: false, message: 'invoice_id and amount required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: invRows } = await client.query(
      'SELECT * FROM fee_invoices WHERE id=$1 FOR UPDATE', [invoice_id]
    );
    if (!invRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    const inv = invRows[0];
    if (['cancelled','waived'].includes(inv.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Cannot pay a ${inv.status} invoice` });
    }

    const net       = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount) - parseFloat(inv.discount_amount);
    const remaining = net - parseFloat(inv.paid_amount);
    const pay       = parseFloat(amount);

    if (pay <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Amount must be > 0' });
    }
    if (pay > remaining + 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Amount exceeds remaining balance of ${remaining.toFixed(2)}` });
    }

    const { rows: payRows } = await client.query(
      `INSERT INTO fee_payments (invoice_id, student_id, amount, payment_date, payment_method,
         bank_name, transaction_ref, collected_by, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [invoice_id, inv.student_id, pay,
       payment_date || new Date().toISOString().slice(0, 10),
       payment_method || 'cash', bank_name || null,
       transaction_ref || null, collected_by || null, remarks || null]
    );
    const pid = payRows[0].id;
    const rno = receiptNo(pid);
    await client.query('UPDATE fee_payments SET receipt_no=$1 WHERE id=$2', [rno, pid]);

    const newPaid   = parseFloat(inv.paid_amount) + pay;
    const newStatus = calcStatus(inv.total_amount, inv.discount_amount, inv.fine_amount, newPaid, inv.due_date);
    await client.query(
      'UPDATE fee_invoices SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3',
      [newPaid, newStatus, invoice_id]
    );

    await client.query('COMMIT');
    invalidateDashboard().catch(() => {});

    const { rows: final } = await pool.query(
      `SELECT fp.*, s.full_name AS student_name, fi.invoice_no
       FROM fee_payments fp
       JOIN students s ON s.id = fp.student_id
       JOIN fee_invoices fi ON fi.id = fp.invoice_id
       WHERE fp.id=$1`,
      [pid]
    );

    // Fire webhook (fire-and-forget — never blocks the response)
    const whEvent = newStatus === 'paid' ? 'fee.paid' : 'fee.partial';
    fireWebhooks(whEvent, {
      invoice_id:     invoice_id,
      invoice_no:     final[0]?.invoice_no,
      student_id:     inv.student_id,
      student_name:   final[0]?.student_name,
      amount:         pay,
      total_paid:     newPaid,
      status:         newStatus,
      payment_method: payment_method || 'cash',
      payment_date:   payment_date || new Date().toISOString().slice(0, 10),
      receipt_no:     rno,
    }).catch(() => {});

    const lcEventType = newStatus === 'paid' ? 'fee_paid' : 'fee_partial';
    const amountFmt   = `PKR ${Number(pay).toLocaleString()}`;
    logLifecycleEvent({
      studentId:   inv.student_id,
      eventType:   lcEventType,
      title:       `Fee ${newStatus === 'paid' ? 'paid' : 'partially paid'} — ${amountFmt}`,
      description: `Invoice ${final[0]?.invoice_no || invoice_id} · Receipt ${rno}`,
      metadata:    {
        invoice_id, invoice_no: final[0]?.invoice_no,
        amount: pay, total_paid: newPaid, status: newStatus,
        payment_method: payment_method || 'cash', receipt_no: rno,
      },
      performedBy: req.user?.id ?? null,
    }).catch(() => {});

    res.status(201).json({ success: true, data: final[0], message: `Payment recorded. Receipt: ${rno}` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// GET /api/fees/payments
const getPayments = async (req, res) => {
  try {
    const { invoice_id, student_id, date_from, date_to, payment_method } = req.query;
    let q = `
      SELECT fp.*, s.full_name AS student_name, fi.invoice_no, fi.billing_month,
             c.name AS class_name, t.full_name AS collector_name
      FROM fee_payments fp
      JOIN students s    ON s.id  = fp.student_id
      JOIN fee_invoices fi ON fi.id = fp.invoice_id
      LEFT JOIN classes c  ON c.id  = fi.class_id
      LEFT JOIN teachers t ON t.id  = fp.collected_by
      WHERE fp.is_void = FALSE`;
    const p = [];
    if (invoice_id)    { p.push(invoice_id);    q += ` AND fp.invoice_id=$${p.length}`; }
    if (student_id)    { p.push(student_id);    q += ` AND fp.student_id=$${p.length}`; }
    if (date_from)     { p.push(date_from);     q += ` AND fp.payment_date>=$${p.length}`; }
    if (date_to)       { p.push(date_to);       q += ` AND fp.payment_date<=$${p.length}`; }
    if (payment_method){ p.push(payment_method);q += ` AND fp.payment_method=$${p.length}`; }
    q += ' ORDER BY fp.payment_date DESC, fp.id DESC LIMIT 200';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/fees/payments/:id  (void)
const voidPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { reason } = req.body;
    const { rows: payRows } = await client.query(
      'SELECT * FROM fee_payments WHERE id=$1 FOR UPDATE', [req.params.id]
    );
    if (!payRows[0] || payRows[0].is_void) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Payment not found or already voided' });
    }
    const p = payRows[0];

    await client.query(
      'UPDATE fee_payments SET is_void=TRUE, voided_at=NOW(), voided_reason=$1 WHERE id=$2',
      [reason || null, p.id]
    );

    // Reverse on invoice
    const { rows: invRows } = await client.query(
      'SELECT * FROM fee_invoices WHERE id=$1 FOR UPDATE', [p.invoice_id]
    );
    const inv = invRows[0];
    const newPaid   = Math.max(0, parseFloat(inv.paid_amount) - parseFloat(p.amount));
    const newStatus = calcStatus(inv.total_amount, inv.discount_amount, inv.fine_amount, newPaid, inv.due_date);
    await client.query(
      'UPDATE fee_invoices SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3',
      [newPaid, newStatus, p.invoice_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Payment voided' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════════
//  REPORTS
// ═══════════════════════════════════════════════════════════════

// GET /api/fees/reports/monthly-summary?month_from&month_to&class_id
const getMonthlySummary = async (req, res) => {
  try {
    const { month_from, month_to, class_id } = req.query;
    const mFrom = month_from || new Date().toISOString().slice(0, 7);
    const mTo   = month_to   || mFrom;
    const p = [mFrom, mTo];
    let classFilter = '';
    if (class_id) { p.push(class_id); classFilter = `AND fi.class_id=$${p.length}`; }

    const { rows } = await pool.query(
      `SELECT
         fi.billing_month,
         COUNT(fi.id)::int                                       AS total_invoices,
         COUNT(fi.id) FILTER (WHERE fi.status='paid')::int       AS paid_count,
         COUNT(fi.id) FILTER (WHERE fi.status='partial')::int    AS partial_count,
         COUNT(fi.id) FILTER (WHERE fi.status IN ('unpaid','overdue'))::int AS unpaid_count,
         SUM(fi.total_amount + fi.fine_amount - fi.discount_amount)        AS total_billed,
         SUM(fi.paid_amount)                                               AS total_collected,
         SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS total_pending
       FROM fee_invoices fi
       WHERE fi.invoice_type = 'monthly'
         AND fi.billing_month BETWEEN $1 AND $2
         AND fi.status != 'cancelled'
         ${classFilter}
       GROUP BY fi.billing_month
       ORDER BY fi.billing_month DESC`,
      p
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// GET /api/fees/reports/outstanding?class_id
const getOutstandingBalances = async (req, res) => {
  try {
    const { class_id, invoice_type } = req.query;
    const p = [];
    let classFilter = '', typeFilter = '';
    if (class_id)     { p.push(class_id);     classFilter = `AND fi.class_id=$${p.length}`; }
    if (invoice_type) { p.push(invoice_type); typeFilter  = `AND fi.invoice_type=$${p.length}`; }

    const { rows } = await pool.query(
      `SELECT
         s.id AS student_id, s.full_name, s.roll_number, s.phone,
         c.name AS class_name, c.grade, c.section,
         COUNT(fi.id)::int                                                             AS invoices,
         SUM(fi.total_amount + fi.fine_amount - fi.discount_amount)::numeric(12,2)    AS total_billed,
         SUM(fi.paid_amount)::numeric(12,2)                                            AS total_paid,
         SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount)::numeric(12,2) AS balance
       FROM students s
       JOIN fee_invoices fi ON fi.student_id = s.id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.deleted_at IS NULL
         AND fi.status IN ('unpaid','partial','overdue')
         ${classFilter} ${typeFilter}
       GROUP BY s.id, s.full_name, s.roll_number, s.phone, c.name, c.grade, c.section
       HAVING SUM(fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) > 0
       ORDER BY balance DESC`,
      p
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /api/fees/reports/student/:id
const getStudentFeeHistory = async (req, res) => {
  try {
    const sid = req.params.id;

    const [invRes, payRes, studentRes, concessionsRes, itemsRes] = await Promise.all([
      pool.query(
        `SELECT fi.*,
           (fi.total_amount + fi.fine_amount - fi.discount_amount)                  AS net_amount,
           (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
           c.name AS class_name
         FROM fee_invoices fi
         LEFT JOIN classes c ON c.id = fi.class_id
         WHERE fi.student_id = $1 AND fi.status != 'cancelled'
         ORDER BY fi.billing_month DESC NULLS LAST, fi.created_at DESC`,
        [sid]
      ),
      pool.query(
        `SELECT fp.*, fi.invoice_no FROM fee_payments fp
         JOIN fee_invoices fi ON fi.id = fp.invoice_id
         WHERE fp.student_id=$1 AND fp.is_void=FALSE ORDER BY fp.payment_date DESC`,
        [sid]
      ),
      pool.query(
        `SELECT s.*, c.name AS class_name
         FROM students s LEFT JOIN classes c ON c.id = s.class_id
         WHERE s.id=$1`,
        [sid]
      ),
      pool.query(
        `SELECT sc.*, fh.name AS fee_head_name
         FROM student_concessions sc
         LEFT JOIN fee_heads fh ON fh.id = sc.fee_head_id
         WHERE sc.student_id=$1 ORDER BY sc.id`,
        [sid]
      ),
      pool.query(
        `SELECT fii.*, fh.name AS fee_head_name
         FROM fee_invoice_items fii
         JOIN fee_invoices fi ON fi.id = fii.invoice_id
         LEFT JOIN fee_heads fh ON fh.id = fii.fee_head_id
         WHERE fi.student_id=$1
         ORDER BY fii.invoice_id, fii.id`,
        [sid]
      ),
    ]);

    const invoices    = invRes.rows;
    const payments    = payRes.rows;
    const student     = studentRes.rows[0] || null;
    const concessions = concessionsRes.rows;

    // Attach items to each invoice
    const itemsByInv = {};
    itemsRes.rows.forEach(item => {
      if (!itemsByInv[item.invoice_id]) itemsByInv[item.invoice_id] = [];
      itemsByInv[item.invoice_id].push(item);
    });

    // Attach payments to each invoice
    const paysByInv = {};
    payments.forEach(p => {
      if (!paysByInv[p.invoice_id]) paysByInv[p.invoice_id] = [];
      paysByInv[p.invoice_id].push(p);
    });

    invoices.forEach(inv => {
      inv.items    = itemsByInv[inv.id] || [];
      inv.payments = paysByInv[inv.id]  || [];
    });

    const totals = invoices.reduce((acc, r) => ({
      billed:    acc.billed    + parseFloat(r.net_amount || 0),
      collected: acc.collected + parseFloat(r.paid_amount || 0),
      balance:   acc.balance   + parseFloat(r.balance || 0),
    }), { billed: 0, collected: 0, balance: 0 });

    res.json({ success: true, student, invoices, payments, totals, concessions });
  } catch (err) { serverErr(res, err); }
};

// GET /api/fees/export  — CSV of invoices
const exportCSV = async (req, res) => {
  try {
    const { billing_month, class_id, status, invoice_type } = req.query;
    const p = [];
    let filters = `WHERE fi.status != 'cancelled'`;
    if (billing_month) { p.push(billing_month); filters += ` AND fi.billing_month=$${p.length}`; }
    if (class_id)      { p.push(class_id);      filters += ` AND fi.class_id=$${p.length}`; }
    if (status)        { p.push(status);         filters += ` AND fi.status=$${p.length}`; }
    if (invoice_type)  { p.push(invoice_type);   filters += ` AND fi.invoice_type=$${p.length}`; }

    const { rows } = await pool.query(
      `SELECT fi.invoice_no, s.full_name, s.roll_number, c.name AS class_name,
              fi.invoice_type, fi.billing_month, fi.total_amount, fi.discount_amount,
              fi.fine_amount,
              (fi.total_amount+fi.fine_amount-fi.discount_amount) AS net_amount,
              fi.paid_amount,
              (fi.total_amount+fi.fine_amount-fi.discount_amount-fi.paid_amount) AS balance,
              fi.status, fi.due_date, fi.created_at::date AS issued_date
       FROM fee_invoices fi
       JOIN students s    ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = fi.class_id
       ${filters}
       ORDER BY fi.created_at DESC LIMIT 5000`,
      p
    );

    const headers = ['Invoice No','Student','Roll No','Class','Type','Month','Total','Discount','Fine','Net','Paid','Balance','Status','Due Date','Issued Date'];
    const csvRows = rows.map(r => [
      r.invoice_no, r.full_name, r.roll_number||'', r.class_name||'',
      r.invoice_type, r.billing_month||'', r.total_amount, r.discount_amount,
      r.fine_amount, r.net_amount, r.paid_amount, r.balance, r.status,
      r.due_date||'', r.issued_date||'',
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="fees_${billing_month || 'all'}.csv"`);
    res.send(csv);
  } catch (err) { serverErr(res, err); }
};

// GET /api/fees/dashboard-stats
const getDashboardStats = async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [invoices, monthlyRow, overdue] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='paid')::int      AS paid_count,
        COUNT(*) FILTER (WHERE status='unpaid')::int    AS unpaid_count,
        COUNT(*) FILTER (WHERE status='partial')::int   AS partial_count,
        COUNT(*) FILTER (WHERE status='overdue')::int   AS overdue_count,
        SUM(total_amount+fine_amount-discount_amount)::numeric(12,2)              AS total_billed,
        SUM(paid_amount)::numeric(12,2)                                            AS total_collected,
        SUM(total_amount+fine_amount-discount_amount-paid_amount)::numeric(12,2)  AS total_pending
        FROM fee_invoices WHERE status!='cancelled'`),
      pool.query(`SELECT
        SUM(paid_amount)::numeric(12,2)                                               AS collected_this_month,
        SUM(total_amount+fine_amount-discount_amount)::numeric(12,2)                  AS billed_this_month,
        COUNT(*)::int                                                                  AS invoices_this_month
        FROM fee_invoices WHERE billing_month=$1 AND status!='cancelled'`, [currentMonth]),
      pool.query(`SELECT COUNT(*)::int AS overdue FROM fee_invoices WHERE status='overdue'`),
    ]);
    res.json({ success: true, data: { ...invoices.rows[0], ...monthlyRow.rows[0], ...overdue.rows[0] } });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BULK PRINT  — GET /api/fees/bulk-print
//  Returns all invoices (with items) matching filters, for batch printing.
// ═══════════════════════════════════════════════════════════════
const getBulkPrintData = async (req, res) => {
  try {
    const { billing_month, class_id, status, invoice_type, ids } = req.query;

    const conditions = [`fi.status != 'cancelled'`];
    const values = [];
    const push = (v) => { values.push(v); return `$${values.length}`; };

    if (ids) {
      const idList = ids.split(',').map(Number).filter(Boolean);
      if (idList.length === 0) return res.json({ success: true, data: [] });
      conditions.push(`fi.id = ANY(${push(idList)}::int[])`);
    } else {
      if (billing_month) conditions.push(`fi.billing_month = ${push(billing_month)}`);
      if (class_id)      conditions.push(`fi.class_id = ${push(Number(class_id))}`);
      if (status)        conditions.push(`fi.status = ${push(status)}`);
      if (invoice_type)  conditions.push(`fi.invoice_type = ${push(invoice_type)}`);
    }

    const { rows: invoices } = await pool.query(
      `SELECT fi.*,
         (fi.total_amount + fi.fine_amount - fi.discount_amount)                  AS net_amount,
         (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
         s.full_name     AS student_name,
         s.roll_number,
         s.father_name,
         s.father_phone,
         s.phone         AS student_phone,
         s.address       AS student_address,
         c.name          AS class_name,
         c.grade,
         c.section
       FROM fee_invoices fi
       JOIN students  s ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = fi.class_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.grade, c.section, s.full_name
       LIMIT 500`,
      values
    );

    if (invoices.length === 0) return res.json({ success: true, data: [], total: 0 });

    const invoiceIds = invoices.map(i => i.id);
    const { rows: allItems } = await pool.query(
      `SELECT fii.invoice_id, fii.description, fii.amount, fii.is_waived, fh.name AS head_name
       FROM fee_invoice_items fii
       LEFT JOIN fee_heads fh ON fh.id = fii.fee_head_id
       WHERE fii.invoice_id = ANY($1::int[])
       ORDER BY fii.invoice_id, fii.id`,
      [invoiceIds]
    );

    const itemMap = {};
    allItems.forEach(it => {
      if (!itemMap[it.invoice_id]) itemMap[it.invoice_id] = [];
      itemMap[it.invoice_id].push(it);
    });

    const data = invoices.map(inv => ({ ...inv, items: itemMap[inv.id] || [] }));
    res.json({ success: true, data, total: data.length });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  PRINT INVOICE  — GET /api/fees/invoices/:id/print
//  Returns everything needed to render a school invoice PDF/page.
// ═══════════════════════════════════════════════════════════════
const getInvoicePrint = async (req, res) => {
  try {
    const { rows: invRows } = await pool.query(
      `SELECT
         fi.id, fi.invoice_no, fi.invoice_type, fi.billing_month,
         fi.due_date, fi.total_amount, fi.paid_amount,
         fi.discount_amount, fi.fine_amount,
         fi.status, fi.notes, fi.academic_year,
         fi.created_at AS issued_at,
         (fi.total_amount + fi.fine_amount - fi.discount_amount)                  AS net_amount,
         (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
         -- Student info
         s.id           AS student_id,
         s.full_name    AS student_name,
         s.roll_number,
         s.father_name,
         s.father_phone,
         s.phone        AS student_phone,
         s.address      AS student_address,
         s.b_form_no,
         -- Class info
         c.id           AS class_id,
         c.name         AS class_name,
         c.grade,
         c.section
       FROM fee_invoices fi
       JOIN students s ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = fi.class_id
       WHERE fi.id = $1`,
      [req.params.id]
    );
    if (!invRows[0]) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const [itemsRes, paymentsRes] = await Promise.all([
      pool.query(
        `SELECT fii.id, fii.description, fii.amount, fii.is_waived,
                fh.name AS head_name, fh.category
         FROM fee_invoice_items fii
         LEFT JOIN fee_heads fh ON fh.id = fii.fee_head_id
         WHERE fii.invoice_id = $1
         ORDER BY fii.id`,
        [req.params.id]
      ),
      pool.query(
        `SELECT fp.id, fp.receipt_no, fp.amount, fp.payment_date,
                fp.payment_method, fp.bank_name, fp.transaction_ref,
                fp.remarks, fp.created_at,
                t.full_name AS collector_name
         FROM fee_payments fp
         LEFT JOIN teachers t ON t.id = fp.collected_by
         WHERE fp.invoice_id = $1 AND fp.is_void = FALSE
         ORDER BY fp.payment_date ASC, fp.id ASC`,
        [req.params.id]
      ),
    ]);

    res.json({
      success: true,
      data: {
        invoice:  invRows[0],
        items:    itemsRes.rows,
        payments: paymentsRes.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  PRINT RECEIPT  — GET /api/fees/payments/:id/receipt
//  Returns everything needed to render a payment receipt.
// ═══════════════════════════════════════════════════════════════
const getReceiptPrint = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         fp.id, fp.receipt_no, fp.amount, fp.payment_date,
         fp.payment_method, fp.bank_name, fp.transaction_ref,
         fp.remarks, fp.is_void, fp.created_at,
         -- Invoice
         fi.id            AS invoice_id,
         fi.invoice_no,
         fi.invoice_type,
         fi.billing_month,
         fi.total_amount,
         fi.discount_amount,
         fi.fine_amount,
         fi.paid_amount,
         (fi.total_amount + fi.fine_amount - fi.discount_amount)                  AS net_amount,
         (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
         fi.status        AS invoice_status,
         -- Student
         s.id             AS student_id,
         s.full_name      AS student_name,
         s.roll_number,
         s.father_name,
         s.phone          AS student_phone,
         s.address,
         -- Class
         c.name           AS class_name,
         c.grade,
         c.section,
         -- Collector
         t.full_name      AS collector_name
       FROM fee_payments fp
       JOIN fee_invoices fi ON fi.id  = fp.invoice_id
       JOIN students     s  ON s.id   = fp.student_id
       LEFT JOIN classes c  ON c.id   = fi.class_id
       LEFT JOIN teachers t ON t.id   = fp.collected_by
       WHERE fp.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Receipt not found' });
    if (rows[0].is_void) return res.status(400).json({ success: false, message: 'This payment has been voided' });

    // All payments on this invoice so we can show "payment X of Y"
    const { rows: siblings } = await pool.query(
      `SELECT id, receipt_no, amount, payment_date, payment_method
       FROM fee_payments
       WHERE invoice_id = $1 AND is_void = FALSE
       ORDER BY payment_date ASC, id ASC`,
      [rows[0].invoice_id]
    );

    res.json({
      success: true,
      data: { ...rows[0], invoice_payments: siblings },
    });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BY-CLASS REPORT  — GET /api/fees/reports/by-class
//  Fee collection grouped by class for a given month / year.
// ═══════════════════════════════════════════════════════════════
const getByClassReport = async (req, res) => {
  try {
    const { billing_month, academic_year = '2024-25', invoice_type } = req.query;
    const conditions = [`fi.status != 'cancelled'`, `fi.academic_year = $1`];
    const values = [academic_year];
    const push = (v) => { values.push(v); return `$${values.length}`; };

    if (billing_month) conditions.push(`fi.billing_month = ${push(billing_month)}`);
    if (invoice_type)  conditions.push(`fi.invoice_type = ${push(invoice_type)}`);

    const { rows } = await pool.query(
      `SELECT
         c.id                                                                               AS class_id,
         c.name                                                                             AS class_name,
         c.grade,
         c.section,
         COUNT(DISTINCT fi.id)::INT                                                        AS total_invoices,
         COUNT(DISTINCT fi.id) FILTER (WHERE fi.status = 'paid')::INT                     AS paid_count,
         COUNT(DISTINCT fi.id) FILTER (WHERE fi.status = 'partial')::INT                  AS partial_count,
         COUNT(DISTINCT fi.id) FILTER (WHERE fi.status IN ('unpaid','overdue'))::INT       AS unpaid_count,
         COUNT(DISTINCT s.id)::INT                                                         AS student_count,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0)           AS total_billed,
         COALESCE(SUM(fi.paid_amount), 0)                                                  AS total_collected,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount
                      - fi.paid_amount), 0)                                                AS total_pending,
         ROUND(
           COALESCE(SUM(fi.paid_amount), 0) * 100.0 /
           NULLIF(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0),
           1
         )                                                                                 AS collection_pct
       FROM classes c
       LEFT JOIN students     s  ON s.class_id  = c.id AND s.status = 'active'
       LEFT JOIN fee_invoices fi ON fi.class_id  = c.id
         AND ${conditions.join(' AND ')}
       WHERE c.status = 'active'
       GROUP BY c.id, c.name, c.grade, c.section
       HAVING COUNT(fi.id) > 0
       ORDER BY c.grade, c.section`,
      values
    );

    const { rows: totRow } = await pool.query(
      `SELECT
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount), 0) AS grand_billed,
         COALESCE(SUM(fi.paid_amount), 0)                                         AS grand_collected,
         COALESCE(SUM(fi.total_amount + fi.fine_amount - fi.discount_amount
                      - fi.paid_amount), 0)                                       AS grand_pending,
         COUNT(*)::INT                                                             AS total_invoices
       FROM fee_invoices fi
       WHERE ${conditions.join(' AND ')}`,
      values
    );

    res.json({ success: true, data: rows, totals: totRow[0] });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  DAILY PAYMENT REPORT  — GET /api/fees/reports/daily
//  Payments grouped by day for a given month (default: current month).
// ═══════════════════════════════════════════════════════════════
const getDailyReport = async (req, res) => {
  try {
    const { month = new Date().toISOString().slice(0, 7), class_id } = req.query;
    const [yr, mo] = month.split('-');
    const dateFrom = `${yr}-${mo}-01`;
    const dateTo   = new Date(Number(yr), Number(mo), 0).toISOString().slice(0, 10);

    const conditions = [`fp.is_void = FALSE`, `fp.payment_date BETWEEN $1 AND $2`];
    const values = [dateFrom, dateTo];
    const push = (v) => { values.push(v); return `$${values.length}`; };

    if (class_id) conditions.push(`fi.class_id = ${push(Number(class_id))}`);

    const { rows } = await pool.query(
      `SELECT
         fp.payment_date,
         TO_CHAR(fp.payment_date, 'Day DD Mon YYYY')              AS date_label,
         COUNT(fp.id)::INT                                         AS payment_count,
         COALESCE(SUM(fp.amount), 0)                               AS total_collected,
         COUNT(fp.id) FILTER (WHERE fp.payment_method='cash')::INT   AS cash_count,
         COALESCE(SUM(fp.amount) FILTER (WHERE fp.payment_method='cash'), 0)   AS cash_amount,
         COUNT(fp.id) FILTER (WHERE fp.payment_method='bank')::INT   AS bank_count,
         COALESCE(SUM(fp.amount) FILTER (WHERE fp.payment_method='bank'), 0)   AS bank_amount,
         COUNT(fp.id) FILTER (WHERE fp.payment_method='online')::INT AS online_count,
         COALESCE(SUM(fp.amount) FILTER (WHERE fp.payment_method='online'), 0) AS online_amount
       FROM fee_payments fp
       JOIN fee_invoices fi ON fi.id = fp.invoice_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY fp.payment_date
       ORDER BY fp.payment_date DESC`,
      values
    );

    const { rows: summaryRow } = await pool.query(
      `SELECT
         COUNT(fp.id)::INT          AS total_transactions,
         COALESCE(SUM(fp.amount), 0) AS month_total,
         COUNT(DISTINCT fp.student_id)::INT AS unique_students
       FROM fee_payments fp
       JOIN fee_invoices fi ON fi.id = fp.invoice_id
       WHERE ${conditions.join(' AND ')}`,
      values
    );

    res.json({ success: true, month, data: rows, summary: summaryRow[0] });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  CONCESSIONS (per-student discounts with reason)
// ═══════════════════════════════════════════════════════════════

const getConcessions = async (req, res) => {
  try {
    const { student_id, class_id } = req.query;
    let q = `
      SELECT sc.*, s.full_name AS student_name, s.roll_number,
             cl.name AS class_name, fh.name AS fee_head_name
      FROM student_concessions sc
      JOIN students s ON s.id = sc.student_id
      LEFT JOIN classes cl ON cl.id = s.class_id
      LEFT JOIN fee_heads fh ON fh.id = sc.fee_head_id
      WHERE 1=1`;
    const p = [];
    if (student_id) { p.push(student_id); q += ` AND sc.student_id=$${p.length}`; }
    if (class_id)   { p.push(class_id);   q += ` AND s.class_id=$${p.length}`; }
    q += ' ORDER BY s.full_name, sc.id';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

const saveConcession = async (req, res) => {
  try {
    const { id, student_id, fee_head_id, discount_type, discount_value, reason, is_active } = req.body;
    if (!student_id || !discount_type || discount_value == null) {
      return res.status(400).json({ success: false, message: 'student_id, discount_type, and discount_value required' });
    }
    if (!['fixed','percent'].includes(discount_type)) {
      return res.status(400).json({ success: false, message: 'discount_type must be fixed or percent' });
    }
    if (id) {
      const { rows } = await pool.query(
        `UPDATE student_concessions
         SET fee_head_id=$1, discount_type=$2, discount_value=$3, reason=$4, is_active=$5
         WHERE id=$6 RETURNING *`,
        [fee_head_id || null, discount_type, discount_value, reason || null, is_active ?? true, id]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: 'Concession not found' });
      res.json({ success: true, data: rows[0] });
    } else {
      const { rows } = await pool.query(
        `INSERT INTO student_concessions (student_id, fee_head_id, discount_type, discount_value, reason)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [student_id, fee_head_id || null, discount_type, parseFloat(discount_value), reason || null]
      );
      res.status(201).json({ success: true, data: rows[0] });
    }
  } catch (err) { serverErr(res, err); }
};

const deleteConcession = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM student_concessions WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Concession not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  APPLY LATE FEES — bulk surcharge on overdue invoices
//  Body: { late_fee_type: 'fixed'|'percent', late_fee_value,
//          billing_month? (YYYY-MM), class_id? }
// ═══════════════════════════════════════════════════════════════

const applyLateFees = async (req, res) => {
  try {
    const { late_fee_type = 'fixed', late_fee_value, billing_month, class_id } = req.body;
    if (!late_fee_value || parseFloat(late_fee_value) <= 0) {
      return res.status(400).json({ success: false, message: 'late_fee_value must be > 0' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const p = [today];
    let q = `
      SELECT fi.id, fi.total_amount, fi.fine_amount, fi.discount_amount, fi.paid_amount
      FROM fee_invoices fi
      WHERE fi.status IN ('unpaid','overdue','partial')
        AND fi.due_date < $1
        AND fi.fine_amount = 0`;
    if (billing_month) { p.push(billing_month); q += ` AND fi.billing_month=$${p.length}`; }
    if (class_id)      { p.push(class_id);      q += ` AND fi.class_id=$${p.length}`; }

    const { rows: invoices } = await pool.query(q, p);
    if (invoices.length === 0) {
      return res.json({ success: true, updated: 0, message: 'No overdue invoices without a late fee found' });
    }

    let updated = 0;
    for (const inv of invoices) {
      const net = parseFloat(inv.total_amount) - parseFloat(inv.discount_amount || 0);
      let fine;
      if (late_fee_type === 'percent') {
        fine = parseFloat(((net * parseFloat(late_fee_value)) / 100).toFixed(2));
      } else {
        fine = parseFloat(parseFloat(late_fee_value).toFixed(2));
      }
      if (fine <= 0) continue;

      const newNet    = net + fine;
      const paid      = parseFloat(inv.paid_amount || 0);
      const newStatus = paid >= newNet - 0.01 ? 'paid' : paid > 0 ? 'partial' : 'overdue';

      await pool.query(
        `UPDATE fee_invoices SET fine_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
        [fine, newStatus, inv.id]
      );
      updated++;
    }

    res.json({ success: true, updated, message: `Late fee applied to ${updated} invoice(s)` });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BULK RECORD PAYMENTS  — POST /api/fees/payments/bulk
//  Records full outstanding payment for each selected invoice.
// ═══════════════════════════════════════════════════════════════
const bulkRecordPayments = async (req, res) => {
  const client = await pool.connect();
  try {
    const { invoice_ids, payment_method = 'cash', payment_date } = req.body;
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0)
      return res.status(400).json({ success: false, message: 'invoice_ids required' });

    const date = payment_date || new Date().toISOString().slice(0, 10);

    // Fetch payable invoices
    const { rows: invoices } = await client.query(
      `SELECT id, student_id, total_amount, paid_amount, fine_amount, discount_amount
       FROM fee_invoices
       WHERE id = ANY($1::int[]) AND status IN ('unpaid','partial','overdue')`,
      [invoice_ids]
    );
    if (invoices.length === 0)
      return res.status(400).json({ success: false, message: 'No payable invoices found in selection' });

    await client.query('BEGIN');
    let saved = 0;

    for (const inv of invoices) {
      const outstanding = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount)
                        - parseFloat(inv.discount_amount) - parseFloat(inv.paid_amount);
      if (outstanding <= 0) continue;

      const receiptNo = `RCPT-${Date.now()}-${inv.id}`;
      await client.query(
        `INSERT INTO fee_payments (invoice_id, student_id, amount, payment_date, payment_method, receipt_no)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [inv.id, inv.student_id, outstanding, date, payment_method, receiptNo]
      );

      const newPaid  = parseFloat(inv.paid_amount) + outstanding;
      const netDue   = parseFloat(inv.total_amount) + parseFloat(inv.fine_amount) - parseFloat(inv.discount_amount);
      const newStatus = newPaid >= netDue - 0.01 ? 'paid' : 'partial';

      await client.query(
        `UPDATE fee_invoices SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
        [newPaid, newStatus, inv.id]
      );
      saved++;
    }

    await client.query('COMMIT');
    res.json({ success: true, saved, message: `${saved} payment(s) recorded` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════════
//  CHALLAN PRINT  — GET /api/fees/invoices/:id/challan
//  Returns invoice data + school/bank settings for fee challan.
// ═══════════════════════════════════════════════════════════════
const getChallanPrint = async (req, res) => {
  try {
    const { rows: invRows } = await pool.query(
      `SELECT
         fi.id, fi.invoice_no, fi.invoice_type, fi.billing_month,
         fi.due_date, fi.total_amount, fi.paid_amount,
         fi.discount_amount, fi.fine_amount,
         fi.status, fi.notes, fi.academic_year,
         fi.created_at AS issued_at,
         (fi.total_amount + fi.fine_amount - fi.discount_amount)                  AS net_amount,
         (fi.total_amount + fi.fine_amount - fi.discount_amount - fi.paid_amount) AS balance,
         s.id           AS student_id,
         s.full_name    AS student_name,
         s.roll_number,
         s.father_name,
         s.father_phone,
         s.phone        AS student_phone,
         s.address      AS student_address,
         c.name         AS class_name,
         c.grade,
         c.section
       FROM fee_invoices fi
       JOIN students s ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = fi.class_id
       WHERE fi.id = $1`,
      [req.params.id]
    );
    if (!invRows[0]) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const [itemsRes, settingsRes] = await Promise.all([
      pool.query(
        `SELECT fii.description, fii.amount, fii.is_waived, fh.name AS head_name
         FROM fee_invoice_items fii
         LEFT JOIN fee_heads fh ON fh.id = fii.fee_head_id
         WHERE fii.invoice_id = $1
         ORDER BY fii.id`,
        [req.params.id]
      ),
      pool.query(
        `SELECT key, value FROM settings
         WHERE key IN (
           'school_name','school_address','school_phone','school_email',
           'school_logo','currency',
           'bank_name','bank_account_title','bank_account_no',
           'bank_iban','bank_branch','bank_branch_code'
         )`
      ),
    ]);

    const settings = {};
    settingsRes.rows.forEach(r => { settings[r.key] = r.value; });

    res.json({
      success: true,
      data: {
        invoice:  invRows[0],
        items:    itemsRes.rows,
        settings,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/fees/payments/import/template ───────────────────────
const getPaymentImportTemplate = (_req, res) => {
  const csv = buildTemplate([
    { header: 'student_roll_number', example1: '101',          example2: '102' },
    { header: 'amount',              example1: '5000',          example2: '3000' },
    { header: 'payment_date',        example1: '2024-02-10',    example2: '2024-02-10' },
    { header: 'payment_method',      example1: 'cash',          example2: 'bank_transfer' },
    { header: 'reference_number',    example1: 'TXN-001',       example2: '' },
    { header: 'remarks',             example1: 'Monthly fee',   example2: '' },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="fee_payments_import_template.csv"');
  res.send(csv);
};

// ── POST /api/fees/payments/import ───────────────────────────────
const importFeePayments = async (req, res, next) => {
  if (!req.file) return next(new AppError('CSV file is required.', 400));

  const { headers, rows } = parseCSV(req.file.buffer);
  if (!rows.length) return next(new AppError('CSV file is empty.', 400));

  const REQUIRED = ['student_roll_number', 'amount', 'payment_date'];
  if (!REQUIRED.every(f => headers.includes(f))) {
    return next(new AppError(`CSV missing required columns: ${REQUIRED.join(', ')}`, 400));
  }

  const { valid, errors } = validateRows(rows, REQUIRED);
  let imported = 0;

  for (const { rowNum, data } of valid) {
    try {
      // Look up student by roll number
      const { rows: stRows } = await pool.query(
        `SELECT s.id FROM students s WHERE s.roll_number = $1 AND s.deleted_at IS NULL LIMIT 1`,
        [data.student_roll_number.trim()]
      );
      if (!stRows[0]) {
        errors.push({ row: rowNum, message: `Student with roll number "${data.student_roll_number}" not found` });
        continue;
      }
      const studentId = stRows[0].id;

      // Find the latest unpaid/overdue/partial invoice for this student
      const { rows: invRows } = await pool.query(
        `SELECT id, total_amount, fine_amount, discount_amount, paid_amount, due_date
         FROM fee_invoices
         WHERE student_id = $1 AND status IN ('unpaid','partial','overdue')
         ORDER BY due_date ASC NULLS LAST LIMIT 1`,
        [studentId]
      );
      if (!invRows[0]) {
        errors.push({ row: rowNum, message: `No unpaid invoice found for roll number "${data.student_roll_number}"` });
        continue;
      }

      const pay = parseFloat(data.amount);
      const inv = invRows[0];
      const rno = receiptNo(Date.now());
      await pool.query(
        `INSERT INTO fee_payments
           (invoice_id, student_id, amount, payment_date, payment_method, transaction_ref, remarks, receipt_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          inv.id,
          studentId,
          pay,
          data.payment_date,
          data.payment_method || 'cash',
          data.reference_number || null,
          data.remarks || null,
          rno,
        ]
      );

      // Update invoice paid_amount and recalculate status
      const newPaid   = parseFloat(inv.paid_amount) + pay;
      const newStatus = calcStatus(inv.total_amount, inv.discount_amount, inv.fine_amount, newPaid, inv.due_date);
      await pool.query(
        `UPDATE fee_invoices SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newPaid, newStatus, inv.id]
      );

      imported++;
    } catch (err) {
      errors.push({ row: rowNum, message: err.message });
    }
  }

  res.json({
    success: true, imported, failed: errors.length, errors,
    message: `Import complete. ${imported} payment(s) recorded, ${errors.length} failed.`,
  });
};

// ── GET /api/fees/export?format=xlsx ────────────────────────────
const exportFeesExcel = async (req, res, next) => {
  try {
    const { billing_month, class_id, status, format = 'csv' } = req.query;
    if (format !== 'xlsx') return exportCSV(req, res, next); // delegate to existing CSV handler

    const params = [];
    let where = 'WHERE 1=1';
    if (billing_month) { params.push(billing_month); where += ` AND fi.billing_month = $${params.length}`; }
    if (class_id)      { params.push(class_id);      where += ` AND s.class_id = $${params.length}`; }
    if (status)        { params.push(status);         where += ` AND fi.status = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT fi.invoice_number, s.full_name, s.roll_number, c.name AS class_name,
              fi.invoice_type, fi.billing_month, fi.total_amount, fi.discount_amount,
              fi.fine_amount, fi.net_amount, fi.paid_amount, fi.status, fi.due_date
       FROM fee_invoices fi
       JOIN students s ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = s.class_id
       ${where} ORDER BY fi.billing_month DESC, s.full_name
       LIMIT 5000`,
      params
    );

    const wb = await buildWorkbook({
      title: 'Fee Collection Report', sheetName: 'Fees',
      subtitle: `Total Invoices: ${rows.length} | Month: ${billing_month || 'All'} | Exported: ${new Date().toLocaleDateString('en-PK')}`,
      columns: [
        { key: 'invoice_number',  header: 'Invoice No',    width: 16 },
        { key: 'full_name',       header: 'Student',       width: 22 },
        { key: 'roll_number',     header: 'Roll No',       width: 10 },
        { key: 'class_name',      header: 'Class',         width: 14 },
        { key: 'billing_month',   header: 'Month',         width: 12 },
        { key: 'total_amount',    header: 'Total',         width: 12, numFmt: '#,##0.00' },
        { key: 'discount_amount', header: 'Discount',      width: 12, numFmt: '#,##0.00' },
        { key: 'fine_amount',     header: 'Fine',          width: 10, numFmt: '#,##0.00' },
        { key: 'net_amount',      header: 'Net',           width: 12, numFmt: '#,##0.00' },
        { key: 'paid_amount',     header: 'Paid',          width: 12, numFmt: '#,##0.00' },
        { key: 'status',          header: 'Status',        width: 10 },
        { key: 'due_date',        header: 'Due Date',      width: 13 },
      ],
      rows,
    });
    return sendWorkbook(res, wb, `fees_${billing_month || 'all'}_${new Date().toISOString().slice(0,10)}.xlsx`);
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════
//  SEND FEE REMINDERS  — POST /api/fees/send-reminders
//  Sends email + SMS reminders for overdue / due-soon invoices.
//  Deduplicates using fee_reminder_log (one per invoice/channel/day).
//  Body: { channel: 'email'|'sms'|'both', status: 'overdue'|'due_soon'|'both' }
// ══════════════════════════════════════════════════════════════
const { sendMail }         = require('../utils/mailer');
const { sendSMS }          = require('../utils/sms');
const { feeReminderEmail } = require('../utils/emailTemplates');

const sendFeeReminders = async (req, res) => {
  const { channel = 'both', status = 'both' } = req.body;
  const client = await pool.connect();
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    const statusFilter =
      status === 'overdue'  ? `fi.status = 'overdue'` :
      status === 'due_soon' ? `fi.status IN ('unpaid','partial') AND fi.due_date BETWEEN '${today}' AND '${in3days}'` :
      `(fi.status = 'overdue' OR (fi.status IN ('unpaid','partial') AND fi.due_date BETWEEN '${today}' AND '${in3days}'))`;

    const { rows: invoices } = await client.query(`
      SELECT fi.id, fi.invoice_no, fi.net_amount, fi.due_date, fi.status,
             s.full_name AS student_name, s.parent_email, s.parent_phone
      FROM fee_invoices fi
      JOIN students s ON s.id = fi.student_id
      WHERE ${statusFilter} AND fi.due_date IS NOT NULL
      ORDER BY fi.due_date ASC
    `);

    let emailsSent = 0, smsSent = 0, skipped = 0;

    for (const inv of invoices) {
      const invStatus = inv.status === 'overdue' ? 'overdue' : 'due_soon';

      // ── Email ────────────────────────────────────────────────
      if (['email', 'both'].includes(channel) && inv.parent_email) {
        const { rows: logRows } = await client.query(
          `SELECT id FROM fee_reminder_log WHERE invoice_id = $1 AND channel = 'email' AND sent_date = CURRENT_DATE`,
          [inv.id]
        );
        if (logRows.length === 0) {
          const tpl = feeReminderEmail({
            studentName: inv.student_name,
            invoiceNo:   inv.invoice_no,
            amount:      inv.net_amount,
            dueDate:     inv.due_date,
            status:      invStatus,
          });
          try {
            await sendMail({ to: inv.parent_email, subject: tpl.subject, html: tpl.html, text: tpl.text });
            await client.query(
              `INSERT INTO fee_reminder_log (invoice_id, channel, sent_to) VALUES ($1, 'email', $2) ON CONFLICT DO NOTHING`,
              [inv.id, inv.parent_email]
            );
            emailsSent++;
          } catch { skipped++; }
        } else { skipped++; }
      }

      // ── SMS ──────────────────────────────────────────────────
      if (['sms', 'both'].includes(channel) && inv.parent_phone) {
        const { rows: logRows } = await client.query(
          `SELECT id FROM fee_reminder_log WHERE invoice_id = $1 AND channel = 'sms' AND sent_date = CURRENT_DATE`,
          [inv.id]
        );
        if (logRows.length === 0) {
          const message = `Dear Parent, fee invoice ${inv.invoice_no} for ${inv.student_name} is ${invStatus === 'overdue' ? 'OVERDUE' : 'due soon'} (PKR ${Number(inv.net_amount || 0).toLocaleString()}). Please clear dues at the earliest.`;
          try {
            const result = await sendSMS({ to: inv.parent_phone, message });
            if (result.ok) {
              await client.query(
                `INSERT INTO fee_reminder_log (invoice_id, channel, sent_to) VALUES ($1, 'sms', $2) ON CONFLICT DO NOTHING`,
                [inv.id, inv.parent_phone]
              );
              smsSent++;
            } else { skipped++; }
          } catch { skipped++; }
        } else { skipped++; }
      }
    }

    res.json({ success: true, invoicesProcessed: invoices.length, emailsSent, smsSent, skipped });
  } catch (err) {
    console.error('[FEE REMINDERS]', err.message);
    return serverErr(res, err);
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════
//  SIBLING VOUCHERS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/fees/sibling-groups?billing_month=YYYY-MM
 *
 * Lists every sibling group that has outstanding (unpaid/partial/overdue)
 * invoices for the given month.  Uses father_cnic as the shared family key.
 *
 * Response shape:
 *   { success, data: [ { father_cnic, students:[{id,full_name,class_name}],
 *                         invoices:[...], combined_total, combined_outstanding } ] }
 */
const getSiblingGroups = async (req, res) => {
  try {
    const { billing_month } = req.query;
    if (!billing_month) {
      return res.status(400).json({ success: false, message: 'billing_month required (YYYY-MM)' });
    }

    // Step 1: find sibling groups via shared father_cnic
    const { rows: groups } = await pool.query(
      `SELECT father_cnic, array_agg(id ORDER BY id) AS student_ids
       FROM students
       WHERE status = 'active'
         AND deleted_at IS NULL
         AND father_cnic IS NOT NULL
         AND father_cnic <> ''
       GROUP BY father_cnic
       HAVING COUNT(*) > 1`,
    );

    if (groups.length === 0) {
      return res.json({ success: true, data: [], total: 0 });
    }

    const allStudentIds = groups.flatMap(g => g.student_ids);

    // Step 2: fetch all monthly invoices for these students in this month
    const { rows: invoices } = await pool.query(
      `SELECT fi.*,
              s.full_name, s.father_cnic,
              c.name AS class_name
       FROM fee_invoices fi
       JOIN students s ON s.id = fi.student_id
       LEFT JOIN classes c ON c.id = fi.class_id
       WHERE fi.student_id = ANY($1::int[])
         AND fi.billing_month = $2
         AND fi.invoice_type = 'monthly'
         AND fi.status <> 'cancelled'
       ORDER BY fi.student_id`,
      [allStudentIds, billing_month],
    );

    // Step 3: group invoices back by father_cnic and compute totals
    const invoiceByStudent = {};
    invoices.forEach(inv => {
      if (!invoiceByStudent[inv.student_id]) invoiceByStudent[inv.student_id] = [];
      invoiceByStudent[inv.student_id].push(inv);
    });

    const data = groups
      .map(g => {
        const groupInvoices = g.student_ids.flatMap(sid => invoiceByStudent[sid] || []);

        // Only include groups that actually have invoices this month
        if (groupInvoices.length === 0) return null;

        const combined_total = groupInvoices.reduce((sum, inv) => {
          return sum + parseFloat(inv.total_amount || 0);
        }, 0);

        const combined_outstanding = groupInvoices.reduce((sum, inv) => {
          const net  = parseFloat(inv.total_amount || 0)
                     + parseFloat(inv.fine_amount   || 0)
                     - parseFloat(inv.discount_amount || 0);
          const paid = parseFloat(inv.paid_amount   || 0);
          return sum + Math.max(0, net - paid);
        }, 0);

        return {
          father_cnic:          g.father_cnic,
          sibling_count:        g.student_ids.length,
          invoices:             groupInvoices,
          combined_total:       parseFloat(combined_total.toFixed(2)),
          combined_outstanding: parseFloat(combined_outstanding.toFixed(2)),
        };
      })
      .filter(Boolean);

    res.json({ success: true, data, total: data.length });
  } catch (err) { serverErr(res, err); }
};

/**
 * GET /api/fees/sibling-voucher?billing_month=YYYY-MM&father_cnic=XXXXX
 *
 * Returns a single combined voucher object for one sibling group.
 * No DB writes — purely a read/aggregation endpoint.
 *
 * Response shape:
 *   { success, voucher: { father_cnic, father_name, billing_month,
 *                          students, line_items, combined_total,
 *                          combined_outstanding, voucher_ref } }
 */
const getSiblingVoucher = async (req, res) => {
  try {
    const { billing_month, father_cnic } = req.query;
    if (!billing_month || !father_cnic) {
      return res.status(400).json({
        success: false,
        message: 'billing_month (YYYY-MM) and father_cnic are required',
      });
    }

    // Fetch all active siblings for this father
    const { rows: siblings } = await pool.query(
      `SELECT s.id, s.full_name, s.father_name, c.name AS class_name
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.father_cnic = $1
         AND s.status = 'active'
         AND s.deleted_at IS NULL
       ORDER BY s.id`,
      [father_cnic],
    );

    if (siblings.length === 0) {
      return res.status(404).json({ success: false, message: 'No active students found for this father_cnic' });
    }

    const studentIds = siblings.map(s => s.id);

    // Fetch invoices + line items for these students this month
    const { rows: invoices } = await pool.query(
      `SELECT fi.*,
              json_agg(
                json_build_object(
                  'description', fii.description,
                  'amount',      fii.amount
                ) ORDER BY fii.id
              ) AS items
       FROM fee_invoices fi
       LEFT JOIN fee_invoice_items fii ON fii.invoice_id = fi.id
       WHERE fi.student_id = ANY($1::int[])
         AND fi.billing_month = $2
         AND fi.invoice_type  = 'monthly'
         AND fi.status       <> 'cancelled'
       GROUP BY fi.id
       ORDER BY fi.student_id`,
      [studentIds, billing_month],
    );

    if (invoices.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No monthly invoices found for billing_month ${billing_month}`,
      });
    }

    // Build per-student sections
    const invoiceByStudent = {};
    invoices.forEach(inv => { invoiceByStudent[inv.student_id] = inv; });

    const students = siblings.map(s => {
      const inv = invoiceByStudent[s.id];
      if (!inv) return { ...s, invoice: null, outstanding: 0 };

      const net = parseFloat(inv.total_amount  || 0)
                + parseFloat(inv.fine_amount    || 0)
                - parseFloat(inv.discount_amount || 0);
      const paid        = parseFloat(inv.paid_amount || 0);
      const outstanding = parseFloat(Math.max(0, net - paid).toFixed(2));

      return {
        student_id:   s.id,
        full_name:    s.full_name,
        class_name:   s.class_name,
        invoice_no:   inv.invoice_no,
        invoice_id:   inv.id,
        total_amount: parseFloat(inv.total_amount),
        discount:     parseFloat(inv.discount_amount || 0),
        fine:         parseFloat(inv.fine_amount     || 0),
        paid:         paid,
        outstanding:  outstanding,
        status:       inv.status,
        items:        inv.items || [],
      };
    });

    const combined_total = students.reduce((sum, s) => sum + (s.total_amount || 0), 0);
    const combined_outstanding = students.reduce((sum, s) => sum + (s.outstanding || 0), 0);

    // Deterministic voucher reference: SVR-YYYYMM-<last6 of cnic>
    const ym  = billing_month.replace('-', '');
    const ref = `SVR-${ym}-${father_cnic.replace(/\D/g, '').slice(-6)}`;

    res.json({
      success: true,
      voucher: {
        voucher_ref:          ref,
        father_cnic:          father_cnic,
        father_name:          siblings[0].father_name || '',
        billing_month:        billing_month,
        students,
        combined_total:       parseFloat(combined_total.toFixed(2)),
        combined_outstanding: parseFloat(combined_outstanding.toFixed(2)),
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getFeeHeads, createFeeHead, updateFeeHead, deleteFeeHead,
  getFeeStructures, upsertFeeStructure, deleteFeeStructure,
  getInvoices, getInvoice, createInvoice, generateMonthlyFees, generateAdmissionInvoice, updateInvoice, cancelInvoice,
  recordPayment, getPayments, voidPayment,
  getMonthlySummary, getOutstandingBalances, getStudentFeeHistory, exportCSV, getDashboardStats,
  getInvoicePrint, getReceiptPrint, getBulkPrintData, getByClassReport, getDailyReport,
  getConcessions, saveConcession, deleteConcession, applyLateFees,
  bulkRecordPayments, getChallanPrint,
  getPaymentImportTemplate, importFeePayments, exportFeesExcel,
  sendFeeReminders,
  getSiblingGroups, getSiblingVoucher,
};
