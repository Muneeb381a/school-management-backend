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

// Summary
router.get('/summary', getSummary);

// Borrower search (before /:id routes)
router.get('/borrowers/search', searchBorrowers);

// Categories
router.route('/categories').get(getCategories).post(createCategory);
router.route('/categories/:id').put(updateCategory).delete(deleteCategory);

// Books
router.route('/books').get(getBooks).post(createBook);
router.get('/books/:id',    getBook);
router.put('/books/:id',    updateBook);
router.delete('/books/:id', deleteBook);

// Copies (nested under books + standalone for edit/delete)
router.get('/books/:bookId/copies', getCopies);
router.post('/books/:bookId/copies', addCopy);
router.put('/copies/:id',    updateCopy);
router.delete('/copies/:id', deleteCopy);

// Issues — static sub-paths BEFORE /:id
router.get('/issues',          getIssues);
router.post('/issues',         issueBook);
router.put('/issues/:id/return', returnBook);

// Fines
router.get('/fines',           getFines);
router.put('/fines/:id/pay',   markFinePaid);

// Reports
router.get('/reports/most-borrowed',    getMostBorrowed);
router.get('/reports/borrowing-history', getBorrowingHistory);

module.exports = router;
