const express = require('express');
const router  = express.Router();
const {
  getSettings, upsertSettings, uploadLogo, deleteLogo,
  getAcademicYears, createAcademicYear, setActiveYear, deleteAcademicYear,
} = require('../controllers/settingsController');
const { photoUpload } = require('../middleware/upload');

router.get('/academic-years',                getAcademicYears);
router.post('/academic-years',               createAcademicYear);
router.patch('/academic-years/:id/activate', setActiveYear);
router.delete('/academic-years/:id',         deleteAcademicYear);

router.post('/logo',   photoUpload.single('logo'), uploadLogo);
router.delete('/logo', deleteLogo);

router.get('/',  getSettings);
router.put('/',  upsertSettings);

module.exports = router;
