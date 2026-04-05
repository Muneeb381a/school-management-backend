const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '../../../backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function createBackup(schema = 'public') {
  ensureBackupDir();
  const filename = `backup_${schema}_${timestamp()}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not configured');

  return new Promise((resolve, reject) => {
    const cmd = `pg_dump "${url}" --schema="${schema}" -f "${filepath}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('[Backup] pg_dump failed:', stderr);
        return reject(new Error(stderr || err.message));
      }
      const stat = fs.statSync(filepath);
      console.log(`[Backup] Created ${filename} (${stat.size} bytes)`);
      resolve({ filename, filepath, size: stat.size });
    });
  });
}

async function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, createdAt: stat.birthtime };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return files;
}

async function deleteBackup(filename) {
  const filepath = path.join(BACKUP_DIR, filename);
  if (!filepath.startsWith(BACKUP_DIR)) throw new Error('Invalid filename');
  if (!fs.existsSync(filepath)) throw new Error('Backup not found');
  fs.unlinkSync(filepath);
  return { deleted: filename };
}

// Purge backups older than N days
async function purgeOldBackups(days = 30) {
  ensureBackupDir();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sql'));
  let deleted = 0;
  for (const f of files) {
    const stat = fs.statSync(path.join(BACKUP_DIR, f));
    if (stat.birthtimeMs < cutoff) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      deleted++;
    }
  }
  return { deleted };
}

module.exports = { createBackup, listBackups, deleteBackup, purgeOldBackups };
