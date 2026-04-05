const db = require('../db');

async function getWaSetting(key) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = $1 LIMIT 1`, [key]
    );
    return rows[0]?.value === 'true';
  } catch { return false; }
}

async function getSetting(key, defaultValue = null) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = $1 LIMIT 1`, [key]
    );
    return rows[0]?.value ?? defaultValue;
  } catch { return defaultValue; }
}

module.exports = { getWaSetting, getSetting };
