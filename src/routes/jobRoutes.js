const express = require('express');
const { getJobStatus, enqueue } = require('../jobs/queue');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * GET /api/jobs/:id/status
 * Poll the status of a background job.
 * Returns: { jobId, name, status, progress, result, createdAt, completedAt }
 */
router.get('/:id/status', async (req, res) => {
  try {
    const status = await getJobStatus(req.params.id);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/jobs/test (admin only — for testing queue)
 */
router.post('/test', requireRole('admin'), async (req, res) => {
  try {
    const jobId = await enqueue('test-job', { message: 'Hello from test job', ts: new Date().toISOString() });
    res.json({ success: true, data: { jobId, message: 'Test job queued' } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
