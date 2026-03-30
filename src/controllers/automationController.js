const { serverErr } = require('../utils/serverErr');
const {
  getAttendanceInsights,
  runAttendanceInsights,
  runMonthlyFeeGeneration,
  runFeeReminders,
  runFeeDefaulterReport,
} = require('../services/automationService');

/* GET /api/automation/attendance-insights
   Returns at-risk + chronic-absent students. Used by frontend. */
const attendanceInsights = async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 75;
    const data = await getAttendanceInsights({ threshold });
    res.json({ success: true, data });
  } catch (err) { serverErr(res, err); }
};

/* POST /api/automation/attendance-insights/run
   Manually trigger the daily attendance check (creates notifications). */
const runAttendanceCheck = async (req, res) => {
  try {
    const result = await runAttendanceInsights();
    res.json({ success: true, ...result });
  } catch (err) { serverErr(res, err); }
};

/* POST /api/automation/fee-generation/run
   Manually trigger monthly fee invoice generation. */
const runFeeGeneration = async (req, res) => {
  try {
    const result = await runMonthlyFeeGeneration(req.body);
    res.json({ success: true, ...result });
  } catch (err) { serverErr(res, err); }
};

/* POST /api/automation/fee-reminders/run
   Manually trigger fee reminder escalation. */
const runReminders = async (req, res) => {
  try {
    const result = await runFeeReminders();
    res.json({ success: true, ...result });
  } catch (err) { serverErr(res, err); }
};

/* POST /api/automation/fee-defaulter-report/run
   Manually trigger weekly defaulter email report. */
const runDefaulterReport = async (req, res) => {
  try {
    const result = await runFeeDefaulterReport();
    res.json({ success: true, ...result });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  attendanceInsights, runAttendanceCheck,
  runFeeGeneration, runReminders, runDefaulterReport,
};
