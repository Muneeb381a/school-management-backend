/**
 * chatUpload.js
 * Multer middleware scoped to chat file attachments.
 *
 * Allowed types: images (jpeg/png/webp/gif) + documents (pdf, word, excel)
 * Max size: 10 MB
 *
 * Usage:
 *   router.post('/rooms/:id/upload', chatUpload.single('file'), ctrl.uploadAttachment)
 */

const multer = require('multer');

const ALLOWED_MIME = [
  // Images
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Spreadsheets
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type not allowed. Allowed: images, PDF, Word, Excel`));
  },
});

module.exports = chatUpload;
