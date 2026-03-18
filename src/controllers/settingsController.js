const pool = require('../db');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');

const serverErr = (res, err) => {
  console.error('[SETTINGS]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// ── School Settings ───────────────────────────────────────────

const getSettings = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings ORDER BY key');
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json({ success: true, data });
  } catch (err) { serverErr(res, err); }
};

const upsertSettings = async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    if (!entries.length) return res.status(400).json({ success: false, message: 'No settings provided' });
    for (const [key, value] of entries) {
      await pool.query(`
        INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
      `, [key, value ?? null]);
    }
    res.json({ success: true, message: 'Settings saved' });
  } catch (err) { serverErr(res, err); }
};

// ── Academic Years ────────────────────────────────────────────

const getAcademicYears = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM academic_years ORDER BY start_date DESC');
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

const createAcademicYear = async (req, res) => {
  try {
    const { label, start_date, end_date } = req.body;
    if (!label || !start_date || !end_date)
      return res.status(400).json({ success: false, message: 'label, start_date, end_date required' });
    const { rows } = await pool.query(
      'INSERT INTO academic_years (label, start_date, end_date) VALUES ($1,$2,$3) RETURNING *',
      [label, start_date, end_date]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Academic year created' });
  } catch (err) { serverErr(res, err); }
};

const setActiveYear = async (req, res) => {
  try {
    const { id } = req.params;
    // Deactivate all, then activate the chosen one
    await pool.query('UPDATE academic_years SET is_active=FALSE');
    const { rows } = await pool.query(
      'UPDATE academic_years SET is_active=TRUE WHERE id=$1 RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Academic year not found' });
    // Also update the settings table
    await pool.query(`
      INSERT INTO settings (key, value, updated_at) VALUES ('active_academic_year', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [rows[0].label]);
    res.json({ success: true, data: rows[0], message: `${rows[0].label} set as active` });
  } catch (err) { serverErr(res, err); }
};

const deleteAcademicYear = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM academic_years WHERE id=$1 AND is_active=FALSE RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Cannot delete active year or year not found' });
    res.json({ success: true, message: 'Academic year deleted' });
  } catch (err) { serverErr(res, err); }
};

// ── School Logo ───────────────────────────────────────────────

const uploadLogo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });

    // Delete old logo from Cloudinary if one exists
    const { rows: old } = await pool.query("SELECT value FROM settings WHERE key='school_logo'");
    if (old[0]?.value) await deleteFromCloudinary(old[0].value).catch(() => {});

    const result = await uploadToCloudinary(req.file.buffer, 'schoolms/logo', {
      transformation: [{ width: 400, height: 400, crop: 'limit', quality: 'auto' }],
    });

    await pool.query(`
      INSERT INTO settings (key, value, updated_at) VALUES ('school_logo', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [result.secure_url]);

    res.json({ success: true, data: { url: result.secure_url }, message: 'Logo uploaded' });
  } catch (err) { serverErr(res, err); }
};

const deleteLogo = async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='school_logo'");
    if (rows[0]?.value) await deleteFromCloudinary(rows[0].value).catch(() => {});
    await pool.query("UPDATE settings SET value=NULL, updated_at=NOW() WHERE key='school_logo'");
    res.json({ success: true, message: 'Logo removed' });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getSettings, upsertSettings, uploadLogo, deleteLogo, getAcademicYears, createAcademicYear, setActiveYear, deleteAcademicYear };
