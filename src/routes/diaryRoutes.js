const router    = require('express').Router();
const { docUpload } = require('../middleware/upload');
const {
  getDiaries, getDiary, createDiary, updateDiary, deleteDiary, submitDiary,
  getClassDiary, publishDiary, unpublishDiary, getWeekOverview,
  getInchargeClasses, getTeacherSubjects, uploadAttachment,
} = require('../controllers/diaryController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('diary'));

const upload = docUpload.single('attachment');

// Lookup helpers
router.get('/incharge-classes/:teacherId', requireRole('admin', 'teacher'), getInchargeClasses);
router.get('/teacher-subjects/:teacherId', requireRole('admin', 'teacher'), getTeacherSubjects);

// Class diary & publish
router.get('/class/:classId/date/:date',           requireRole('admin', 'teacher'), getClassDiary);
router.post('/class/:classId/date/:date/publish',  requireRole('admin', 'teacher'), publishDiary);
router.delete('/class/:classId/date/:date/publish',requireRole('admin'),            unpublishDiary);

// Week overview
router.get('/week/:classId', requireRole('admin', 'teacher'), getWeekOverview);

// File upload
router.post('/upload-attachment', requireRole('admin', 'teacher'), upload, uploadAttachment);

// CRUD — teachers create/edit their own entries
router.get('/',           requireRole('admin', 'teacher'), getDiaries);
router.post('/', upload,  requireRole('admin', 'teacher'), createDiary);
router.get('/:id',        requireRole('admin', 'teacher'), getDiary);
router.put('/:id', upload,requireRole('admin', 'teacher'), updateDiary);
router.delete('/:id',     requireRole('admin'),            deleteDiary);
router.post('/:id/submit',requireRole('admin', 'teacher'), submitDiary);

module.exports = router;
