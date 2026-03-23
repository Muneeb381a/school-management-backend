const pool = require('../db');

// Mark attendance for multiple students in a class
// records: Array of { student_id, status: 'present'|'absent'|'late'|'leave' }
async function markBulk(classId, date, records, markedById) {
  if (!records?.length) return { marked: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let marked = 0;

    for (const r of records) {
      await client.query(
        `INSERT INTO attendance (entity_type, entity_id, class_id, date, status, marked_by)
         VALUES ('student', $1, $2, $3, $4, $5)
         ON CONFLICT (entity_type, entity_id, date) WHERE period_id IS NULL
         DO UPDATE SET status=$4, marked_by=$5, updated_at=NOW()`,
        [r.student_id, classId, date, r.status, markedById]
      );
      marked++;
    }

    await client.query('COMMIT');
    return { marked };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Get monthly attendance register for a class
// month = 'YYYY-MM'
// Returns rows of: student_id, full_name, attendance: { 'YYYY-MM-DD': status }
async function getMonthlyRegister(classId, month) {
  const { rows: students } = await pool.query(
    `SELECT id, full_name FROM students WHERE class_id=$1 AND status='active' ORDER BY full_name`,
    [classId]
  );

  const { rows: records } = await pool.query(
    `SELECT entity_id AS student_id, date, status
     FROM attendance
     WHERE entity_type='student' AND class_id=$1
       AND TO_CHAR(date,'YYYY-MM')=$2
       AND period_id IS NULL
     ORDER BY date`,
    [classId, month]
  );

  // Build map: studentId -> { 'YYYY-MM-DD' -> status }
  const map = {};
  for (const r of records) {
    if (!map[r.student_id]) map[r.student_id] = {};
    map[r.student_id][r.date.toISOString().slice(0, 10)] = r.status;
  }

  return students.map(s => ({ ...s, attendance: map[s.id] || {} }));
}

// Get attendance rate for a class this month (%)
async function getClassRate(classId, month) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('present','late'))::float AS present,
       COUNT(*)::float AS total
     FROM attendance
     WHERE entity_type='student' AND class_id=$1 AND TO_CHAR(date,'YYYY-MM')=$2 AND period_id IS NULL`,
    [classId, month]
  );

  const { present, total } = rows[0];
  return total > 0 ? Math.round((present / total) * 100) : 0;
}

module.exports = {
  markBulk,
  getMonthlyRegister,
  getClassRate,
};
