/**
 * Seed super-admin account in public.super_admins.
 * Usage: node src/db/seed_superadmin.js
 *
 * Default account:
 *   username: superadmin
 *   password: superadmin123
 *
 * Run this ONCE after migration 059 has been applied.
 */

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

// Use DATABASE_URL (same connection as the app) — falls back to individual vars
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'schoolms',
    });

async function seed() {
  console.log('🌱 Seeding super-admin account...\n');

  const username = 'superadmin';
  const password = 'superadmin123';
  const email    = 'superadmin@schoolms.pk';

  const hashed = await bcrypt.hash(password, 10);

  // Ensure the table exists (run migration 059 first if it doesn't)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.super_admins (
      id         SERIAL       PRIMARY KEY,
      username   VARCHAR(100) NOT NULL UNIQUE,
      password   TEXT         NOT NULL,
      email      VARCHAR(200),
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  const { rowCount } = await pool.query(
    `INSERT INTO public.super_admins (username, password, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
       SET password = EXCLUDED.password,
           email    = EXCLUDED.email`,
    [username, hashed, email]
  );

  console.log('  ✅ super_admin → username: superadmin  password: superadmin123');
  console.log('\n✅ Super-admin seed complete.');
  console.log('\n⚠️  Remember to change the password after first login!\n');

  await pool.end();
}

seed().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
