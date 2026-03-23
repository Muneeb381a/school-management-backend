const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[CANTEEN]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// ── Items ──────────────────────────────────────────────────────────────────

// GET /canteen/items
const getItems = async (req, res) => {
  try {
    const { category, available } = req.query;
    let q = 'SELECT * FROM canteen_items WHERE 1=1';
    const p = [];
    if (category)  { p.push(category);  q += ` AND category=$${p.length}`; }
    if (available !== undefined) {
      p.push(available === 'true' || available === '1');
      q += ` AND is_available=$${p.length}`;
    }
    q += ' ORDER BY category, name';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /canteen/items
const createItem = async (req, res) => {
  try {
    const { name, category, price, unit, is_available } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ success: false, message: 'name and price are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO canteen_items (name, category, price, unit, is_available)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), category || 'Food', price, unit || 'piece', is_available !== false],
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Item created' });
  } catch (err) { serverErr(res, err); }
};

// PUT /canteen/items/:id
const updateItem = async (req, res) => {
  try {
    const { name, category, price, unit, is_available } = req.body;
    const { rows } = await pool.query(
      `UPDATE canteen_items SET
         name         = COALESCE($1, name),
         category     = COALESCE($2, category),
         price        = COALESCE($3, price),
         unit         = COALESCE($4, unit),
         is_available = COALESCE($5, is_available),
         updated_at   = NOW()
       WHERE id=$6 RETURNING *`,
      [name || null, category || null, price !== undefined ? price : null,
       unit || null, is_available !== undefined ? is_available : null, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, data: rows[0], message: 'Item updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /canteen/items/:id
const deleteItem = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM canteen_items WHERE id=$1 RETURNING *', [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, message: 'Item deleted', data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ── Sales ──────────────────────────────────────────────────────────────────

// GET /canteen/sales?date&month&academic_year
const getSales = async (req, res) => {
  try {
    const { date, month, academic_year } = req.query;
    let q = `
      SELECT cs.*, ci.name AS item_name_ref, ci.category
      FROM canteen_sales cs
      LEFT JOIN canteen_items ci ON ci.id = cs.item_id
      WHERE 1=1
    `;
    const p = [];
    if (date)          { p.push(date);          q += ` AND cs.sale_date=$${p.length}`; }
    if (month)         { p.push(month);          q += ` AND TO_CHAR(cs.sale_date,'YYYY-MM')=$${p.length}`; }
    if (academic_year) { p.push(academic_year);  q += ` AND cs.academic_year=$${p.length}`; }
    q += ' ORDER BY cs.sale_date DESC, cs.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// POST /canteen/sales
// Transaction: insert sale → insert income_entry → update sale.income_entry_id
const createSale = async (req, res) => {
  const client = await pool.connect();
  try {
    const { item_id, item_name, quantity, unit_price, total_amount, sale_date, academic_year, notes } = req.body;

    if (!item_name || !unit_price || !total_amount) {
      return res.status(400).json({ success: false, message: 'item_name, unit_price and total_amount are required' });
    }

    await client.query('BEGIN');

    // 1) Insert canteen_sales (without income_entry_id yet)
    const { rows: saleRows } = await client.query(
      `INSERT INTO canteen_sales (item_id, item_name, quantity, unit_price, total_amount, sale_date, academic_year, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [item_id || null, item_name, quantity || 1, unit_price, total_amount,
       sale_date || null, academic_year || '2024-25', notes || null],
    );
    const sale = saleRows[0];

    // 2) Look up canteen income category
    const { rows: catRows } = await client.query(
      `SELECT id FROM income_categories WHERE LOWER(category_name) = 'canteen' LIMIT 1`,
    );
    const categoryId = catRows[0]?.id || null;

    // 3) Insert income_entry
    const { rows: incomeRows } = await client.query(
      `INSERT INTO income_entries (category_id, amount, entry_date, description, academic_year)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [categoryId, total_amount, sale.sale_date || new Date().toISOString().slice(0, 10),
       `Canteen sale: ${item_name}`, academic_year || '2024-25'],
    );
    const incomeEntryId = incomeRows[0]?.id || null;

    // 4) Update sale with income_entry_id
    const { rows: finalSale } = await client.query(
      `UPDATE canteen_sales SET income_entry_id=$1 WHERE id=$2 RETURNING *`,
      [incomeEntryId, sale.id],
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: finalSale[0], message: 'Sale recorded' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// DELETE /canteen/sales/:id
const deleteSale = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: saleRows } = await client.query(
      'SELECT * FROM canteen_sales WHERE id=$1', [req.params.id],
    );
    if (!saleRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }

    const incomeEntryId = saleRows[0].income_entry_id;

    await client.query('DELETE FROM canteen_sales WHERE id=$1', [req.params.id]);

    if (incomeEntryId) {
      await client.query('DELETE FROM income_entries WHERE id=$1', [incomeEntryId]);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Sale deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// GET /canteen/sales/monthly-report?month
const getMonthlySalesReport = async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ success: false, message: 'month (YYYY-MM) is required' });

    const { rows: summary } = await pool.query(
      `SELECT
         COALESCE(SUM(total_amount),0) AS total_revenue,
         COUNT(*) AS sales_count
       FROM canteen_sales
       WHERE TO_CHAR(sale_date,'YYYY-MM')=$1`,
      [month],
    );

    const { rows: dailyTotals } = await pool.query(
      `SELECT sale_date AS date, SUM(total_amount) AS total
       FROM canteen_sales
       WHERE TO_CHAR(sale_date,'YYYY-MM')=$1
       GROUP BY sale_date ORDER BY sale_date`,
      [month],
    );

    const { rows: topItems } = await pool.query(
      `SELECT item_name AS name,
              SUM(quantity) AS quantity,
              SUM(total_amount) AS total
       FROM canteen_sales
       WHERE TO_CHAR(sale_date,'YYYY-MM')=$1
       GROUP BY item_name
       ORDER BY total DESC
       LIMIT 10`,
      [month],
    );

    res.json({
      success: true,
      data: {
        month,
        totalRevenue: summary[0].total_revenue,
        salesCount: parseInt(summary[0].sales_count, 10),
        dailyTotals,
        topItems,
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getItems, createItem, updateItem, deleteItem,
  getSales, createSale, deleteSale, getMonthlySalesReport,
};
