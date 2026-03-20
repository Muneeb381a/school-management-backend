const express = require('express');
const router  = express.Router();
const { globalSearch } = require('../controllers/searchController');
const { requireRole }  = require('../middleware/authMiddleware');

router.get('/', requireRole('admin', 'teacher'), globalSearch);

module.exports = router;
