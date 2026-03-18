const express = require('express');
const router = express.Router();
const { getClasses, getClass, getClassStudents, createClass, updateClass, deleteClass } = require('../controllers/classController');

router.route('/').get(getClasses).post(createClass);
router.get('/:id/students', getClassStudents);
router.route('/:id').get(getClass).put(updateClass).delete(deleteClass);

module.exports = router;
