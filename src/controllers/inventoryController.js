const pool     = require('../db');
const AppError = require('../utils/AppError');
const { parseCSV, validateRows, buildTemplate } = require('../utils/csvImport');
const { buildWorkbook, sendWorkbook }           = require('../utils/excelExport');

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

// ── GET /api/inventory/import/template ───────────────────────────
const getImportTemplate = (_req, res) => {
  const csv = buildTemplate([
    { header: 'name',           example1: 'Science Kit',      example2: 'Football' },
    { header: 'category',       example1: 'lab equipment',    example2: 'sports' },
    { header: 'quantity',       example1: '10',               example2: '5' },
    { header: 'unit',           example1: 'pcs',              example2: 'pcs' },
    { header: 'unit_price',     example1: '1500',             example2: '800' },
    { header: 'condition',      example1: 'good',             example2: 'good' },
    { header: 'supplier',       example1: 'Ahmed Traders',    example2: '' },
    { header: 'location',       example1: 'Science Lab',      example2: 'Sports Room' },
    { header: 'purchase_date',  example1: '2024-01-10',       example2: '' },
    { header: 'notes',          example1: '',                 example2: '' },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory_import_template.csv"');
  res.send(csv);
};

// ── POST /api/inventory/import ───────────────────────────────────
const importInventory = async (req, res, next) => {
  if (!req.file) return next(new AppError('CSV file is required.', 400));

  const { headers, rows } = parseCSV(req.file.buffer);
  if (!rows.length) return next(new AppError('CSV file is empty.', 400));

  const REQUIRED = ['name', 'category', 'quantity'];
  if (!REQUIRED.every(f => headers.includes(f))) {
    return next(new AppError(`CSV missing required columns: ${REQUIRED.join(', ')}`, 400));
  }

  const { valid, errors } = validateRows(rows, REQUIRED);
  let imported = 0;

  for (const { rowNum, data } of valid) {
    try {
      await pool.query(
        `INSERT INTO inventory_items
           (name, category, quantity, unit, unit_price, condition, supplier, location, purchase_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          data.name.trim(),
          data.category || 'other',
          parseInt(data.quantity, 10) || 0,
          data.unit || 'pcs',
          parseFloat(data.unit_price) || null,
          data.condition || 'good',
          data.supplier || null,
          data.location || null,
          data.purchase_date || null,
          data.notes || null,
        ]
      );
      imported++;
    } catch (err) {
      errors.push({ row: rowNum, message: err.message });
    }
  }

  res.json({
    success: true, imported, failed: errors.length, errors,
    message: `Import complete. ${imported} item(s) imported, ${errors.length} failed.`,
  });
};

// ── GET /api/inventory/export?format=xlsx ───────────────────────
const exportInventory = async (req, res, next) => {
  try {
    const { format = 'csv' } = req.query;
    const { rows } = await pool.query(
      `SELECT name, category, quantity, unit, unit_price, purchase_price,
              condition, supplier, location, purchase_date, notes
       FROM inventory_items ORDER BY category, name`
    );

    if (format === 'xlsx') {
      const wb = await buildWorkbook({
        title: 'Inventory Report', sheetName: 'Inventory',
        subtitle: `Total: ${rows.length} items | Exported: ${new Date().toLocaleDateString('en-PK')}`,
        columns: [
          { key: 'name',          header: 'Item Name',      width: 24 },
          { key: 'category',      header: 'Category',       width: 16 },
          { key: 'quantity',      header: 'Qty',            width: 8  },
          { key: 'unit',          header: 'Unit',           width: 8  },
          { key: 'unit_price',    header: 'Unit Price',     width: 12 },
          { key: 'condition',     header: 'Condition',      width: 12 },
          { key: 'supplier',      header: 'Supplier',       width: 18 },
          { key: 'location',      header: 'Location',       width: 16 },
          { key: 'purchase_date', header: 'Purchase Date',  width: 14 },
          { key: 'notes',         header: 'Notes',          width: 22 },
        ],
        rows,
      });
      return sendWorkbook(res, wb, `inventory_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hdr = ['Name','Category','Qty','Unit','Unit Price','Condition','Supplier','Location','Purchase Date','Notes'];
    const csv = [hdr, ...rows.map(r => [
      r.name, r.category, r.quantity, r.unit, r.unit_price ?? r.purchase_price,
      r.condition, r.supplier, r.location, r.purchase_date?.toString().slice(0,10), r.notes,
    ].map(q))].map(row => row.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="inventory_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getItems, getItem, createItem, updateItem, deleteItem, getSummary,
  getImportTemplate, importInventory, exportInventory,
};
