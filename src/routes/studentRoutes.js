const express = require('express');
const router = express.Router();
const {
  getAllStudents, getStudentById, createStudent, updateStudent, deleteStudent, promoteStudents,
  uploadPhoto, listDocuments, uploadDocument, deleteDocument, resetCredentials,
} = require('../controllers/studentController');
const { photoUpload, docUpload } = require('../middleware/upload');

router.route('/').get(getAllStudents).post(createStudent);
router.post('/promote', promoteStudents);

router.route('/:id').get(getStudentById).put(updateStudent).delete(deleteStudent);
router.post('/:id/photo',               photoUpload.single('photo'), uploadPhoto);
router.get('/:id/documents',            listDocuments);
router.post('/:id/documents',           docUpload.single('file'),    uploadDocument);
router.delete('/:id/documents/:docId',  deleteDocument);
router.post('/:id/reset-credentials',   resetCredentials);

module.exports = router;
