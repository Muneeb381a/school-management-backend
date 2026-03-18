const fs = require('fs');
const path = require('path');
const pool = require('./index');

async function init() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('✅ Database schema created successfully.');
  } catch (err) {
    console.error('❌ Failed to initialize database:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();
