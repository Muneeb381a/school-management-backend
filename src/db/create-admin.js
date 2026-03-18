/**
 * One-time script to create an admin user in the database.
 * Usage:
 *   node src/db/create-admin.js
 *   node src/db/create-admin.js <username> <password> <name>
 *
 * Examples:
 *   node src/db/create-admin.js
 *   node src/db/create-admin.js admin Admin@123 "School Admin"
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./index');

const [,, username = 'admin', password = 'Admin@123', name = 'School Admin'] = process.argv;

async function createAdmin() {
  try {
    // Run migrations first to ensure users table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
      ) AS exists
    `);

    if (!tableCheck.rows[0].exists) {
      console.error('❌  users table does not exist. Run migrations first:');
      console.error('   node src/db/migrate.js');
      process.exit(1);
    }

    // Check if admin already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1', [username.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      console.log(`⚠️  User "${username}" already exists.`);
      console.log('   To reset password, run:');
      console.log(`   node src/db/create-admin.js ${username} NewPassword123 "${name}"`);
      console.log('   (existing user will be updated)\n');

      const hashed = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE users SET password=$1, name=$2, role='admin', is_active=TRUE WHERE username=$3`,
        [hashed, name, username.toLowerCase()]
      );
      console.log(`✅  Password updated for "${username}"`);
    } else {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query(
        `INSERT INTO users (username, password, role, name, is_active)
         VALUES ($1, $2, 'admin', $3, TRUE)`,
        [username.toLowerCase(), hashed, name]
      );
      console.log(`✅  Admin user created successfully!`);
    }

    console.log(`\n   Username : ${username.toLowerCase()}`);
    console.log(`   Password : ${password}`);
    console.log(`   Name     : ${name}`);
    console.log(`   Role     : admin\n`);

  } catch (err) {
    console.error('❌  Error:', err.message);
  } finally {
    await pool.end();
  }
}

createAdmin();
