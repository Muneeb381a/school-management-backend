const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[INVENTORY]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

const getItems = async (req, res) => {
  try {
    const { category, condition, search } = req.query;
    let q = 'SELECT * FROM inventory_items WHERE 1=1';
    const p = [];
    if (category)  { p.push(category);          q += ` AND category=$${p.length}`; }
    if (condition) { p.push(condition);          q += ` AND condition=$${p.length}`; }
    if (search)    { p.push(`%${search}%`);      q += ` AND (name ILIKE $${p.length} OR supplier ILIKE $${p.length} OR location ILIKE $${p.length})`; }
    q += ' ORDER BY category, name';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const getItem = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const createItem = async (req, res) => {
  try {
    const { name, category, quantity, unit, condition, location,
            purchase_date, purchase_price, supplier, notes } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    const { rows } = await pool.query(`
      INSERT INTO inventory_items
        (name, category, quantity, unit, condition, location, purchase_date, purchase_price, supplier, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [name, category||'other', quantity||0, unit||'pcs', condition||'good',
        location||null, purchase_date||null, purchase_price||null, supplier||null, notes||null]);
    res.status(201).json({ success: true, data: rows[0], message: 'Item added' });
  } catch (err) { serverErr(res, err); }
};

const updateItem = async (req, res) => {
  try {
    const { name, category, quantity, unit, condition, location,
            purchase_date, purchase_price, supplier, notes } = req.body;
    const { rows } = await pool.query(`
      UPDATE inventory_items SET
        name=$1, category=$2, quantity=$3, unit=$4, condition=$5, location=$6,
        purchase_date=$7, purchase_price=$8, supplier=$9, notes=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [name, category||'other', quantity||0, unit||'pcs', condition||'good',
        location||null, purchase_date||null, purchase_price||null, supplier||null, notes||null,
        req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, data: rows[0], message: 'Item updated' });
  } catch (err) { serverErr(res, err); }
};

const deleteItem = async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM inventory_items WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) { serverErr(res, err); }
};

const getSummary = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                          AS total_items,
        COALESCE(SUM(quantity),0)                         AS total_units,
        COALESCE(SUM(purchase_price * quantity),0)        AS total_value,
        COUNT(*) FILTER (WHERE condition='damaged')       AS damaged_count,
        COUNT(*) FILTER (WHERE condition='lost')          AS lost_count,
        COUNT(*) FILTER (WHERE quantity = 0)              AS out_of_stock
      FROM inventory_items
    `);
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getItems, getItem, createItem, updateItem, deleteItem, getSummary };
