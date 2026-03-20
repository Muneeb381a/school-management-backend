const express = require('express');
const router  = express.Router();
const {
  getSummary,
  getCategories, createCategory, updateCategory, deleteCategory,
  getBooks, getBook, createBook, updateBook, deleteBook,
  getCopies, addCopy, updateCopy, deleteCopy,
  issueBook, returnBook,
  getIssues,
  getFines, markFinePaid,
  getMostBorrowed, getBorrowingHistory,
  searchBorrowers,
} = require('../controllers/libraryController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');

router.use(auditMiddleware('library'));

// Summary — all staff
router.get('/summary', requireRole('admin', 'teacher'), getSummary);

// Borrower search
router.get('/borrowers/search', requireRole('admin', 'teacher'), searchBorrowers);

// Categories — admin manages; teachers read
router.get('/categories',       requireRole('admin', 'teacher'), getCategories);
router.post('/categories',      requireRole('admin'),            createCategory);
router.put('/categories/:id',   requireRole('admin'),            updateCategory);
router.delete('/categories/:id',requireRole('admin'),            deleteCategory);

// Books — admin manages; teachers read
router.get('/books',        requireRole('admin', 'teacher'), getBooks);
router.post('/books',       requireRole('admin'),            createBook);
router.get('/books/:id',    requireRole('admin', 'teacher'), getBook);
router.put('/books/:id',    requireRole('admin'),            updateBook);
router.delete('/books/:id', requireRole('admin'),            deleteBook);

// Copies
router.get('/books/:bookId/copies',  requireRole('admin', 'teacher'), getCopies);
router.post('/books/:bookId/copies', requireRole('admin'),            addCopy);
router.put('/copies/:id',            requireRole('admin'),            updateCopy);
router.delete('/copies/:id',         requireRole('admin'),            deleteCopy);

// Issues — teachers can issue/return
router.get('/issues',              requireRole('admin', 'teacher'), getIssues);
router.post('/issues',             requireRole('admin', 'teacher'), issueBook);
router.put('/issues/:id/return',   requireRole('admin', 'teacher'), returnBook);

// Fines
router.get('/fines',             requireRole('admin', 'teacher'), getFines);
router.put('/fines/:id/pay',     requireRole('admin'),            markFinePaid);

// Reports
router.get('/reports/most-borrowed',     requireRole('admin', 'teacher'), getMostBorrowed);
router.get('/reports/borrowing-history', requireRole('admin', 'teacher'), getBorrowingHistory);

module.exports = router;
