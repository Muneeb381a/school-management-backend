const pool = require('../db');

// Get a single student by ID (throws if not found)
async function getById(id) {
  const { rows } = await pool.query('SELECT * FROM students WHERE id=$1', [id]);
  if (!rows[0]) throw new Error(`Student ${id} not found`);
  return rows[0];
}

// Get paginated student list with filters
// filters: { search, grade, section, status, class_id }
// Returns { rows, total }
async function list({ search, grade, section, status, class_id, page = 1, limit = 20 } = {}) {
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(
      `(s.full_name ILIKE $${idx} OR s.admission_no ILIKE $${idx} OR s.father_name ILIKE $${idx} OR s.father_phone ILIKE $${idx})`
    );
  }

  if (grade) {
    params.push(grade);
    conditions.push(`s.grade = $${params.length}`);
  }

  if (section) {
    params.push(section);
    conditions.push(`s.section = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`s.status = $${params.length}`);
  }

  if (class_id) {
    params.push(class_id);
    conditions.push(`s.class_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const join = class_id ? `JOIN classes c ON c.id = s.class_id` : `LEFT JOIN classes c ON c.id = s.class_id`;

  const offset = (Number(page) - 1) * Number(limit);

  const countQuery = `SELECT COUNT(*)::int AS total FROM students s ${join} ${where}`;
  const dataQuery = `
    SELECT s.*, c.name AS class_name
    FROM students s
    ${join}
    ${where}
    ORDER BY s.full_name
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const [countResult, dataResult] = await Promise.all([
    pool.query(countQuery, params),
    pool.query(dataQuery, [...params, limit, offset]),
  ]);

  return {
    rows: dataResult.rows,
    total: countResult.rows[0].total,
  };
}

// Get student count by status
async function countByStatus() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')::int      AS active,
       COUNT(*) FILTER (WHERE status = 'inactive')::int    AS inactive,
       COUNT(*) FILTER (WHERE status = 'suspended')::int   AS suspended,
       COUNT(*) FILTER (WHERE status = 'graduated')::int   AS graduated
     FROM students`
  );
  return rows[0];
}

// Get students in a class
async function listByClass(classId) {
  const { rows } = await pool.query(
    `SELECT * FROM students WHERE class_id=$1 AND status='active' ORDER BY full_name`,
    [classId]
  );
  return rows;
}

// Get attendance summary for a student (this month)
// month = 'YYYY-MM', defaults to current month
// Returns { present, absent, late, total_days, percentage }
async function getAttendanceSummary(studentId, month) {
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'present')::int AS present,
       COUNT(*) FILTER (WHERE status = 'absent')::int  AS absent,
       COUNT(*) FILTER (WHERE status = 'late')::int    AS late,
       COUNT(*)::int                                    AS total_days
     FROM attendance
     WHERE entity_type = 'student'
       AND entity_id = $1
       AND TO_CHAR(date, 'YYYY-MM') = $2
       AND period_id IS NULL`,
    [studentId, targetMonth]
  );

  const { present, absent, late, total_days } = rows[0];
  const percentage =
    total_days > 0 ? Math.round(((present + late) / total_days) * 100) : 0;

  return { present, absent, late, total_days, percentage };
}

module.exports = {
  getById,
  list,
  countByStatus,
  listByClass,
  getAttendanceSummary,
};
