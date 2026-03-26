const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


const FINE_PER_DAY   = 5;   // PKR 5 per day late
const DEFAULT_LOAN_DAYS = 14; // default borrowing period

// ═══════════════════════════════════════════════════════════════
//  SUMMARY DASHBOARD
// ═══════════════════════════════════════════════════════════════
const getSummary = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int       FROM books        WHERE is_active = TRUE)                                   AS total_books,
        (SELECT COUNT(*)::int       FROM book_copies   WHERE status NOT IN ('lost'))                            AS total_copies,
        (SELECT COUNT(*)::int       FROM book_copies   WHERE status = 'available')                              AS available_copies,
        (SELECT COUNT(*)::int       FROM book_copies   WHERE status = 'issued')                                 AS issued_copies,
        (SELECT COUNT(*)::int       FROM book_issues   WHERE status IN ('issued','overdue'))                    AS active_issues,
        (SELECT COUNT(*)::int       FROM book_issues
         WHERE return_date IS NULL AND due_date < CURRENT_DATE
           AND status IN ('issued','overdue'))                                                                   AS overdue_count,
        (SELECT COALESCE(SUM(fine_amount),0) FROM library_fines WHERE paid_status = TRUE)                       AS fines_collected,
        (SELECT COALESCE(SUM(fine_amount),0) FROM library_fines WHERE paid_status = FALSE)                      AS fines_pending,
        (SELECT COUNT(*)::int       FROM book_categories WHERE is_active = TRUE)                                AS total_categories
    `);
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BOOK CATEGORIES CRUD
// ═══════════════════════════════════════════════════════════════
const getCategories = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT bc.*, COUNT(b.id)::int AS book_count
      FROM book_categories bc
      LEFT JOIN books b ON b.category_id = bc.id AND b.is_active = TRUE
      WHERE bc.is_active = TRUE
      GROUP BY bc.id
      ORDER BY bc.name
    `);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const createCategory = async (req, res) => {
  try {
    const { name, description, color, icon } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    const { rows } = await pool.query(
      `INSERT INTO book_categories (name, description, color, icon)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), description || null, color || '#6366f1', icon || '📚']
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Category name already exists' });
    serverErr(res, err);
  }
};

const updateCategory = async (req, res) => {
  try {
    const { name, description, color, icon, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE book_categories SET name=$1, description=$2, color=$3, icon=$4, is_active=$5
       WHERE id=$6 RETURNING *`,
      [name, description || null, color || '#6366f1', icon || '📚', is_active ?? true, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const deleteCategory = async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM books WHERE category_id=$1 AND is_active=TRUE',
      [req.params.id]
    );
    if (check[0].cnt > 0)
      return res.status(409).json({ success: false, message: 'Cannot delete: category has active books' });
    await pool.query('UPDATE book_categories SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BOOKS CRUD
// ═══════════════════════════════════════════════════════════════
const getBooks = async (req, res) => {
  try {
    const { search, category_id, language, limit = 200, offset = 0 } = req.query;
    let q = `
      SELECT b.*,
        bc.name AS category_name, bc.color AS category_color, bc.icon AS category_icon,
        COUNT(cop.id)::int                                                         AS total_copies,
        SUM(CASE WHEN cop.status = 'available' THEN 1 ELSE 0 END)::int            AS available_copies,
        SUM(CASE WHEN cop.status = 'issued'    THEN 1 ELSE 0 END)::int            AS issued_copies,
        SUM(CASE WHEN cop.status = 'lost'      THEN 1 ELSE 0 END)::int            AS lost_copies,
        SUM(CASE WHEN cop.status = 'damaged'   THEN 1 ELSE 0 END)::int            AS damaged_copies
      FROM books b
      LEFT JOIN book_categories bc ON bc.id = b.category_id
      LEFT JOIN book_copies cop    ON cop.book_id = b.id
      WHERE b.is_active = TRUE`;
    const p = [];
    if (search) {
      p.push(`%${search}%`);
      q += ` AND (b.title ILIKE $${p.length} OR b.author ILIKE $${p.length} OR b.isbn ILIKE $${p.length})`;
    }
    if (category_id) { p.push(category_id); q += ` AND b.category_id = $${p.length}`; }
    if (language)    { p.push(language);    q += ` AND b.language = $${p.length}`; }
    q += ' GROUP BY b.id, bc.name, bc.color, bc.icon ORDER BY b.title';
    p.push(limit, offset);
    q += ` LIMIT $${p.length - 1} OFFSET $${p.length}`;
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const getBook = async (req, res) => {
  try {
    const { rows: bookRows } = await pool.query(`
      SELECT b.*,
        bc.name AS category_name, bc.color AS category_color, bc.icon AS category_icon
      FROM books b
      LEFT JOIN book_categories bc ON bc.id = b.category_id
      WHERE b.id = $1 AND b.is_active = TRUE`,
      [req.params.id]
    );
    if (!bookRows[0]) return res.status(404).json({ success: false, message: 'Book not found' });

    const { rows: copies } = await pool.query(
      'SELECT * FROM book_copies WHERE book_id=$1 ORDER BY copy_number',
      [req.params.id]
    );
    res.json({ success: true, data: { ...bookRows[0], copies } });
  } catch (err) { serverErr(res, err); }
};

const createBook = async (req, res) => {
  try {
    const { title, author, isbn, publisher, published_year, category_id, description, language, edition, cover_color } = req.body;
    if (!title || !author) return res.status(400).json({ success: false, message: 'title and author required' });
    const { rows } = await pool.query(
      `INSERT INTO books (title, author, isbn, publisher, published_year, category_id, description, language, edition, cover_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [title.trim(), author.trim(), isbn || null, publisher || null, published_year || null,
       category_id || null, description || null, language || 'English', edition || null, cover_color || '#6366f1']
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'ISBN already exists' });
    serverErr(res, err);
  }
};

const updateBook = async (req, res) => {
  try {
    const { title, author, isbn, publisher, published_year, category_id, description, language, edition, cover_color } = req.body;
    const { rows } = await pool.query(
      `UPDATE books SET title=$1, author=$2, isbn=$3, publisher=$4, published_year=$5,
          category_id=$6, description=$7, language=$8, edition=$9, cover_color=$10, updated_at=NOW()
       WHERE id=$11 AND is_active=TRUE RETURNING *`,
      [title, author, isbn || null, publisher || null, published_year || null,
       category_id || null, description || null, language || 'English', edition || null,
       cover_color || '#6366f1', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Book not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'ISBN already exists' });
    serverErr(res, err);
  }
};

const deleteBook = async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM book_copies bc
       JOIN book_issues bi ON bi.book_copy_id = bc.id
       WHERE bc.book_id=$1 AND bi.status IN ('issued','overdue')`,
      [req.params.id]
    );
    if (check[0].cnt > 0)
      return res.status(409).json({ success: false, message: 'Cannot delete: book has active issues' });
    await pool.query('UPDATE books SET is_active=FALSE, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Book deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BOOK COPIES CRUD
// ═══════════════════════════════════════════════════════════════
const getCopies = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM book_copies WHERE book_id=$1 ORDER BY copy_number',
      [req.params.bookId]
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const addCopy = async (req, res) => {
  try {
    const { copy_number, barcode, condition, location } = req.body;
    const bookId = req.params.bookId;
    // Auto-generate copy_number if not provided
    let copyNum = copy_number;
    if (!copyNum) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS cnt FROM book_copies WHERE book_id=$1', [bookId]
      );
      copyNum = 'C-' + String(rows[0].cnt + 1).padStart(3, '0');
    }
    const auto_barcode = barcode || `LIB-${String(bookId).padStart(4,'0')}-${Date.now().toString().slice(-4)}`;
    const { rows } = await pool.query(
      `INSERT INTO book_copies (book_id, copy_number, barcode, condition, location)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [bookId, copyNum, auto_barcode, condition || 'good', location || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Copy number or barcode already exists' });
    serverErr(res, err);
  }
};

const updateCopy = async (req, res) => {
  try {
    const { condition, location, status } = req.body;
    // Only allow status changes to lost/damaged/available from this endpoint
    // (issued is set by issueBook / returnBook)
    const { rows } = await pool.query(
      `UPDATE book_copies SET condition=$1, location=$2, status=COALESCE($3, status)
       WHERE id=$4 RETURNING *`,
      [condition || 'good', location || null, status || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Copy not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

const deleteCopy = async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      'SELECT status FROM book_copies WHERE id=$1', [req.params.id]
    );
    if (!check[0]) return res.status(404).json({ success: false, message: 'Copy not found' });
    if (check[0].status === 'issued')
      return res.status(409).json({ success: false, message: 'Cannot delete: copy is currently issued' });
    await pool.query('DELETE FROM book_copies WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Copy deleted' });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  ISSUE A BOOK
// ═══════════════════════════════════════════════════════════════
const issueBook = async (req, res) => {
  const { book_copy_id, borrower_type, borrower_id, issue_date, due_date, remarks } = req.body;
  if (!book_copy_id || !borrower_type || !borrower_id)
    return res.status(400).json({ success: false, message: 'book_copy_id, borrower_type, borrower_id required' });
  if (!['student','teacher'].includes(borrower_type))
    return res.status(400).json({ success: false, message: 'borrower_type must be student or teacher' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate copy is available
    const { rows: copyRows } = await client.query(
      'SELECT * FROM book_copies WHERE id=$1', [book_copy_id]
    );
    if (!copyRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Copy not found' });
    }
    if (copyRows[0].status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Copy is ${copyRows[0].status}, cannot be issued` });
    }

    // Validate borrower exists
    const table = borrower_type === 'student' ? 'students' : 'teachers';
    const { rows: borrowerRows } = await client.query(
      `SELECT id, full_name FROM ${table} WHERE id=$1`, [borrower_id]
    );
    if (!borrowerRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `${borrower_type} not found` });
    }

    const issueDt = issue_date || new Date().toISOString().slice(0, 10);
    const dueDt   = due_date  || (() => {
      const d = new Date(); d.setDate(d.getDate() + DEFAULT_LOAN_DAYS);
      return d.toISOString().slice(0, 10);
    })();

    const { rows: issueRows } = await client.query(
      `INSERT INTO book_issues (book_copy_id, borrower_type, borrower_id, issue_date, due_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [book_copy_id, borrower_type, borrower_id, issueDt, dueDt, remarks || null]
    );

    await client.query("UPDATE book_copies SET status='issued' WHERE id=$1", [book_copy_id]);

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: `Book issued to ${borrowerRows[0].full_name}`,
      data: issueRows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'This copy already has an active issue' });
    serverErr(res, err);
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════════
//  RETURN A BOOK
// ═══════════════════════════════════════════════════════════════
const returnBook = async (req, res) => {
  const { return_date, remarks } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: issueRows } = await client.query(
      `SELECT bi.*, bc.book_id
       FROM book_issues bi
       JOIN book_copies bc ON bc.id = bi.book_copy_id
       WHERE bi.id=$1 AND bi.status IN ('issued','overdue')`,
      [req.params.id]
    );
    if (!issueRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Issue not found or already returned' });
    }

    const issue      = issueRows[0];
    const retDate    = return_date ? new Date(return_date) : new Date();
    const dueDate    = new Date(issue.due_date);
    const lateDays   = Math.max(0, Math.floor((retDate - dueDate) / 86_400_000));
    const fineAmount = lateDays * FINE_PER_DAY;
    const retStr     = retDate.toISOString().slice(0, 10);

    await client.query(
      `UPDATE book_issues SET status='returned', return_date=$1, remarks=COALESCE($2, remarks)
       WHERE id=$3`,
      [retStr, remarks || null, req.params.id]
    );

    await client.query("UPDATE book_copies SET status='available' WHERE id=$1", [issue.book_copy_id]);

    let fine = null;
    if (fineAmount > 0) {
      const { rows: fineRows } = await client.query(
        `INSERT INTO library_fines
           (issue_id, borrower_type, borrower_id, fine_amount, fine_per_day, late_days)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, issue.borrower_type, issue.borrower_id, fineAmount, FINE_PER_DAY, lateDays]
      );
      fine = fineRows[0];
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: fineAmount > 0 ? `Book returned with fine of PKR ${fineAmount}` : 'Book returned successfully',
      data: { ...issue, return_date: retStr, late_days: lateDays, fine_amount: fineAmount, fine },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════════
//  LIST ISSUES  (with computed overdue status)
// ═══════════════════════════════════════════════════════════════
const getIssues = async (req, res) => {
  try {
    const { status, borrower_type, search, date_from, date_to, limit = 200, offset = 0 } = req.query;

    let conditions = ['1=1'];
    const p = [];
    const push = (v) => { p.push(v); return `$${p.length}`; };

    if (status === 'overdue') {
      conditions.push(`bi.return_date IS NULL AND bi.due_date < CURRENT_DATE`);
    } else if (status === 'active') {
      conditions.push(`bi.status IN ('issued','overdue')`);
    } else if (status && status !== 'all') {
      conditions.push(`bi.status = ${push(status)}`);
    }
    if (borrower_type) conditions.push(`bi.borrower_type = ${push(borrower_type)}`);
    if (date_from)     conditions.push(`bi.issue_date >= ${push(date_from)}`);
    if (date_to)       conditions.push(`bi.issue_date <= ${push(date_to)}`);
    if (search) {
      push(`%${search}%`);
      conditions.push(`(b.title ILIKE $${p.length} OR s.full_name ILIKE $${p.length} OR t.full_name ILIKE $${p.length})`);
    }

    const where = conditions.join(' AND ');
    p.push(limit, offset);

    const { rows } = await pool.query(`
      SELECT
        bi.*,
        cop.copy_number, cop.barcode, cop.location,
        b.id   AS book_id,
        b.title AS book_title, b.author, b.cover_color,
        COALESCE(s.full_name, t.full_name)        AS borrower_name,
        COALESCE(s.roll_number::text, t.phone)  AS borrower_code,
        CASE bi.borrower_type
          WHEN 'student' THEN cl.name
          ELSE t.subject
        END AS borrower_class_dept,
        -- Real-time overdue calculation
        GREATEST(0, (CURRENT_DATE - bi.due_date))::int  AS days_overdue,
        CASE
          WHEN bi.return_date IS NULL AND bi.due_date < CURRENT_DATE THEN 'overdue'
          ELSE bi.status
        END AS computed_status,
        lf.id           AS fine_id,
        lf.fine_amount,
        lf.paid_status  AS fine_paid
      FROM book_issues bi
      JOIN book_copies  cop ON cop.id    = bi.book_copy_id
      JOIN books        b   ON b.id      = cop.book_id
      LEFT JOIN students s  ON s.id      = bi.borrower_id AND bi.borrower_type = 'student'
      LEFT JOIN teachers t  ON t.id      = bi.borrower_id AND bi.borrower_type = 'teacher'
      LEFT JOIN classes  cl ON cl.id     = s.class_id
      LEFT JOIN library_fines lf ON lf.issue_id = bi.id
      WHERE ${where}
      ORDER BY bi.created_at DESC
      LIMIT $${p.length - 1} OFFSET $${p.length}
    `, p);

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  FINES
// ═══════════════════════════════════════════════════════════════
const getFines = async (req, res) => {
  try {
    const { paid_status, borrower_type, limit = 200, offset = 0 } = req.query;
    let q = `
      SELECT lf.*,
        bi.issue_date, bi.due_date, bi.return_date,
        cop.copy_number,
        b.title AS book_title, b.cover_color,
        COALESCE(s.full_name, t.full_name) AS borrower_name,
        COALESCE(s.roll_number::text, t.phone) AS borrower_code,
        CASE lf.borrower_type WHEN 'student' THEN cl.name ELSE t.subject END AS borrower_class_dept
      FROM library_fines lf
      JOIN book_issues bi  ON bi.id      = lf.issue_id
      JOIN book_copies cop ON cop.id     = bi.book_copy_id
      JOIN books b         ON b.id       = cop.book_id
      LEFT JOIN students s ON s.id       = lf.borrower_id AND lf.borrower_type = 'student'
      LEFT JOIN teachers t ON t.id       = lf.borrower_id AND lf.borrower_type = 'teacher'
      LEFT JOIN classes cl ON cl.id      = s.class_id
      WHERE 1=1`;
    const p = [];
    if (paid_status !== undefined && paid_status !== '') {
      p.push(paid_status === 'true' || paid_status === true);
      q += ` AND lf.paid_status = $${p.length}`;
    }
    if (borrower_type) { p.push(borrower_type); q += ` AND lf.borrower_type = $${p.length}`; }
    p.push(limit, offset);
    q += ` ORDER BY lf.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

const markFinePaid = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE library_fines SET paid_status=TRUE, paid_at=NOW(), remarks=COALESCE($1, remarks)
       WHERE id=$2 AND paid_status=FALSE RETURNING *`,
      [req.body.remarks || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Fine not found or already paid' });
    res.json({ success: true, message: 'Fine marked as paid', data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  REPORTS
// ═══════════════════════════════════════════════════════════════
const getMostBorrowed = async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const { rows } = await pool.query(`
      SELECT
        b.id, b.title, b.author, b.cover_color,
        bc.name AS category_name, bc.color AS category_color, bc.icon AS category_icon,
        COUNT(bi.id)::int                           AS total_issues,
        SUM(CASE WHEN bi.status IN ('issued','overdue') THEN 1 ELSE 0 END)::int AS active_issues,
        MAX(bi.issue_date)                          AS last_issued
      FROM books b
      LEFT JOIN book_categories bc ON bc.id = b.category_id
      LEFT JOIN book_copies cop    ON cop.book_id = b.id
      LEFT JOIN book_issues bi     ON bi.book_copy_id = cop.id
      WHERE b.is_active = TRUE
      GROUP BY b.id, bc.name, bc.color, bc.icon
      HAVING COUNT(bi.id) > 0
      ORDER BY total_issues DESC, last_issued DESC
      LIMIT $1
    `, [limit]);
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

const getBorrowingHistory = async (req, res) => {
  try {
    const { borrower_type, search, date_from, date_to, limit = 200, offset = 0 } = req.query;
    let cond = ['1=1'];
    const p = [];
    const push = (v) => { p.push(v); return `$${p.length}`; };

    if (borrower_type) cond.push(`bi.borrower_type = ${push(borrower_type)}`);
    if (date_from)     cond.push(`bi.issue_date >= ${push(date_from)}`);
    if (date_to)       cond.push(`bi.issue_date <= ${push(date_to)}`);
    if (search) {
      push(`%${search}%`);
      cond.push(`(b.title ILIKE $${p.length} OR COALESCE(s.full_name, t.full_name) ILIKE $${p.length})`);
    }

    p.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT
        bi.id, bi.borrower_type, bi.issue_date, bi.due_date, bi.return_date, bi.status,
        b.title AS book_title, b.author, b.cover_color,
        cop.copy_number,
        COALESCE(s.full_name, t.full_name)            AS borrower_name,
        COALESCE(s.roll_number::text, t.phone)       AS borrower_code,
        CASE bi.borrower_type WHEN 'student' THEN cl.name ELSE t.subject END AS borrower_class_dept,
        GREATEST(0,(COALESCE(bi.return_date, CURRENT_DATE) - bi.due_date))::int AS late_days,
        lf.fine_amount, lf.paid_status AS fine_paid
      FROM book_issues bi
      JOIN book_copies  cop ON cop.id  = bi.book_copy_id
      JOIN books        b   ON b.id    = cop.book_id
      LEFT JOIN students s  ON s.id    = bi.borrower_id AND bi.borrower_type = 'student'
      LEFT JOIN teachers t  ON t.id    = bi.borrower_id AND bi.borrower_type = 'teacher'
      LEFT JOIN classes  cl ON cl.id   = s.class_id
      LEFT JOIN library_fines lf ON lf.issue_id = bi.id
      WHERE ${cond.join(' AND ')}
      ORDER BY bi.created_at DESC
      LIMIT $${p.length - 1} OFFSET $${p.length}
    `, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// ═══════════════════════════════════════════════════════════════
//  BORROWER SEARCH  (students + teachers combined)
// ═══════════════════════════════════════════════════════════════
const searchBorrowers = async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (q.trim().length < 2)
      return res.json({ success: true, data: [] });

    const { rows } = await pool.query(`
      SELECT id, full_name AS name, 'student' AS borrower_type,
             roll_number AS identifier,
             (SELECT cl.name FROM classes cl WHERE cl.id = s.class_id) AS extra_info
      FROM students s
      WHERE full_name ILIKE $1 AND status = 'active'
      UNION ALL
      SELECT id, full_name AS name, 'teacher' AS borrower_type,
             phone AS identifier, subject AS extra_info
      FROM teachers
      WHERE full_name ILIKE $1 AND status = 'active'
      ORDER BY name
      LIMIT 20
    `, [`%${q}%`]);
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getSummary,
  getCategories, createCategory, updateCategory, deleteCategory,
  getBooks, getBook, createBook, updateBook, deleteBook,
  getCopies, addCopy, updateCopy, deleteCopy,
  issueBook, returnBook,
  getIssues,
  getFines, markFinePaid,
  getMostBorrowed, getBorrowingHistory,
  searchBorrowers,
};
