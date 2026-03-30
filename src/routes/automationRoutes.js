const express = require('express');
const router  = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const {
  attendanceInsights, runAttendanceCheck,
  runFeeGeneration, runReminders, runDefaulterReport,
} = require('../controllers/automationController');

// ── Vercel Cron guard ─────────────────────────────────────────────────────────
// Vercel crons call GET with Authorization: Bearer <CRON_SECRET>
function cronGuard(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ success: false, message: 'CRON_SECRET not set' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}

// Attendance insights — readable by admin + teacher
router.get('/attendance-insights',       requireRole('admin','teacher'), attendanceInsights);
router.post('/attendance-insights/run',  requireRole('admin'), runAttendanceCheck);
router.get('/attendance-insights/run',   cronGuard, runAttendanceCheck);

// Fee automation — admin only (POST for manual, GET for Vercel Cron)
router.post('/fee-generation/run',       requireRole('admin'), runFeeGeneration);
router.get('/fee-generation/run',        cronGuard, runFeeGeneration);

router.post('/fee-reminders/run',        requireRole('admin'), runReminders);
router.get('/fee-reminders/run',         cronGuard, runReminders);

router.post('/fee-defaulter-report/run', requireRole('admin'), runDefaulterReport);
router.get('/fee-defaulter-report/run',  cronGuard, runDefaulterReport);

module.exports = router;
