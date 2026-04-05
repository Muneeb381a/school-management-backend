const db = require('../db');

async function calculateRisk(studentId) {
  const [attendance, exams, homework, fees] = await Promise.all([
    getAttendanceSignal(studentId),
    getExamSignal(studentId),
    getHomeworkSignal(studentId),
    getFeeSignal(studentId),
  ]);

  const score =
    attendance.signal * 0.35 +
    exams.signal      * 0.30 +
    homework.signal   * 0.20 +
    fees.signal       * 0.15;

  const band = score >= 61 ? 'high' : score >= 31 ? 'medium' : 'low';
  return {
    score:            parseFloat(score.toFixed(2)),
    band,
    attendance_score: attendance.signal,
    exam_score:       exams.signal,
    homework_score:   homework.signal,
    fee_score:        fees.signal,
    details:          { attendance, exams, homework, fees },
  };
}

async function getAttendanceSignal(studentId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'absent') AS absent
     FROM attendance
     WHERE student_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'`,
    [studentId]
  );
  const { total, absent } = rows[0];
  if (!+total) return { signal: 0, absent_pct: 0, total_days: 0 };
  const absent_pct = (+absent / +total) * 100;
  const signal = Math.min(100, (absent_pct / 25) * 100);
  return { signal: parseFloat(signal.toFixed(2)), absent_pct: parseFloat(absent_pct.toFixed(1)), total_days: +total };
}

async function getExamSignal(studentId) {
  const { rows } = await db.query(
    `SELECT AVG(CASE WHEN er.total_marks > 0
                THEN (er.obtained_marks::float / er.total_marks) * 100
                ELSE NULL END) AS avg_pct
     FROM exam_results er
     WHERE er.student_id = $1 AND er.created_at >= CURRENT_DATE - INTERVAL '90 days'`,
    [studentId]
  );
  const avg_pct = parseFloat(rows[0]?.avg_pct) || null;
  if (avg_pct === null) return { signal: 0, avg_pct: null };
  const signal = avg_pct >= 60 ? 0 : avg_pct <= 30 ? 100 : ((60 - avg_pct) / 30) * 100;
  return { signal: parseFloat(signal.toFixed(2)), avg_pct: parseFloat(avg_pct.toFixed(1)) };
}

async function getHomeworkSignal(studentId) {
  const { rows } = await db.query(
    `SELECT COUNT(h.id) AS assigned,
            COUNT(hs.id) FILTER (WHERE hs.status IN ('submitted','graded')) AS submitted
     FROM homework h
     LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = $1
     WHERE h.due_date >= CURRENT_DATE - INTERVAL '30 days'`,
    [studentId]
  );
  const { assigned, submitted } = rows[0];
  if (!+assigned) return { signal: 0, submission_pct: 100, assigned: 0 };
  const submission_pct = (+submitted / +assigned) * 100;
  return { signal: parseFloat((100 - submission_pct).toFixed(2)), submission_pct: parseFloat(submission_pct.toFixed(1)), assigned: +assigned };
}

async function getFeeSignal(studentId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS overdue FROM fee_invoices
     WHERE student_id = $1 AND status = 'overdue'`,
    [studentId]
  );
  const overdue = +rows[0].overdue;
  return { signal: overdue > 0 ? 80 : 0, overdue_count: overdue };
}

async function recalculateAll() {
  const { rows: students } = await db.query(
    `SELECT id FROM students WHERE status = 'active'`
  );
  let updated = 0, errors = 0;
  for (const { id } of students) {
    try {
      const risk = await calculateRisk(id);
      await db.query(
        `INSERT INTO student_risk_scores
           (student_id, score, band, attendance_score, exam_score, homework_score, fee_score, calculated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (student_id) DO UPDATE SET
           score = EXCLUDED.score, band = EXCLUDED.band,
           attendance_score = EXCLUDED.attendance_score,
           exam_score       = EXCLUDED.exam_score,
           homework_score   = EXCLUDED.homework_score,
           fee_score        = EXCLUDED.fee_score,
           calculated_at    = NOW()`,
        [id, risk.score, risk.band, risk.attendance_score, risk.exam_score, risk.homework_score, risk.fee_score]
      );
      updated++;
    } catch (err) {
      errors++;
      console.error(`[RiskEngine] Failed for student ${id}:`, err.message);
    }
  }
  console.log(`[RiskEngine] Recalculated ${updated} students, ${errors} errors`);
  return { updated, errors };
}

module.exports = { calculateRisk, recalculateAll };
