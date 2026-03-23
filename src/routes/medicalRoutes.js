const express = require('express');
const router  = express.Router();
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const {
  getStudentMedical,
  addVaccination,
  deleteVaccination,
  addMedicalVisit,
  deleteMedicalVisit,
  getMedicalSummaryList,
} = require('../controllers/medicalController');

router.use(auditMiddleware('medical'));

router.get('/summary',                   requireRole('admin', 'teacher'), getMedicalSummaryList);
router.get('/student/:id',               requireRole('admin', 'teacher'), getStudentMedical);
router.post('/student/:id/vaccinations', requireRole('admin', 'teacher'), addVaccination);
router.delete('/vaccinations/:id',       requireRole('admin'),            deleteVaccination);
router.post('/student/:id/visits',       requireRole('admin', 'teacher'), addMedicalVisit);
router.delete('/visits/:id',             requireRole('admin'),            deleteMedicalVisit);

module.exports = router;
