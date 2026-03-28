const express = require('express');
const router  = express.Router();
const {
  getSettings, upsertSettings, uploadLogo, deleteLogo,
  getAcademicYears, createAcademicYear, setActiveYear, deleteAcademicYear,
} = require('../controllers/settingsController');
const {
  getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, getWebhookLogs,
} = require('../controllers/webhookController');
const { photoUpload }   = require('../middleware/upload');
const { requireRole }   = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('settings'));

// Academic years — read available to all staff; mutations admin only
router.get('/academic-years',                requireRole('admin', 'teacher'), getAcademicYears);
router.post('/academic-years',               requireRole('admin'),            createAcademicYear);
router.patch('/academic-years/:id/activate', requireRole('admin'),            setActiveYear);
router.delete('/academic-years/:id',         requireRole('admin'),            deleteAcademicYear);

// Logo — admin only
router.post('/logo',   requireRole('admin'), photoUpload.single('logo'), uploadLogo);
router.delete('/logo', requireRole('admin'), deleteLogo);

// School settings — read available to all staff (school name shown in header)
router.get('/',  requireRole('admin', 'teacher'), getSettings);
router.put('/',  requireRole('admin'),            upsertSettings);

// Webhooks — admin only
router.get('/webhooks',              requireRole('admin'), getWebhooks);
router.post('/webhooks',             requireRole('admin'), createWebhook);
router.put('/webhooks/:id',          requireRole('admin'), updateWebhook);
router.delete('/webhooks/:id',       requireRole('admin'), deleteWebhook);
router.post('/webhooks/:id/test',    requireRole('admin'), testWebhook);
router.get('/webhooks/:id/logs',     requireRole('admin'), getWebhookLogs);

module.exports = router;
