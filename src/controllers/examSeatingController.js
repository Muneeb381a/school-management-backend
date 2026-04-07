const db = require('../db');
const AppError = require('../utils/AppError');

// ── Halls ─────────────────────────────────────────────────────────────────────
async function getHalls(req, res) {
  const { rows } = await db.query(
    `SELECT h.*, COUNT(p.id) AS plan_count
     FROM exam_halls h
     LEFT JOIN exam_seating_plans p ON p.hall_id = h.id
     GROUP BY h.id ORDER BY h.name`
  );
  res.json({ success: true, data: rows });
}

async function createHall(req, res) {
  const { name, capacity, rows: r, cols, notes } = req.body;
  if (!name || !capacity) throw new AppError('name and capacity are required', 400);
  const { rows } = await db.query(
    `INSERT INTO exam_halls (name, capacity, rows, cols, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, capacity, r || 5, cols || Math.ceil(capacity / (r || 5)), notes || null]
  );
  res.status(201).json({ success: true, data: rows[0] });
}

async function updateHall(req, res) {
  const { name, capacity, rows: r, cols, notes } = req.body;
  const { rows } = await db.query(
    `UPDATE exam_halls SET
       name     = COALESCE($1, name),
       capacity = COALESCE($2, capacity),
       rows     = COALESCE($3, rows),
       cols     = COALESCE($4, cols),
       notes    = COALESCE($5, notes)
     WHERE id = $6 RETURNING *`,
    [name, capacity, r, cols, notes, req.params.id]
  );
  if (!rows[0]) throw new AppError('Hall not found', 404);
  res.json({ success: true, data: rows[0] });
}

async function deleteHall(req, res) {
  const { rows } = await db.query(
    `DELETE FROM exam_halls WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!rows[0]) throw new AppError('Hall not found', 404);
  res.json({ success: true, message: 'Hall deleted' });
}

// ── Seating Plans ─────────────────────────────────────────────────────────────
async function getPlans(req, res) {
  const { exam_id } = req.query;
  const where = exam_id ? 'WHERE p.exam_id = $1' : '';
  const vals  = exam_id ? [exam_id] : [];
  const { rows } = await db.query(
    `SELECT p.*, h.name AS hall_name, h.capacity AS hall_capacity,
            e.title AS exam_title,
            u.name  AS created_by_name,
            COUNT(a.id) AS seat_count
     FROM exam_seating_plans p
     JOIN exam_halls h ON h.id = p.hall_id
     JOIN exams e      ON e.id = p.exam_id
     LEFT JOIN users u ON u.id = p.created_by
     LEFT JOIN exam_seat_assignments a ON a.plan_id = p.id
     ${where}
     GROUP BY p.id, h.name, h.capacity, e.title, u.name
     ORDER BY p.generated_at DESC`,
    vals
  );
  res.json({ success: true, data: rows });
}

async function getPlan(req, res) {
  const { rows: [plan] } = await db.query(
    `SELECT p.*, h.name AS hall_name, h.rows AS hall_rows, h.cols AS hall_cols,
            e.title AS exam_title
     FROM exam_seating_plans p
     JOIN exam_halls h ON h.id = p.hall_id
     JOIN exams e      ON e.id = p.exam_id
     WHERE p.id = $1`, [req.params.id]
  );
  if (!plan) throw new AppError('Plan not found', 404);

  const { rows: seats } = await db.query(
    `SELECT * FROM exam_seat_assignments WHERE plan_id = $1
     ORDER BY seat_row, seat_col`, [req.params.id]
  );
  res.json({ success: true, data: { ...plan, seats } });
}

// POST /api/exam-seating/generate — main generation logic
async function generatePlan(req, res) {
  const { exam_id, hall_id, strategy = 'roll_alternating', title } = req.body;
  if (!exam_id || !hall_id) throw new AppError('exam_id and hall_id are required', 400);

  // Get hall dimensions
  const { rows: [hall] } = await db.query(
    `SELECT * FROM exam_halls WHERE id = $1`, [hall_id]
  );
  if (!hall) throw new AppError('Hall not found', 404);

  // Get students for this exam (via exam's classes)
  const { rows: students } = await db.query(
    `SELECT s.id, s.name, s.roll_number, c.name AS class_name
     FROM exam_results er
     JOIN students s ON s.id = er.student_id
     JOIN classes c ON c.id = s.class_id
     JOIN exam_subjects es ON es.id = er.exam_subject_id
     WHERE es.exam_id = $1
     GROUP BY s.id, s.name, s.roll_number, c.name
     ORDER BY s.roll_number NULLS LAST, s.name`,
    [exam_id]
  );

  // Fallback: get all students if no exam_results yet
  let studentList = students;
  if (!studentList.length) {
    const { rows: allStudents } = await db.query(
      `SELECT s.id, s.name, s.roll_number, c.name AS class_name
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.status = 'active'
       ORDER BY s.roll_number NULLS LAST, s.name
       LIMIT $1`, [hall.capacity]
    );
    studentList = allStudents;
  }

  // Apply strategy ordering
  if (strategy === 'alphabetical') {
    studentList.sort((a, b) => a.name.localeCompare(b.name));
  } else if (strategy === 'class_alternating') {
    // Interleave by class
    const byClass = {};
    studentList.forEach(s => {
      const k = s.class_name || 'unknown';
      (byClass[k] = byClass[k] || []).push(s);
    });
    const groups = Object.values(byClass);
    studentList = [];
    let i = 0;
    while (groups.some(g => g.length > i)) {
      groups.forEach(g => { if (g[i]) studentList.push(g[i]); });
      i++;
    }
  } else if (strategy === 'random') {
    for (let i = studentList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [studentList[i], studentList[j]] = [studentList[j], studentList[i]];
    }
  }
  // roll_alternating: default sort by roll_number (already done above)

  // Limit to hall capacity
  const assigned = studentList.slice(0, hall.rows * hall.cols);

  // Upsert plan
  await db.query(
    `INSERT INTO exam_seating_plans (exam_id, hall_id, strategy, title, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (exam_id, hall_id)
     DO UPDATE SET strategy = EXCLUDED.strategy, title = EXCLUDED.title, generated_at = NOW()`,
    [exam_id, hall_id, strategy, title || null, req.user.id]
  );
  const { rows: [plan] } = await db.query(
    `SELECT id FROM exam_seating_plans WHERE exam_id = $1 AND hall_id = $2`, [exam_id, hall_id]
  );

  // Delete old assignments
  await db.query(`DELETE FROM exam_seat_assignments WHERE plan_id = $1`, [plan.id]);

  // Insert new seat assignments (row-major order)
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const insertValues = [];
  const insertParams = [];
  let idx = 0;
  let paramIdx = 1;

  for (let row = 0; row < hall.rows && idx < assigned.length; row++) {
    for (let col = 0; col < hall.cols && idx < assigned.length; col++) {
      const s = assigned[idx++];
      const label = `${ALPHA[row] || (row + 1)}${col + 1}`;
      insertValues.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
      );
      insertParams.push(plan.id, s.id, row + 1, col + 1, label, s.roll_number, s.name, s.class_name || '');
    }
  }

  if (insertValues.length) {
    await db.query(
      `INSERT INTO exam_seat_assignments (plan_id, student_id, seat_row, seat_col, seat_label, roll_number, student_name, class_name)
       VALUES ${insertValues.join(',')}`,
      insertParams
    );
  }

  // Return the full plan
  const { rows: [fullPlan] } = await db.query(
    `SELECT p.*, h.name AS hall_name, h.rows AS hall_rows, h.cols AS hall_cols, e.title AS exam_title
     FROM exam_seating_plans p
     JOIN exam_halls h ON h.id = p.hall_id
     JOIN exams e ON e.id = p.exam_id
     WHERE p.id = $1`, [plan.id]
  );
  const { rows: seats } = await db.query(
    `SELECT * FROM exam_seat_assignments WHERE plan_id = $1 ORDER BY seat_row, seat_col`, [plan.id]
  );

  res.status(201).json({ success: true, data: { ...fullPlan, seats } });
}

async function deletePlan(req, res) {
  const { rows } = await db.query(
    `DELETE FROM exam_seating_plans WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!rows[0]) throw new AppError('Plan not found', 404);
  res.json({ success: true, message: 'Plan deleted' });
}

module.exports = {
  getHalls, createHall, updateHall, deleteHall,
  getPlans, getPlan, generatePlan, deletePlan,
};
