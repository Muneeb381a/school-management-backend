const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getApplications, createApplication, reviewApplication, deleteApplication,
} = require('../controllers/scholarshipController');

router.use(auditMiddleware('scholarships'));

router.get('/',             requireRole('admin', 'teacher'), getApplications);
router.post('/',            requireRole('admin', 'teacher'), createApplication);
router.put('/:id/review',   requireRole('admin'),            reviewApplication);
router.delete('/:id',       requireRole('admin'),            deleteApplication);

module.exports = router;
