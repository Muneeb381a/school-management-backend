const express = require('express');
const router  = express.Router();
const {
  getTeachers,
  getTeacher,
  getTeacherClasses,
  getTeacherStudents,
  createTeacher,
  updateTeacher,
  deleteTeacher,
  assignTeacherToClass,
  removeTeacherFromClass,
  uploadPhoto,
  listDocuments,
  uploadDocument,
  deleteDocument,
} = require('../controllers/teacherController');
const { photoUpload, docUpload } = require('../middleware/upload');

router.route('/').get(getTeachers).post(createTeacher);

router.post('/:id/photo',              photoUpload.single('photo'), uploadPhoto);
router.get('/:id/documents',           listDocuments);
router.post('/:id/documents',          docUpload.single('file'),    uploadDocument);
router.delete('/:id/documents/:docId', deleteDocument);

router.get('/:id/classes',             getTeacherClasses);
router.post('/:id/classes',            assignTeacherToClass);
router.delete('/:id/classes/:classId', removeTeacherFromClass);
router.get('/:id/students',            getTeacherStudents);

router.route('/:id').get(getTeacher).put(updateTeacher).delete(deleteTeacher);

module.exports = router;
