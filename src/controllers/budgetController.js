const db = require('../db');
const AppError = require('../utils/AppError');

// ── Plans ─────────────────────────────────────────────────────────────────────
async function getPlans(req, res) {
  const { rows } = await db.query(
    `SELECT p.*,
            u.name  AS created_by_name,
            ab.name AS approved_by_name,
            SUM(CASE WHEN i.type = 'income'  THEN i.budgeted ELSE 0 END) AS total_income_budget,
            SUM(CASE WHEN i.type = 'expense' THEN i.budgeted ELSE 0 END) AS total_expense_budget,
            SUM(CASE WHEN i.type = 'income'  THEN i.actual ELSE 0 END) AS total_income_actual,
            SUM(CASE WHEN i.type = 'expense' THEN i.actual ELSE 0 END) AS total_expense_actual
     FROM budget_plans p
     LEFT JOIN users u  ON u.id = p.created_by
     LEFT JOIN users ab ON ab.id = p.approved_by
     LEFT JOIN budget_items i ON i.plan_id = p.id
     GROUP BY p.id, u.name, ab.name ORDER BY p.start_date DESC`
  );
  res.json({ success: true, data: rows });
}

async function getPlan(req, res) {
  const { rows: [plan] } = await db.query(
    `SELECT p.*, u.name AS created_by_name FROM budget_plans p
     LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [req.params.id]
  );
  if (!plan) throw new AppError('Budget plan not found', 404);

  const { rows: items } = await db.query(
    `SELECT * FROM budget_items WHERE plan_id = $1 ORDER BY type DESC, category, sort_order, id`,
    [req.params.id]
  );
  res.json({ success: true, data: { ...plan, items } });
}

async function createPlan(req, res) {
  const { title, fiscal_year, start_date, end_date, total_budget, notes } = req.body;
  if (!title || !fiscal_year || !start_date || !end_date) {
    throw new AppError('title, fiscal_year, start_date and end_date are required', 400);
  }
  const { rows: [row] } = await db.query(
    `INSERT INTO budget_plans (title, fiscal_year, start_date, end_date, total_budget, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [title, fiscal_year, start_date, end_date, total_budget || 0, notes || null, req.user.id]
  );
  res.status(201).json({ success: true, data: row });
}

async function updatePlan(req, res) {
  const { title, fiscal_year, start_date, end_date, total_budget, status, notes } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE budget_plans SET
       title        = COALESCE($1, title),
       fiscal_year  = COALESCE($2, fiscal_year),
       start_date   = COALESCE($3, start_date),
       end_date     = COALESCE($4, end_date),
       total_budget = COALESCE($5, total_budget),
       status       = COALESCE($6, status),
       notes        = COALESCE($7, notes),
       updated_at   = NOW()
     WHERE id = $8 RETURNING *`,
    [title, fiscal_year, start_date, end_date, total_budget, status, notes, req.params.id]
  );
  if (!row) throw new AppError('Budget plan not found', 404);
  res.json({ success: true, data: row });
}

async function approvePlan(req, res) {
  const { rows: [row] } = await db.query(
    `UPDATE budget_plans SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!row) throw new AppError('Budget plan not found', 404);
  res.json({ success: true, data: row });
}

async function deletePlan(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM budget_plans WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Budget plan not found', 404);
  res.json({ success: true, message: 'Budget plan deleted' });
}

// ── Budget Items ──────────────────────────────────────────────────────────────
async function createItem(req, res) {
  const { category, subcategory, type = 'expense', description, budgeted, notes, sort_order } = req.body;
  if (!category || !description || budgeted === undefined) {
    throw new AppError('category, description and budgeted are required', 400);
  }
  const { rows: [row] } = await db.query(
    `INSERT INTO budget_items (plan_id, category, subcategory, type, description, budgeted, notes, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.planId, category, subcategory || null, type, description, budgeted, notes || null, sort_order || 0]
  );
  res.status(201).json({ success: true, data: row });
}

async function updateItem(req, res) {
  const { category, subcategory, type, description, budgeted, actual, notes, sort_order } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE budget_items SET
       category    = COALESCE($1, category),
       subcategory = COALESCE($2, subcategory),
       type        = COALESCE($3, type),
       description = COALESCE($4, description),
       budgeted    = COALESCE($5, budgeted),
       actual      = COALESCE($6, actual),
       notes       = COALESCE($7, notes),
       sort_order  = COALESCE($8, sort_order),
       updated_at  = NOW()
     WHERE id = $9 RETURNING *`,
    [category, subcategory, type, description, budgeted, actual, notes, sort_order, req.params.itemId]
  );
  if (!row) throw new AppError('Budget item not found', 404);
  res.json({ success: true, data: row });
}

async function deleteItem(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM budget_items WHERE id = $1 RETURNING id`, [req.params.itemId]
  );
  if (!row) throw new AppError('Budget item not found', 404);
  res.json({ success: true, message: 'Item deleted' });
}

// GET /api/budget/summary
async function getSummary(req, res) {
  const { rows: plans } = await db.query(
    `SELECT p.id, p.title, p.fiscal_year, p.status,
            SUM(CASE WHEN i.type = 'income'  THEN i.budgeted ELSE 0 END) AS income_budget,
            SUM(CASE WHEN i.type = 'expense' THEN i.budgeted ELSE 0 END) AS expense_budget,
            SUM(CASE WHEN i.type = 'income'  THEN i.actual ELSE 0 END)   AS income_actual,
            SUM(CASE WHEN i.type = 'expense' THEN i.actual ELSE 0 END)   AS expense_actual
     FROM budget_plans p
     LEFT JOIN budget_items i ON i.plan_id = p.id
     WHERE p.status IN ('active', 'approved')
     GROUP BY p.id ORDER BY p.start_date DESC LIMIT 3`
  );
  res.json({ success: true, data: plans });
}

module.exports = {
  getPlans, getPlan, createPlan, updatePlan, approvePlan, deletePlan,
  createItem, updateItem, deleteItem,
  getSummary,
};
