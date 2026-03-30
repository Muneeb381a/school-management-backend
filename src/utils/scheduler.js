/**
 * Lightweight in-process scheduler for periodic housekeeping tasks.
 * Uses setInterval — no external dependency needed.
 *
 * Jobs:
 *   1. Purge expired/revoked refresh tokens   (every 6 hours)
 *   2. Purge login_attempts older than 30 days (every 24 hours)
 */

const pool = require('../db');
const {
  runAttendanceInsights,
  runMonthlyFeeGeneration,
  runFeeReminders,
  runFeeDefaulterReport,
} = require('../services/automationService');

const SIX_HOURS  = 6  * 60 * 60 * 1000;
const ONE_DAY    = 24 * 60 * 60 * 1000;
const ONE_HOUR   = 60 * 60 * 1000;

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

// ── Smart automation jobs ─────────────────────────────────────────────────────

/** Daily attendance insight check — runs every 24h, first run after 1 min */
async function dailyAttendanceCheck() {
  try {
    const { flagged } = await runAttendanceInsights();
    if (flagged > 0) console.log(`[scheduler] Attendance check: ${flagged} alert(s) created.`);
  } catch (err) { console.error('[scheduler] attendanceCheck error:', err.message); }
}

/** Monthly fee generation — runs every hour; only creates invoices on 1st of month */
async function monthlyFeeCheck() {
  try {
    if (new Date().getDate() !== 1) return;
    const { created } = await runMonthlyFeeGeneration();
    if (created > 0) console.log(`[scheduler] Monthly fees: ${created} invoice(s) generated.`);
  } catch (err) { console.error('[scheduler] monthlyFeeCheck error:', err.message); }
}

/** Daily fee reminders — escalating at Day 1 / 7 / 15 overdue */
async function dailyFeeReminders() {
  try {
    const { reminded } = await runFeeReminders();
    if (reminded > 0) console.log(`[scheduler] Fee reminders: ${reminded} sent.`);
  } catch (err) { console.error('[scheduler] feeReminders error:', err.message); }
}

/** Weekly defaulter report — runs every 24h; only emails on Monday */
async function weeklyDefaulterReport() {
  try {
    if (new Date().getDay() !== 1) return; // 1 = Monday
    const { sent, count } = await runFeeDefaulterReport();
    if (sent) console.log(`[scheduler] Defaulter report: sent for ${count} student(s).`);
  } catch (err) { console.error('[scheduler] defaulterReport error:', err.message); }
}

function startScheduler() {
  purgeExpiredTokens();
  purgeOldLoginAttempts();

  setInterval(() => purgeExpiredTokens(),    SIX_HOURS);
  setInterval(() => purgeOldLoginAttempts(), ONE_DAY);

  // Smart automation — stagger startup to avoid DB spike
  setTimeout(() => {
    dailyAttendanceCheck();
    setInterval(dailyAttendanceCheck, ONE_DAY);
  }, 60_000);  // 1 min after boot

  setTimeout(() => {
    monthlyFeeCheck();
    setInterval(monthlyFeeCheck, ONE_HOUR);
  }, 90_000);  // 1.5 min after boot

  setTimeout(() => {
    dailyFeeReminders();
    setInterval(dailyFeeReminders, ONE_DAY);
  }, 120_000); // 2 min after boot

  setTimeout(() => {
    weeklyDefaulterReport();
    setInterval(weeklyDefaulterReport, ONE_DAY);
  }, 150_000); // 2.5 min after boot

  console.log('✅  Background scheduler started (token cleanup + smart automation).');
}

module.exports = { startScheduler };
