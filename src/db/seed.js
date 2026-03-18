/**
 * Seed default user accounts.
 * Usage: node src/db/seed.js
 *
 * Default accounts:
 *   admin    / admin123
 *   teacher  / teacher123   (entity_id must be set manually or via DB)
 *   student  / student123   (entity_id must be set manually or via DB)
 *   parent   / parent123    (entity_id = child student_id)
 */
const bcrypt = require('bcryptjs');
const pool   = require('./index');

const USERS = [
  { username: 'admin',   password: 'admin123',   role: 'admin',   name: 'Admin User',    entity_id: null },
  { username: 'teacher', password: 'teacher123', role: 'teacher', name: 'Demo Teacher',  entity_id: null },
  { username: 'student', password: 'student123', role: 'student', name: 'Demo Student',  entity_id: null },
  { username: 'parent',  password: 'parent123',  role: 'parent',  name: 'Demo Parent',   entity_id: null },
];

async function seed() {
  console.log('🌱 Seeding default users...');
  for (const u of USERS) {
    const hashed = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (username, password, role, name, entity_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, hashed, u.role, u.name, u.entity_id]
    );
    console.log(`  ✅ ${u.role.padEnd(8)} → username: ${u.username}  password: ${u.password}`);
  }
  await pool.end();
  console.log('\n✅ Seed complete.');
}

seed().catch(err => { console.error(err); process.exit(1); });
