const router = require('express').Router();
const { createSchool, listSchools, resolveSchool, updateSchool, getSchoolStats, resetSchoolAdmin } = require('../controllers/schoolController');
const { requireSuperAdmin } = require('../middleware/authMiddleware');

// ── Public ───────────────────────────────────────────────────────────────────
router.get('/resolve', resolveSchool);

// ── Super-admin only ──────────────────────────────────────────────────────────
router.get('/stats',           requireSuperAdmin, getSchoolStats);
router.get('/',                requireSuperAdmin, listSchools);
router.post('/',               requireSuperAdmin, createSchool);
router.patch('/:id',           requireSuperAdmin, updateSchool);
router.post('/:id/reset-admin',requireSuperAdmin, resetSchoolAdmin);

module.exports = router;
