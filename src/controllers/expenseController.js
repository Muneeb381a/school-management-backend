const pool     = require('../db');
const AppError = require('../utils/AppError');
const { parseCSV, validateRows, buildTemplate } = require('../utils/csvImport');
const { buildWorkbook, sendWorkbook }           = require('../utils/excelExport');
const { serverErr } = require('../utils/serverErr');


// ── Shared base SELECT ────────────────────────────────────────
const BASE_SELECT = `
  SELECT
    e.id,
    e.category_id,
    ec.category_name,
    ec.icon        AS category_icon,
    ec.color       AS category_color,
    e.title,
    e.description,
    e.amount,
    e.expense_date,
    e.payment_method,
    e.reference_number,
    e.receipt_url,
    e.status,
    e.fiscal_year,
    e.created_by_type,
    e.created_by_id,
    e.created_at,
    e.updated_at
  FROM expenses e
  JOIN expense_categories ec ON ec.id = e.category_id
  WHERE e.is_deleted = FALSE
`;

// ══════════════════════════════════════════════════════════════
//  CATEGORIES — GET /api/expenses/categories
// ══════════════════════════════════════════════════════════════
const getCategories = async (req, res) => {
  try {
    const { active_only = 'true' } = req.query;
    const where = active_only === 'true' ? 'WHERE is_active = TRUE' : '';
    const { rows } = await pool.query(
      `SELECT * FROM expense_categories ${where} ORDER BY category_name`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

const createCategory = async (req, res) => {
  try {
    const { category_name, description, icon, color } = req.body;
    if (!category_name?.trim())
      return res.status(400).json({ success: false, message: 'category_name is required' });

    const { rows } = await pool.query(
      `INSERT INTO expense_categories (category_name, description, icon, color)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [category_name.trim(), description || null, icon || null, color || null]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Category created' });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Category name already exists' });
    serverErr(res, err);
  }
};

const updateCategory = async (req, res) => {
  try {
    const { category_name, description, icon, color, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE expense_categories SET
         category_name = COALESCE($1, category_name),
         description   = COALESCE($2, description),
         icon          = COALESCE($3, icon),
         color         = COALESCE($4, color),
         is_active     = COALESCE($5, is_active)
       WHERE id = $6
       RETURNING *`,
      [
        category_name?.trim() || null,
        description || null,
        icon || null,
        color || null,
        is_active != null ? is_active : null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: rows[0], message: 'Category updated' });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Category name already exists' });
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  LIST EXPENSES — GET /api/expenses
//  Query params:
//    category_id  = number
//    payment_method = cash|bank_transfer|cheque|online|card
//    status       = draft|pending|approved|rejected
//    date_from    = YYYY-MM-DD
//    date_to      = YYYY-MM-DD
//    month        = YYYY-MM   (shorthand filter)
//    year         = YYYY      (shorthand filter)
//    fiscal_year  = YYYY-YY
//    search       = string (title + description)
//    limit        = number (default 50)
//    offset       = number (default 0)
// ══════════════════════════════════════════════════════════════
const getExpenses = async (req, res) => {
  try {
    const {
      category_id, payment_method, status,
      date_from, date_to, month, year, fiscal_year,
      search, limit = 50, offset = 0,
    } = req.query;

    const conditions = [];
    const values     = [];
    const push       = (val) => { values.push(val); return `$${values.length}`; };

    if (category_id)    conditions.push(`e.category_id = ${push(Number(category_id))}`);
    if (payment_method) conditions.push(`e.payment_method = ${push(payment_method)}`);
    if (status)         conditions.push(`e.status = ${push(status)}`);
    if (fiscal_year)    conditions.push(`e.fiscal_year = ${push(fiscal_year)}`);

    if (month) {
      // month = YYYY-MM
      conditions.push(`TO_CHAR(e.expense_date,'YYYY-MM') = ${push(month)}`);
    } else if (year) {
      conditions.push(`EXTRACT(YEAR FROM e.expense_date) = ${push(Number(year))}`);
    } else {
      if (date_from) conditions.push(`e.expense_date >= ${push(date_from)}`);
      if (date_to)   conditions.push(`e.expense_date <= ${push(date_to)}`);
    }

    if (search) {
      conditions.push(`(e.title ILIKE ${push(`%${search}%`)} OR e.description ILIKE $${values.length})`);
    }

    const extraWhere = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `${BASE_SELECT}
       ${extraWhere}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT ${push(Number(limit))} OFFSET ${push(Number(offset))}`,
      values
    );

    // Total count for pagination
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM expenses e WHERE e.is_deleted = FALSE ${extraWhere}`,
      values.slice(0, -2)
    );

    // Sum for current filter set (useful for filtered totals)
    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(e.amount),0) AS total_amount
       FROM expenses e
       WHERE e.is_deleted = FALSE AND e.status = 'approved' ${extraWhere}`,
      values.slice(0, -2)
    );

    res.json({
      success: true,
      data: rows,
      total: Number(countRows[0].count),
      filtered_total: Number(sumRows[0].total_amount),
    });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  SINGLE — GET /api/expenses/:id
// ══════════════════════════════════════════════════════════════
const getExpenseById = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${BASE_SELECT} AND e.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Expense not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  CREATE — POST /api/expenses
// ══════════════════════════════════════════════════════════════
const createExpense = async (req, res) => {
  try {
    const {
      category_id, title, description,
      amount, expense_date,
      payment_method = 'cash',
      reference_number = null,
      receipt_url      = null,
      status           = 'approved',
      created_by_type  = null,
      created_by_id    = null,
    } = req.body;

    if (!category_id) return res.status(400).json({ success: false, message: 'category_id is required' });
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'title is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'amount must be greater than 0' });
    if (!expense_date) return res.status(400).json({ success: false, message: 'expense_date is required' });

    const { rows } = await pool.query(
      `INSERT INTO expenses
         (category_id, title, description, amount, expense_date, payment_method,
          reference_number, receipt_url, status, created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        Number(category_id), title.trim(), description || null,
        Number(amount), expense_date, payment_method,
        reference_number || null, receipt_url || null, status,
        created_by_type || null, created_by_id || null,
      ]
    );

    // Return full row with joined category data
    const { rows: full } = await pool.query(
      `${BASE_SELECT} AND e.id = $1`, [rows[0].id]
    );
    res.status(201).json({ success: true, data: full[0], message: 'Expense recorded successfully' });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  UPDATE — PUT /api/expenses/:id
// ══════════════════════════════════════════════════════════════
const updateExpense = async (req, res) => {
  try {
    const {
      category_id, title, description,
      amount, expense_date, payment_method,
      reference_number, receipt_url, status,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE expenses SET
         category_id      = COALESCE($1,  category_id),
         title            = COALESCE($2,  title),
         description      = COALESCE($3,  description),
         amount           = COALESCE($4,  amount),
         expense_date     = COALESCE($5,  expense_date),
         payment_method   = COALESCE($6,  payment_method),
         reference_number = COALESCE($7,  reference_number),
         receipt_url      = COALESCE($8,  receipt_url),
         status           = COALESCE($9,  status),
         updated_at       = NOW()
       WHERE id = $10 AND is_deleted = FALSE
       RETURNING id`,
      [
        category_id ? Number(category_id) : null,
        title?.trim() || null,
        description || null,
        amount ? Number(amount) : null,
        expense_date || null,
        payment_method || null,
        reference_number || null,
        receipt_url || null,
        status || null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Expense not found' });

    const { rows: full } = await pool.query(
      `${BASE_SELECT} AND e.id = $1`, [rows[0].id]
    );
    res.json({ success: true, data: full[0], message: 'Expense updated' });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  DELETE — DELETE /api/expenses/:id  (soft delete)
// ══════════════════════════════════════════════════════════════
const deleteExpense = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE expenses
       SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE
       RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Expense not found' });
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════════

// ── Monthly Report — GET /api/expenses/reports/monthly?year=2025
const getMonthlyReport = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const { rows } = await pool.query(
      `SELECT
         EXTRACT(MONTH FROM e.expense_date)::INT            AS month_num,
         TO_CHAR(e.expense_date, 'Mon')                     AS month_short,
         TO_CHAR(e.expense_date, 'Month YYYY')              AS month_label,
         COUNT(e.id)                                        AS transaction_count,
         COALESCE(SUM(e.amount), 0)                         AS total_amount,
         COALESCE(AVG(e.amount), 0)                         AS avg_amount
       FROM expenses e
       WHERE e.is_deleted = FALSE
         AND e.status = 'approved'
         AND EXTRACT(YEAR FROM e.expense_date) = $1
       GROUP BY
         EXTRACT(MONTH FROM e.expense_date)::INT,
         TO_CHAR(e.expense_date, 'Mon'),
         TO_CHAR(e.expense_date, 'Month YYYY')
       ORDER BY month_num`,
      [Number(year)]
    );

    // Grand total for the year
    const { rows: tot } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS yearly_total, COUNT(*) AS total_transactions
       FROM expenses
       WHERE is_deleted = FALSE AND status = 'approved'
         AND EXTRACT(YEAR FROM expense_date) = $1`,
      [Number(year)]
    );

    res.json({
      success: true,
      year: Number(year),
      data: rows,
      yearly_total: Number(tot[0].yearly_total),
      total_transactions: Number(tot[0].total_transactions),
    });
  } catch (err) { serverErr(res, err); }
};

// ── Yearly Report — GET /api/expenses/reports/yearly
const getYearlyReport = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         EXTRACT(YEAR FROM expense_date)::INT  AS year,
         fiscal_year,
         COUNT(id)                             AS transaction_count,
         COALESCE(SUM(amount), 0)              AS total_amount,
         COALESCE(AVG(amount), 0)              AS avg_amount,
         COALESCE(MAX(amount), 0)              AS largest_expense,
         COALESCE(MIN(amount), 0)              AS smallest_expense
       FROM expenses
       WHERE is_deleted = FALSE AND status = 'approved'
       GROUP BY EXTRACT(YEAR FROM expense_date)::INT, fiscal_year
       ORDER BY year DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// ── By Category — GET /api/expenses/reports/by-category?year=&month=
const getByCategoryReport = async (req, res) => {
  try {
    const { year, month } = req.query;
    const conditions = ['e.is_deleted = FALSE', "e.status = 'approved'"];
    const values = [];
    const push = (v) => { values.push(v); return `$${values.length}`; };

    if (month) {
      conditions.push(`TO_CHAR(e.expense_date,'YYYY-MM') = ${push(month)}`);
    } else if (year) {
      conditions.push(`EXTRACT(YEAR FROM e.expense_date) = ${push(Number(year))}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await pool.query(
      `SELECT
         ec.id                                AS category_id,
         ec.category_name,
         ec.icon,
         ec.color,
         COUNT(e.id)                          AS transaction_count,
         COALESCE(SUM(e.amount), 0)           AS total_amount,
         COALESCE(AVG(e.amount), 0)           AS avg_amount,
         COALESCE(MAX(e.amount), 0)           AS max_expense,
         ROUND(
           COALESCE(SUM(e.amount),0) * 100.0 /
           NULLIF(SUM(SUM(e.amount)) OVER (), 0),
           2
         )                                    AS percentage
       FROM expense_categories ec
       LEFT JOIN expenses e ON e.category_id = ec.id
         AND e.is_deleted = FALSE AND e.status = 'approved'
         ${month ? `AND TO_CHAR(e.expense_date,'YYYY-MM') = ${push(month)}` : year ? `AND EXTRACT(YEAR FROM e.expense_date) = ${push(Number(year))}` : ''}
       WHERE ec.is_active = TRUE
       GROUP BY ec.id, ec.category_name, ec.icon, ec.color
       ORDER BY total_amount DESC`,
      values
    );

    const { rows: tot } = await pool.query(
      `SELECT COALESCE(SUM(e.amount),0) AS grand_total
       FROM expenses e ${where}`,
      values
    );

    res.json({
      success: true,
      data: rows,
      grand_total: Number(tot[0].grand_total),
    });
  } catch (err) { serverErr(res, err); }
};

// ── Dashboard Summary — GET /api/expenses/reports/summary
const getSummary = async (req, res) => {
  try {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
    const thisYear = now.getFullYear();

    const [thisMonthRes, lastMonthRes, thisYearRes, categoryRes, recentRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM expenses WHERE is_deleted=FALSE AND status='approved'
           AND TO_CHAR(expense_date,'YYYY-MM')=$1`,
        [thisMonth]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM expenses WHERE is_deleted=FALSE AND status='approved'
           AND TO_CHAR(expense_date,'YYYY-MM')=$1`,
        [lastMonth]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM expenses WHERE is_deleted=FALSE AND status='approved'
           AND EXTRACT(YEAR FROM expense_date)=$1`,
        [thisYear]
      ),
      pool.query(
        `SELECT ec.category_name, ec.icon, ec.color,
                COALESCE(SUM(e.amount),0) AS total
         FROM expense_categories ec
         LEFT JOIN expenses e ON e.category_id=ec.id
           AND e.is_deleted=FALSE AND e.status='approved'
           AND EXTRACT(YEAR FROM e.expense_date)=$1
         WHERE ec.is_active=TRUE
         GROUP BY ec.id, ec.category_name, ec.icon, ec.color
         ORDER BY total DESC
         LIMIT 5`,
        [thisYear]
      ),
      pool.query(
        `${BASE_SELECT}
         AND e.status = 'approved'
         ORDER BY e.created_at DESC LIMIT 5`,
        []
      ),
    ]);

    const thisMonthTotal = Number(thisMonthRes.rows[0].total);
    const lastMonthTotal = Number(lastMonthRes.rows[0].total);
    const momChange = lastMonthTotal > 0
      ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal * 100).toFixed(1)
      : null;

    res.json({
      success: true,
      data: {
        this_month:   { total: thisMonthTotal,                  count: Number(thisMonthRes.rows[0].count) },
        last_month:   { total: lastMonthTotal,                  count: Number(lastMonthRes.rows[0].count) },
        this_year:    { total: Number(thisYearRes.rows[0].total), count: Number(thisYearRes.rows[0].count) },
        mom_change_pct: momChange,
        top_categories: categoryRes.rows,
        recent_expenses: recentRes.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/expenses/import/template ────────────────────────────
const getImportTemplate = (_req, res) => {
  const csv = buildTemplate([
    { header: 'amount',         example1: '5000',          example2: '1200' },
    { header: 'category_name',  example1: 'Utilities',     example2: 'Stationery' },
    { header: 'date',           example1: '2024-01-15',    example2: '2024-01-20' },
    { header: 'title',          example1: 'Electricity Bill', example2: 'Copy Paper' },
    { header: 'description',    example1: 'Monthly bill',  example2: '' },
    { header: 'payment_method', example1: 'bank_transfer', example2: 'cash' },
    { header: 'vendor',         example1: 'LESCO',         example2: 'ABC Stationery' },
    { header: 'receipt_no',     example1: 'RCP-001',       example2: '' },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="expenses_import_template.csv"');
  res.send(csv);
};

// ── POST /api/expenses/import ─────────────────────────────────────
const importExpenses = async (req, res, next) => {
  if (!req.file) return next(new AppError('CSV file is required.', 400));

  const { headers, rows } = parseCSV(req.file.buffer);
  if (!rows.length) return next(new AppError('CSV file is empty.', 400));

  const REQUIRED = ['amount', 'category_name', 'date'];
  if (!REQUIRED.every(f => headers.includes(f))) {
    return next(new AppError(`CSV missing required columns: ${REQUIRED.join(', ')}`, 400));
  }

  const { valid, errors } = validateRows(rows, REQUIRED);
  let imported = 0;

  for (const { rowNum, data } of valid) {
    try {
      // Find or create category
      let { rows: cats } = await pool.query(
        `SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [data.category_name.trim()]
      );
      let catId = cats[0]?.id;
      if (!catId) {
        const { rows: newCat } = await pool.query(
          `INSERT INTO expense_categories (name) VALUES ($1) RETURNING id`,
          [data.category_name.trim()]
        );
        catId = newCat[0].id;
      }

      await pool.query(
        `INSERT INTO expenses
           (category_id, amount, expense_date, title, description, payment_method, vendor, receipt_number, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved')`,
        [
          catId,
          parseFloat(data.amount),
          data.date,
          data.title || data.category_name,
          data.description || null,
          data.payment_method || 'cash',
          data.vendor || null,
          data.receipt_no || null,
        ]
      );
      imported++;
    } catch (err) {
      errors.push({ row: rowNum, message: err.message });
    }
  }

  res.json({
    success: true, imported, failed: errors.length, errors,
    message: `Import complete. ${imported} expense(s) imported, ${errors.length} failed.`,
  });
};

// ── GET /api/expenses/export?format=xlsx ─────────────────────────
const exportExpenses = async (req, res, next) => {
  try {
    const { format = 'csv', month, year } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (month) { params.push(`${month}%`); where += ` AND e.expense_date::text LIKE $${params.length}`; }
    if (year)  { params.push(year);        where += ` AND EXTRACT(YEAR FROM e.expense_date) = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT e.expense_date, ec.name AS category, e.title, e.description,
              e.amount, e.payment_method, e.vendor, e.receipt_number, e.status
       FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
       ${where} ORDER BY e.expense_date DESC`,
      params
    );

    if (format === 'xlsx') {
      const wb = await buildWorkbook({
        title: 'Expense Ledger', sheetName: 'Expenses',
        subtitle: `Total: ${rows.length} records | Amount: PKR ${rows.reduce((s,r) => s + Number(r.amount || 0), 0).toLocaleString()}`,
        columns: [
          { key: 'expense_date',    header: 'Date',           width: 13 },
          { key: 'category',        header: 'Category',       width: 16 },
          { key: 'title',           header: 'Title',          width: 24 },
          { key: 'description',     header: 'Description',    width: 28 },
          { key: 'amount',          header: 'Amount (PKR)',   width: 14, numFmt: '#,##0.00' },
          { key: 'payment_method',  header: 'Payment Method', width: 16 },
          { key: 'vendor',          header: 'Vendor',         width: 18 },
          { key: 'receipt_number',  header: 'Receipt No',     width: 14 },
          { key: 'status',          header: 'Status',         width: 10 },
        ],
        rows,
      });
      return sendWorkbook(res, wb, `expenses_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hdr = ['Date','Category','Title','Description','Amount','Payment Method','Vendor','Receipt No','Status'];
    const csv = [hdr, ...rows.map(r => [
      r.expense_date?.toString().slice(0,10), r.category, r.title, r.description,
      r.amount, r.payment_method, r.vendor, r.receipt_number, r.status,
    ].map(q))].map(row => row.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="expenses_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCategories, createCategory, updateCategory,
  getExpenses, getExpenseById, createExpense, updateExpense, deleteExpense,
  getMonthlyReport, getYearlyReport, getByCategoryReport, getSummary,
  getImportTemplate, importExpenses, exportExpenses,
};
