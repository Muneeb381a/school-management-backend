const pool = require('../db');

const serverErr = (res, err) => {
  console.error('[SEARCH]', err.message);
  res.status(500).json({ success: false, message: err.message });
};

// ── GET /api/search?q=...  ────────────────────────────────────
// Returns up to 5 results per category:
//   students | teachers | fees | books | classes | exams | announcements
const globalSearch = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2)
      return res.json({ success: true, data: {} });

    const like = `%${q}%`;

    const [students, teachers, fees, books, classes, exams, announcements] = await Promise.all([
      // Students
      pool.query(
        `SELECT s.id, s.full_name, s.roll_number, s.b_form_no,
                c.name AS class_name, c.section
         FROM students s
         LEFT JOIN classes c ON c.id = s.class_id
         WHERE s.full_name   ILIKE $1
            OR s.roll_number ILIKE $1
            OR s.b_form_no   ILIKE $1
            OR s.father_name ILIKE $1
         ORDER BY s.full_name
         LIMIT 6`,
        [like]
      ),

      // Teachers
      pool.query(
        `SELECT id, full_name, subject, phone, status
         FROM teachers
         WHERE full_name ILIKE $1
            OR email     ILIKE $1
            OR phone     ILIKE $1
            OR subject   ILIKE $1
         ORDER BY full_name
         LIMIT 5`,
        [like]
      ),

      // Fee invoices
      pool.query(
        `SELECT fi.id, fi.invoice_number, fi.status, fi.total_amount,
                s.full_name AS student_name, fi.invoice_date
         FROM fee_invoices fi
         JOIN students s ON s.id = fi.student_id
         WHERE fi.invoice_number ILIKE $1
            OR s.full_name       ILIKE $1
         ORDER BY fi.invoice_date DESC
         LIMIT 5`,
        [like]
      ),

      // Library books
      pool.query(
        `SELECT b.id, b.title, b.author, b.isbn,
                bc.name AS category_name, b.available_copies, b.total_copies
         FROM books b
         LEFT JOIN book_categories bc ON bc.id = b.category_id
         WHERE b.title  ILIKE $1
            OR b.author ILIKE $1
            OR b.isbn   ILIKE $1
         ORDER BY b.title
         LIMIT 5`,
        [like]
      ),

      // Classes
      pool.query(
        `SELECT c.id, c.name, c.section, c.grade,
                t.full_name AS teacher_name,
                (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'active')::int AS student_count
         FROM classes c
         LEFT JOIN teachers t ON t.id = c.class_teacher_id
         WHERE c.name    ILIKE $1
            OR c.section ILIKE $1
            OR c.grade   ILIKE $1
         ORDER BY c.name
         LIMIT 5`,
        [like]
      ),

      // Exams
      pool.query(
        `SELECT e.id, e.name AS exam_name, e.exam_type, e.start_date, e.end_date, e.status
         FROM exams e
         WHERE e.name      ILIKE $1
            OR e.exam_type ILIKE $1
         ORDER BY e.start_date DESC
         LIMIT 5`,
        [like]
      ),

      // Announcements
      pool.query(
        `SELECT id, title, category, priority, created_at
         FROM announcements
         WHERE title   ILIKE $1
            OR content ILIKE $1
         ORDER BY created_at DESC
         LIMIT 4`,
        [like]
      ),
    ]);

    res.json({
      success: true,
      query: q,
      data: {
        students:      students.rows,
        teachers:      teachers.rows,
        fees:          fees.rows,
        books:         books.rows,
        classes:       classes.rows,
        exams:         exams.rows,
        announcements: announcements.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

module.exports = { globalSearch };
