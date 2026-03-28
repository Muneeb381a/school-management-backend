/**
 * Lightweight in-process scheduler for periodic housekeeping tasks.
 * Uses setInterval — no external dependency needed.
 *
 * Jobs:
 *   1. Purge expired/revoked refresh tokens   (every 6 hours)
 *   2. Purge login_attempts older than 30 days (every 24 hours)
 */

const pool = require('../db');

const SIX_HOURS = 6  * 60 * 60 * 1000;
const ONE_DAY   = 24 * 60 * 60 * 1000;

async function purgeExpiredTokens() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL`
    );
    if (rowCount > 0) {
      console.log(`[scheduler] Purged ${rowCount} expired/revoked refresh token(s).`);
    }
  } catch (err) {
    console.error('[scheduler] purgeExpiredTokens error:', err.message);
  }
}

async function purgeOldLoginAttempts() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '30 days'`
    );
    if (rowCount > 0) {
      console.log(`[scheduler] Purged ${rowCount} old login attempt record(s).`);
    }
  } catch (err) {
    console.error('[scheduler] purgeOldLoginAttempts error:', err.message);
  }
}

function startScheduler() {
  purgeExpiredTokens();
  purgeOldLoginAttempts();

  setInterval(() => purgeExpiredTokens(),    SIX_HOURS);
  setInterval(() => purgeOldLoginAttempts(), ONE_DAY);

  console.log('✅  Background scheduler started (token cleanup + login attempt purge).');
}

module.exports = { startScheduler };
