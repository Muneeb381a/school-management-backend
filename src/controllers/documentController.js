const db = require('../db');
const AppError = require('../utils/AppError');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../../uploads');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// GET /api/documents
async function getDocuments(req, res) {
  const { student_id, category, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const vals = [];

  if (student_id) { vals.push(student_id); conditions.push(`d.student_id = $${vals.length}`); }
  if (category)   { vals.push(category);   conditions.push(`d.category = $${vals.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  vals.push(+limit, +offset);

  const { rows } = await db.query(
    `SELECT d.*, s.name AS student_name, u.name AS uploaded_by_name
     FROM documents d
     LEFT JOIN students s ON s.id = d.student_id
     LEFT JOIN users u ON u.id = d.uploaded_by
     ${where}
     ORDER BY d.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  res.json({ success: true, data: rows });
}

// GET /api/documents/:id
async function getDocument(req, res) {
  const { rows: [doc] } = await db.query(
    `SELECT * FROM documents WHERE id = $1`, [req.params.id]
  );
  if (!doc) throw new AppError('Document not found', 404);
  res.json({ success: true, data: doc });
}

// POST /api/documents  — upload (expects multipart or base64)
async function uploadDocument(req, res) {
  ensureUploadDir();
  const { student_id, category = 'general', title, description } = req.body;
  if (!title) throw new AppError('title is required', 400);

  // Handle multer file upload if file is present
  const file = req.file;
  let file_url = req.body.file_url || null;
  let file_name = req.body.file_name || null;
  let file_size = req.body.file_size || null;
  let mime_type = req.body.mime_type || null;

  if (file) {
    file_url  = `/uploads/${file.filename}`;
    file_name = file.originalname;
    file_size = file.size;
    mime_type = file.mimetype;
  }

  const { rows: [doc] } = await db.query(
    `INSERT INTO documents (student_id, title, description, category, file_url, file_name, file_size, mime_type, uploaded_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
    [student_id || null, title, description || null, category, file_url, file_name, file_size, mime_type, req.user.id]
  );
  res.status(201).json({ success: true, data: doc });
}

// PUT /api/documents/:id
async function updateDocument(req, res) {
  const { title, description, category } = req.body;
  const { rows: [doc] } = await db.query(
    `UPDATE documents SET title = COALESCE($1, title), description = COALESCE($2, description),
     category = COALESCE($3, category), updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [title, description, category, req.params.id]
  );
  if (!doc) throw new AppError('Document not found', 404);
  res.json({ success: true, data: doc });
}

// DELETE /api/documents/:id
async function deleteDocument(req, res) {
  const { rows: [doc] } = await db.query(
    `DELETE FROM documents WHERE id = $1 RETURNING *`, [req.params.id]
  );
  if (!doc) throw new AppError('Document not found', 404);
  // Optionally delete physical file
  if (doc.file_url) {
    const filepath = path.join(UPLOAD_DIR, path.basename(doc.file_url));
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
  res.json({ success: true, message: 'Document deleted' });
}

module.exports = { getDocuments, getDocument, uploadDocument, updateDocument, deleteDocument };
