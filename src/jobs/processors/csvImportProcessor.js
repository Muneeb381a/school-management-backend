/**
 * CSV Import job processor.
 * Handles large student/teacher CSV imports as background jobs.
 */

const pool = require('../../db');

/**
 * Process a student CSV import job.
 * job.data: { rows: Array<Object>, importedBy: number }
 */
async function processStudentImport(job) {
  const { rows, importedBy } = job.data;
  const results = { imported: 0, failed: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Validate required fields
      if (!row.full_name || !row.grade || !row.gender) {
        throw new Error('Missing required fields: full_name, grade, gender');
      }
      // Insert student
      await pool.query(
        `INSERT INTO students (full_name, grade, gender, father_name, father_phone, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT DO NOTHING`,
        [row.full_name.trim(), row.grade, row.gender, row.father_name || null, row.father_phone || null]
      );
      results.imported++;
    } catch (err) {
      results.failed++;
      results.errors.push({ row: i + 2, message: err.message });
    }
    // Update progress every 10 rows
    if (i % 10 === 0) {
      job.output = { progress: Math.round((i / rows.length) * 100), ...results };
    }
  }
  return results;
}

module.exports = { processStudentImport };
