const { Router } = require('express');
const { handleQuery } = require('../controllers/chatbotController');

const router = Router();

// POST /api/chatbot/query  — authenticated, all roles
router.post('/query', handleQuery);

module.exports = router;
