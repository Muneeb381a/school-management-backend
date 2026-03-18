const router  = require('express').Router();
const { docUpload } = require('../middleware/upload');
const {
  getDiaries,
  getDiary,
  createDiary,
  updateDiary,
  deleteDiary,
  submitDiary,
  getClassDiary,
  publishDiary,
  unpublishDiary,
  getWeekOverview,
  getInchargeClasses,
  getTeacherSubjects,
  uploadAttachment,
} = require('../controllers/diaryController');

const upload = docUpload.single('attachment');

// Lookup helpers
router.get('/incharge-classes/:teacherId',  getInchargeClasses);
router.get('/teacher-subjects/:teacherId',  getTeacherSubjects);

// Class diary (full day view) & publish actions
router.get('/class/:classId/date/:date',           getClassDiary);
router.post('/class/:classId/date/:date/publish',  publishDiary);
router.delete('/class/:classId/date/:date/publish',unpublishDiary);

// Week overview calendar strip
router.get('/week/:classId', getWeekOverview);

// File upload standalone
router.post('/upload-attachment', upload, uploadAttachment);

// CRUD
router.get('/',          getDiaries);
router.post('/', upload, createDiary);
router.get('/:id',       getDiary);
router.put('/:id', upload, updateDiary);
router.delete('/:id',    deleteDiary);
router.post('/:id/submit', submitDiary);

module.exports = router;
