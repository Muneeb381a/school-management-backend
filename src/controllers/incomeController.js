const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


const BASE_SELECT = `
  SELECT
    ie.id, ie.category_id,
    ic.name        AS category_name,
    ic.color       AS category_color,
    ie.title, ie.description,
    ie.amount, ie.income_date,
    ie.payment_method, ie.reference_no,
    ie.academic_year,
    ie.created_at, ie.updated_at
  FROM income_entries ie
  JOIN income_categories ic ON ic.id = ie.category_id
`;

// ── GET /api/income/categories ────────────────────────────────
const getCategories = async (req, res) => {
  try {
    const { active_only = 'true' } = req.query;
    const where = active_only === 'true' ? 'WHERE is_active = TRUE' : '';
    const { rows } = await pool.query(
      `SELECT * FROM income_categories ${where} ORDER BY name`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

const createCategory = async (req, res) => {
  try {
    const { name, color, description } = req.body;
    if (!name?.trim())
      return res.status(400).json({ success: false, message: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO income_categories (name, color, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), color || '#3B82F6', description || null]
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
    const { name, color, description, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE income_categories SET
         name        = COALESCE($1, name),
         color       = COALESCE($2, color),
         description = COALESCE($3, description),
         is_active   = COALESCE($4, is_active)
       WHERE id = $5 RETURNING *`,
      [name?.trim() || null, color || null, description || null,
       is_active != null ? is_active : null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: rows[0], message: 'Category updated' });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Category name already exists' });
    serverErr(res, err);
  }
};

// ── GET /api/income ────────────────────────────────────────────
// Query: category_id, payment_method, month (YYYY-MM), year (YYYY), search
const getIncomes = async (req, res) => {
  try {
    const { category_id, payment_method, month, year, search } = req.query;

    const conditions = [];
    const values = [];
    const push = (v) => { values.push(v); return `$${values.length}`; };

    if (category_id)    conditions.push(`ie.category_id = ${push(Number(category_id))}`);
    if (payment_method) conditions.push(`ie.payment_method = ${push(payment_method)}`);
    if (month)  conditions.push(`TO_CHAR(ie.income_date,'YYYY-MM') = ${push(month)}`);
    else if (year) conditions.push(`EXTRACT(YEAR FROM ie.income_date) = ${push(Number(year))}`);
    if (search) conditions.push(`(ie.title ILIKE ${push(`%${search}%`)} OR ie.description ILIKE $${values.length})`);

    const extraWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `${BASE_SELECT} ${extraWhere} ORDER BY ie.income_date DESC, ie.created_at DESC`,
      values
    );

    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(ie.amount),0) AS total_amount
       FROM income_entries ie ${extraWhere}`,
      values
    );

    res.json({ success: true, data: rows, total: rows.length, filtered_total: Number(sumRows[0].total_amount) });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/income/:id ────────────────────────────────────────
const getIncome = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${BASE_SELECT} WHERE ie.id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Income entry not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ── POST /api/income ───────────────────────────────────────────
const createIncome = async (req, res) => {
  try {
    const { category_id, title, description, amount, income_date,
            payment_method = 'cash', reference_no, academic_year } = req.body;

    if (!category_id) return res.status(400).json({ success: false, message: 'category_id is required' });
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'title is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'amount must be > 0' });
    if (!income_date) return res.status(400).json({ success: false, message: 'income_date is required' });

    const { rows } = await pool.query(
      `INSERT INTO income_entries
         (category_id, title, description, amount, income_date,
          payment_method, reference_no, academic_year, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       RETURNING id`,
      [Number(category_id), title.trim(), description || null, Number(amount),
       income_date, payment_method, reference_no || null, academic_year || null]
    );

    const { rows: full } = await pool.query(`${BASE_SELECT} WHERE ie.id = $1`, [rows[0].id]);
    res.status(201).json({ success: true, data: full[0], message: 'Income recorded' });
  } catch (err) { serverErr(res, err); }
};

// ── PUT /api/income/:id ────────────────────────────────────────
const updateIncome = async (req, res) => {
  try {
    const { category_id, title, description, amount, income_date,
            payment_method, reference_no, academic_year } = req.body;

    const { rows } = await pool.query(
      `UPDATE income_entries SET
         category_id    = COALESCE($1, category_id),
         title          = COALESCE($2, title),
         description    = COALESCE($3, description),
         amount         = COALESCE($4, amount),
         income_date    = COALESCE($5, income_date),
         payment_method = COALESCE($6, payment_method),
         reference_no   = COALESCE($7, reference_no),
         academic_year  = COALESCE($8, academic_year),
         updated_at     = NOW()
       WHERE id = $9 RETURNING id`,
      [category_id ? Number(category_id) : null, title?.trim() || null,
       description || null, amount ? Number(amount) : null,
       income_date || null, payment_method || null,
       reference_no || null, academic_year || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Income entry not found' });

    const { rows: full } = await pool.query(`${BASE_SELECT} WHERE ie.id = $1`, [rows[0].id]);
    res.json({ success: true, data: full[0], message: 'Income updated' });
  } catch (err) { serverErr(res, err); }
};

// ── DELETE /api/income/:id ─────────────────────────────────────
const deleteIncome = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM income_entries WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Income entry not found' });
    res.json({ success: true, message: 'Income entry deleted' });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/income/reports/summary ───────────────────────────
const getSummary = async (req, res) => {
  try {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
    const thisYear = now.getFullYear();

    const [thisMonthRes, lastMonthRes, thisYearRes, expThisMonth, expThisYear, byCat] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM income_entries WHERE TO_CHAR(income_date,'YYYY-MM')=$1`, [thisMonth]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total
         FROM income_entries WHERE TO_CHAR(income_date,'YYYY-MM')=$1`, [lastMonth]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM income_entries WHERE EXTRACT(YEAR FROM income_date)=$1`, [thisYear]
      ),
      // Expenses this month for P&L card
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total
         FROM expenses WHERE is_deleted=FALSE AND status='approved'
           AND TO_CHAR(expense_date,'YYYY-MM')=$1`, [thisMonth]
      ),
      // Expenses this year
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total
         FROM expenses WHERE is_deleted=FALSE AND status='approved'
           AND EXTRACT(YEAR FROM expense_date)=$1`, [thisYear]
      ),
      // By category this year
      pool.query(
        `SELECT ic.id, ic.name, ic.color,
                COALESCE(SUM(ie.amount),0) AS total,
                COUNT(ie.id)::int AS count
         FROM income_categories ic
         LEFT JOIN income_entries ie ON ie.category_id=ic.id
           AND EXTRACT(YEAR FROM ie.income_date)=$1
         WHERE ic.is_active=TRUE
         GROUP BY ic.id, ic.name, ic.color
         ORDER BY total DESC`, [thisYear]
      ),
    ]);

    const incomeMonth = Number(thisMonthRes.rows[0].total);
    const lastMonthInc = Number(lastMonthRes.rows[0].total);
    const momChange = lastMonthInc > 0
      ? ((incomeMonth - lastMonthInc) / lastMonthInc * 100).toFixed(1)
      : null;

    res.json({
      success: true,
      data: {
        this_month:   { income: incomeMonth, expenses: Number(expThisMonth.rows[0].total), count: Number(thisMonthRes.rows[0].count) },
        this_year:    { income: Number(thisYearRes.rows[0].total), expenses: Number(expThisYear.rows[0].total), count: Number(thisYearRes.rows[0].count) },
        mom_change_pct: momChange,
        by_category:  byCat.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ── GET /api/income/reports/monthly?year=YYYY ─────────────────
// Returns monthly income + expenses for the year (for the comparison chart)
const getMonthlyReport = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    const [incRows, expRows] = await Promise.all([
      pool.query(
        `SELECT EXTRACT(MONTH FROM income_date)::INT AS month_num,
                TO_CHAR(income_date,'Mon') AS month_short,
                COALESCE(SUM(amount),0) AS income,
                COUNT(*) AS count
         FROM income_entries
         WHERE EXTRACT(YEAR FROM income_date)=$1
         GROUP BY EXTRACT(MONTH FROM income_date)::INT, TO_CHAR(income_date,'Mon')
         ORDER BY month_num`, [Number(year)]
      ),
      pool.query(
        `SELECT EXTRACT(MONTH FROM expense_date)::INT AS month_num,
                COALESCE(SUM(amount),0) AS expenses
         FROM expenses
         WHERE is_deleted=FALSE AND status='approved'
           AND EXTRACT(YEAR FROM expense_date)=$1
         GROUP BY EXTRACT(MONTH FROM expense_date)::INT
         ORDER BY month_num`, [Number(year)]
      ),
    ]);

    // Merge into 12-month array
    const expMap = {};
    expRows.rows.forEach(r => { expMap[r.month_num] = Number(r.expenses); });

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const data = months.map((m, i) => {
      const inc = incRows.rows.find(r => r.month_num === i + 1);
      return {
        month_num:   i + 1,
        month_short: m,
        income:      inc ? Number(inc.income) : 0,
        expenses:    expMap[i + 1] || 0,
        profit:      (inc ? Number(inc.income) : 0) - (expMap[i + 1] || 0),
      };
    });

    res.json({ success: true, year: Number(year), data });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getCategories, createCategory, updateCategory,
  getIncomes, getIncome,
  createIncome, updateIncome, deleteIncome,
  getSummary, getMonthlyReport,
};
