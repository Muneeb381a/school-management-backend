const express = require('express');
const router  = express.Router();

const {
  getAllStudents, getStudentById, createStudent, updateStudent, deleteStudent,
  getDeletedStudents, restoreStudent,
  promoteStudents,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument, resetCredentials,
} = require('../controllers/studentController');

const { photoUpload, docUpload }  = require('../middleware/upload');
const { requireRole }             = require('../middleware/authMiddleware');
const { auditMiddleware }         = require('../middleware/auditLog');
const { createStudentValidator }  = require('../middleware/validate');

// Automatically audit all mutating requests on this router
router.use(auditMiddleware('student'));

// List & create
router.get('/',    requireRole('admin', 'teacher'), getAllStudents);
router.post('/',   requireRole('admin'),             createStudentValidator, createStudent);

// Bulk
router.post('/promote', requireRole('admin'), promoteStudents);

// Deleted students (soft delete management)
router.get('/deleted',           requireRole('admin'), getDeletedStudents);
router.post('/:id/restore',      requireRole('admin'), restoreStudent);

// Single student CRUD
router.get('/:id',    requireRole('admin', 'teacher'), getStudentById);
router.put('/:id',    requireRole('admin'),             updateStudent);
router.delete('/:id', requireRole('admin'),             deleteStudent);

// Photo & documents
router.post('/:id/photo',              requireRole('admin'), photoUpload.single('photo'), uploadPhoto);
router.get('/:id/documents',           requireRole('admin', 'teacher'),                   listDocuments);
router.post('/:id/documents',          requireRole('admin'), docUpload.single('file'),    uploadDocument);
router.delete('/:id/documents/:docId', requireRole('admin'),                              deleteDocument);

// Credentials reset
router.post('/:id/reset-credentials',  requireRole('admin'), resetCredentials);

module.exports = router;
