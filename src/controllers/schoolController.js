const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');
const db     = require('../db');

// db.raw = the underlying pg Pool — bypasses schema injection.
// All DDL / provisioning work uses db.raw directly.
const pool = db.raw;

const MIGRATIONS_DIR = path.join(__dirname, '../db/migrations');

// ── helpers ───────────────────────────────────────────────────────────────────

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const schemaName = (slug) => `school_${slug}`;

/**
 * Run every migration file inside a freshly-created tenant schema.
 * Uses a single dedicated client (acquired from db.raw) so SET search_path
 * persists across all migration statements.
 */
async function runMigrationsForSchema(client, schema) {
  // Switch to the new schema
  await client.query(`SET search_path TO "${schema}", public`);

  // Ensure migration tracking table exists inside this schema
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(200) PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    // Skip public-schema-only migration — it lives in public, not per-tenant
    if (file === '059_public_schema_saas.sql') continue;

    const { rows } = await client.query(
      `SELECT 1 FROM _migrations WHERE filename = $1`, [file]
    );
    if (rows.length) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
    await client.query(
      `INSERT INTO _migrations (filename) VALUES ($1)`, [file]
    );
  }
}

// ── POST /api/schools ─────────────────────────────────────────────────────────
// Creates a new school: inserts record → creates schema → runs migrations → seeds admin user
const createSchool = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      name,
      school_code,
      city,
      phone,
      email,
      admin_username = 'admin',
      admin_password,
      plan           = 'standard',
    } = req.body;

    if (!name?.trim())        return res.status(400).json({ success: false, message: 'School name required' });
    if (!school_code?.trim()) return res.status(400).json({ success: false, message: 'School code required' });
    if (!admin_password)      return res.status(400).json({ success: false, message: 'Admin password required' });

    const slug   = slugify(name.trim());
    const schema = schemaName(slug);
    const code   = school_code.toUpperCase().trim();

    // 1. Check uniqueness in public schema
    await client.query(`SET search_path TO public`);
    const { rows: existing } = await client.query(
      `SELECT id FROM public.schools WHERE slug=$1 OR school_code=$2`,
      [slug, code]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'School code or name already in use' });
    }

    // 2. Insert into public.schools
    const { rows: [school] } = await client.query(
      `INSERT INTO public.schools (name, slug, school_code, city, phone, email, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name.trim(), slug, code, city || null, phone || null, email || null, plan]
    );

    // 3. Create the tenant schema
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    // 4. Run all migrations inside the new schema
    await runMigrationsForSchema(client, schema);

    // 5. Create default admin user inside the tenant schema
    const hash = await bcrypt.hash(admin_password, 10);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(
      `INSERT INTO users (username, password, role, must_change_password)
       VALUES ($1, $2, 'admin', false)`,
      [admin_username, hash]
    );

    // 6. Seed school_name setting inside the tenant
    await client.query(
      `INSERT INTO settings (key, value)
       VALUES ('school_name', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [name.trim()]
    );
    if (city) {
      await client.query(
        `INSERT INTO settings (key, value)
         VALUES ('school_city', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [city]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: {
        id:             school.id,
        name:           school.name,
        school_code:    school.school_code,
        slug,
        schema,
        admin_username,
        created_at:     school.created_at,
      },
      message: `School "${name.trim()}" provisioned — schema "${schema}" created with ${
        fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).length - 1
      } migrations applied.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SCHOOL] createSchool:', err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// ── GET /api/schools ──────────────────────────────────────────────────────────
// List all schools with live schema existence check
const listSchools = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              EXISTS (
                SELECT 1 FROM information_schema.schemata
                WHERE schema_name = 'school_' || s.slug
              ) AS schema_exists
       FROM public.schools s
       ORDER BY s.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[SCHOOL] listSchools:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/schools/resolve?code=GVPS ───────────────────────────────────────
// Public endpoint — login page calls this to validate school code before login.
// No JWT required — mounted before verifyToken in index.js.
const resolveSchool = async (req, res) => {
  try {
    const code = (req.query.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ success: false, message: 'code required' });

    const { rows: [school] } = await pool.query(
      `SELECT id, name, slug, school_code, logo_url, city, status
       FROM public.schools WHERE school_code = $1`,
      [code]
    );
    if (!school) {
      return res.status(404).json({ success: false, message: 'School not found. Check your school code.' });
    }
    if (school.status !== 'active') {
      return res.status(403).json({ success: false, message: 'School account is inactive. Contact support.' });
    }
    res.json({ success: true, data: school });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/schools/:id ────────────────────────────────────────────────────
// Update plan / status / expiry (super-admin)
const updateSchool = async (req, res) => {
  try {
    const { plan, status, expires_at, max_students } = req.body;
    const { rows: [school] } = await pool.query(
      `UPDATE public.schools
       SET plan=$1, status=$2, expires_at=$3, max_students=COALESCE($4, max_students)
       WHERE id=$5
       RETURNING *`,
      [plan, status, expires_at || null, max_students || null, req.params.id]
    );
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    res.json({ success: true, data: school });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/schools/stats ────────────────────────────────────────────────────
// Aggregate counts used by the super-admin dashboard header
const getSchoolStats = async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE status = 'active')        AS active,
        COUNT(*) FILTER (WHERE status = 'suspended')     AS suspended,
        COUNT(*) FILTER (WHERE plan   = 'standard')      AS plan_standard,
        COUNT(*) FILTER (WHERE plan   = 'pro')           AS plan_pro,
        COUNT(*) FILTER (WHERE plan   = 'enterprise')    AS plan_enterprise,
        COUNT(*) FILTER (WHERE expires_at < NOW()
                           AND expires_at IS NOT NULL)   AS expired
      FROM public.schools
    `);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/schools/:id/reset-admin ─────────────────────────────────────────
// Resets the admin user password inside the tenant's schema
const resetSchoolAdmin = async (req, res) => {
  const { new_password, admin_username = 'admin' } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ success: false, message: 'new_password must be at least 8 characters' });
  }
  try {
    const { rows: [school] } = await pool.query(
      'SELECT slug FROM public.schools WHERE id=$1', [req.params.id]
    );
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });

    const schema = schemaName(school.slug);
    const hash   = await bcrypt.hash(new_password, 10);

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}", public`);
      const { rowCount } = await client.query(
        `UPDATE users SET password=$1, must_change_password=TRUE
         WHERE username=$2 AND role='admin'`,
        [hash, admin_username]
      );
      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: `Admin user "${admin_username}" not found in this school` });
      }
    } finally {
      client.release();
    }

    res.json({ success: true, message: `Admin password reset. User must change password on next login.` });
  } catch (err) {
    console.error('[SCHOOL] resetSchoolAdmin:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createSchool, listSchools, resolveSchool, updateSchool, getSchoolStats, resetSchoolAdmin };
