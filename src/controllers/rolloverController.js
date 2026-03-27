const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// GET /rollover/preview
// Returns all active classes with student counts
const getRolloverPreview = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              COUNT(s.id) AS student_count
       FROM classes c
       LEFT JOIN students s ON s.class_id = c.id
         AND s.deleted_at IS NULL
         AND s.status = 'active'
       GROUP BY c.id
       ORDER BY c.grade, c.section`,
    );

    // Suggest next class name using grade logic (increment grade number)
    const withSuggestion = rows.map((cls) => {
      let suggestedNext = null;
      if (cls.name) {
        // Replace first occurrence of a number with number+1
        suggestedNext = cls.name.replace(/(\d+)/, (match, num) => String(parseInt(num, 10) + 1));
      }
      return { ...cls, suggested_next_class: suggestedNext };
    });

    res.json({ success: true, data: withSuggestion, total: withSuggestion.length });
  } catch (err) { serverErr(res, err); }
};

// POST /rollover/promote
// Body: {records:[{student_id, from_class_id, to_class_id, action, notes}], from_year, to_year, promoted_by}
const bulkPromote = async (req, res) => {
  const client = await pool.connect();
  try {
    const { records, from_year, to_year, promoted_by } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: 'records array is required' });
    }
    if (!from_year || !to_year) {
      return res.status(400).json({ success: false, message: 'from_year and to_year are required' });
    }

    await client.query('BEGIN');

    const results = [];
    for (const rec of records) {
      const { student_id, from_class_id, to_class_id, action, notes } = rec;

      if (!student_id || !action) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Each record needs student_id and action' });
      }

      // Update student's class and status based on action
      if (action === 'promoted' && to_class_id) {
        await client.query(
          'UPDATE students SET class_id=$1 WHERE id=$2',
          [to_class_id, student_id],
        );
      } else if (action === 'graduated') {
        await client.query(
          "UPDATE students SET status='graduated' WHERE id=$1",
          [student_id],
        );
      }

      // Upsert promotion record — idempotent: re-running the wizard updates instead of duplicating
      const { rows } = await client.query(
        `INSERT INTO promotion_records
           (from_academic_year, to_academic_year, from_class_id, to_class_id,
            student_id, action, promoted_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (student_id, from_academic_year, to_academic_year)
         DO UPDATE SET
           action       = EXCLUDED.action,
           to_class_id  = EXCLUDED.to_class_id,
           promoted_by  = EXCLUDED.promoted_by,
           notes        = EXCLUDED.notes,
           promoted_at  = NOW()
         RETURNING *, (xmax = 0) AS is_new`,
        [from_year, to_year, from_class_id || null, to_class_id || null,
         student_id, action, promoted_by || null, notes || null],
      );
      results.push(rows[0]);
    }

    const newCount     = results.filter(r => r.is_new).length;
    const updatedCount = results.length - newCount;

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: results,
      message: `${results.length} student(s) processed (${newCount} new, ${updatedCount} updated)`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// POST /rollover/activate-year
// Body: {new_year_label}
const activateNewYear = async (req, res) => {
  const client = await pool.connect();
  try {
    const { new_year_label } = req.body;
    if (!new_year_label) {
      return res.status(400).json({ success: false, message: 'new_year_label is required' });
    }

    await client.query('BEGIN');

    // Deactivate all current years
    await client.query(`UPDATE academic_years SET is_active=FALSE WHERE is_active=TRUE`);

    // Activate the target year
    const { rows } = await client.query(
      `UPDATE academic_years SET is_active=TRUE WHERE label=$1 RETURNING *`,
      [new_year_label],
    );

    if (rows.length === 0) {
      // Create year if it doesn't exist
      await client.query(
        `INSERT INTO academic_years (label, is_active) VALUES ($1, TRUE)`,
        [new_year_label],
      );
    }

    // Update settings if active_academic_year column exists
    try {
      await client.query(
        `UPDATE settings SET active_academic_year=$1`,
        [new_year_label],
      );
    } catch (_e) {
      // Column may not exist — skip silently
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Academic year ${new_year_label} activated` });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// GET /rollover/history?academic_year
const getPromotionHistory = async (req, res) => {
  try {
    const { academic_year } = req.query;
    let q = `
      SELECT pr.*,
             s.full_name AS student_name,
             fc.name AS from_class,
             tc.name AS to_class
      FROM promotion_records pr
      JOIN students s ON s.id = pr.student_id
      LEFT JOIN classes fc ON fc.id = pr.from_class_id
      LEFT JOIN classes tc ON tc.id = pr.to_class_id
      WHERE 1=1
    `;
    const p = [];
    if (academic_year) { p.push(academic_year); q += ` AND pr.to_academic_year=$${p.length}`; }
    q += ' ORDER BY pr.promoted_at DESC';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

module.exports = { getRolloverPreview, bulkPromote, activateNewYear, getPromotionHistory };
