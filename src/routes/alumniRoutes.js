const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getAlumni, graduateStudent, updateAlumni, deleteAlumni,
} = require('../controllers/alumniController');

router.use(auditMiddleware('alumni'));

router.get('/',       requireRole('admin', 'teacher'), getAlumni);
router.post('/',      requireRole('admin'),            graduateStudent);
router.put('/:id',    requireRole('admin'),            updateAlumni);
router.delete('/:id', requireRole('admin'),            deleteAlumni);

module.exports = router;
