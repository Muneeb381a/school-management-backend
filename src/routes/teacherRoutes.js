const express = require('express');
const router  = express.Router();
const {
  getTeachers, getTeacher, getTeacherClasses, getTeacherStudents,
  createTeacher, updateTeacher, deleteTeacher,
  getDeletedTeachers, restoreTeacher,
  assignTeacherToClass, removeTeacherFromClass,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument,
  getImportTemplate, importTeachers, exportTeachers,
} = require('../controllers/teacherController');
const { photoUpload, docUpload, csvUpload } = require('../middleware/upload');
const { requireRole }             = require('../middleware/authMiddleware');
const { auditMiddleware }         = require('../middleware/auditLog');

router.use(auditMiddleware('teacher'));

// Import / Export
router.get('/import/template', requireRole('admin'), getImportTemplate);
router.post('/import',         requireRole('admin'), csvUpload.single('file'), importTeachers);
router.get('/export',          requireRole('admin'), exportTeachers);

router.get('/',         requireRole('admin', 'teacher'), getTeachers);
router.post('/',        requireRole('admin'),            createTeacher);
router.get('/deleted',  requireRole('admin'),            getDeletedTeachers);
router.post('/:id/restore', requireRole('admin'),        restoreTeacher);

router.post('/:id/photo',              requireRole('admin'), photoUpload.single('photo'), uploadPhoto);
router.get('/:id/documents',           requireRole('admin', 'teacher'),                   listDocuments);
router.post('/:id/documents',          requireRole('admin'), docUpload.single('file'),    uploadDocument);
router.delete('/:id/documents/:docId', requireRole('admin'),                              deleteDocument);

router.get('/:id/classes',             requireRole('admin', 'teacher'), getTeacherClasses);
router.post('/:id/classes',            requireRole('admin'),            assignTeacherToClass);
router.delete('/:id/classes/:classId', requireRole('admin'),            removeTeacherFromClass);
router.get('/:id/students',            requireRole('admin', 'teacher'), getTeacherStudents);

router.get('/:id',    requireRole('admin', 'teacher'), getTeacher);
router.put('/:id',    requireRole('admin'),            updateTeacher);
router.delete('/:id', requireRole('admin'),            deleteTeacher);

module.exports = router;
