const pool = require('../db');
const { serverErr } = require('../utils/serverErr');

// All tables in dependency order (parents before children).
// Used for both export and restore.
const BACKUP_TABLES = [
  // Foundation
  'academic_years',
  'settings',
  'users',
  // Core entities
  'classes',
  'subjects',
  'teachers',
  'students',
  // Relationships & structures
  'class_subjects',
  'teacher_classes',
  'teacher_subject_assignments',
  'fee_heads',
  'fee_structures',
  'student_concessions',
  // Timetable
  'periods',
  'timetable_entries',
  // Transactional
  'attendance',
  'fee_invoices',
  'fee_invoice_items',
  'fee_payments',
  'salary_payments',
  // Modules
  'exams',
  'announcements',
  'events',
  'homework',
  'expense_categories',
  'expenses',
  // Transport / Library / Inventory
  'transport_routes',
  'vehicles',
  'student_transport',
  'books',
  'book_issues',
  'inventory_categories',
  'inventory_items',
  // Salary
  'salary_structures',
  'salary_policies',
  // Exams & marks
  'exam_subjects',
  'student_marks',
  // Non-teaching staff
  'staff',
  'staff_attendance',
  // Misc
  'notifications',
  'student_documents',
  'teacher_documents',
];


/* ─── GET /api/backup/export ─────────────────────────────────────────── */
const exportBackup = async (req, res) => {
  try {
    const backup = {
      app:         'SchoolMS',
      version:     '1.0',
      exported_at: new Date().toISOString(),
      exported_by: req.user?.name ?? 'admin',
      tables:      {},
    };

    const results = await Promise.allSettled(
      BACKUP_TABLES.map(table =>
        pool.query(`SELECT * FROM "${table}" ORDER BY id`).then(r => ({ table, rows: r.rows }))
      )
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        backup.tables[result.value.table] = result.value.rows;
      } else {
        // Extract table name from rejected promise meta — fall back to empty
        const idx = results.indexOf(result);
        backup.tables[BACKUP_TABLES[idx]] = [];
      }
    }

    const totalRows = Object.values(backup.tables).reduce((sum, rows) => sum + rows.length, 0);
    backup.total_rows = totalRows;

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="schoolms-backup-${date}.json"`);
    return res.json(backup);
  } catch (err) { serverErr(res, err); }
};

/* ─── POST /api/backup/restore ──────────────────────────────────────────
   Body: { confirm: "RESTORE", tables: { tableName: [...rows] } }
   Admin only. Truncates all tables then re-inserts from backup data.
   ─────────────────────────────────────────────────────────────────────── */
const restoreBackup = async (req, res) => {
  const { confirm, tables } = req.body;

  if (confirm !== 'RESTORE') {
    return res.status(400).json({
      success: false,
      message: 'Send { confirm: "RESTORE" } to confirm this destructive action.',
    });
  }

  if (!tables || typeof tables !== 'object') {
    return res.status(400).json({ success: false, message: 'Invalid backup data.' });
  }

  // Only restore tables we know about — prevents SQL injection via table names
  const validTables = BACKUP_TABLES.filter(t => Array.isArray(tables[t]) && tables[t].length > 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Truncate all at once with CASCADE — PostgreSQL handles FK ordering automatically
    if (validTables.length > 0) {
      const tableList = validTables.map(t => `"${t}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    }

    // Insert rows in dependency order
    let totalInserted = 0;
    for (const table of BACKUP_TABLES) {
      const rows = tables[table];
      if (!rows?.length) continue;
      if (!validTables.includes(table)) continue;

      const cols    = Object.keys(rows[0]);
      const colList = cols.map(c => `"${c}"`).join(', ');

      for (const row of rows) {
        const vals    = cols.map((_, i) => `$${i + 1}`).join(', ');
        const values  = cols.map(c => row[c]);
        await client.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${vals})`,
          values
        );
        totalInserted++;
      }

      // Reset the sequence so new inserts after restore get correct IDs
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
            COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
        );
      } catch { /* table has no serial id column — ignore */ }
    }

    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `Restore complete. ${totalInserted} rows inserted across ${validTables.length} tables.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

module.exports = { exportBackup, restoreBackup };
