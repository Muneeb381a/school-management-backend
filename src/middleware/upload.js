const multer     = require('multer');
const cloudinary = require('../config/cloudinary');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES   = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

// Magic byte signatures — confirms file content matches declared MIME type
const MAGIC_SIGNATURES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png':  [[0x89, 0x50, 0x4E, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],   // RIFF header
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'application/msword': [[0xD0, 0xCF, 0x11, 0xE0]], // OLE2
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    [[0x50, 0x4B, 0x03, 0x04], [0x50, 0x4B, 0x05, 0x06]], // ZIP
};

function matchesMagicBytes(buffer, mimetype) {
  const sigs = MAGIC_SIGNATURES[mimetype];
  if (!sigs || !buffer || buffer.length < 4) return true; // unknown type: pass through
  return sigs.some(sig => sig.every((byte, i) => buffer[i] === byte));
}

// Wraps a multer middleware to add magic-byte validation after buffering
function withMagicCheck(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (err) return next(err);
      const files = req.files
        ? Object.values(req.files).flat()
        : req.file ? [req.file] : [];
      for (const f of files) {
        if (!matchesMagicBytes(f.buffer, f.mimetype)) {
          return next(new Error(`File "${f.originalname}" content does not match its declared type.`));
        }
      }
      next();
    });
  };
}

function makeUploader(allowedTypes) {
  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (_req, file, cb) => {
      if (allowedTypes.includes(file.mimetype)) return cb(null, true);
      cb(new Error(`Only ${allowedTypes.join(', ')} files are allowed`));
    },
  });

  // Override .single() and .array() to auto-apply magic byte check
  const originalSingle = uploader.single.bind(uploader);
  const originalArray  = uploader.array.bind(uploader);
  const originalFields = uploader.fields.bind(uploader);

  uploader.single = (field) => withMagicCheck(originalSingle(field));
  uploader.array  = (field, max) => withMagicCheck(originalArray(field, max));
  uploader.fields = (fields) => withMagicCheck(originalFields(fields));

  return uploader;
}

const photoUpload = makeUploader(IMAGE_TYPES);
const docUpload   = makeUploader(DOC_TYPES);

// CSV upload — accepts text/csv and the Windows application/vnd.ms-excel mime type
const CSV_TYPES = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB for large CSV files
  fileFilter: (_req, file, cb) => {
    const ok = CSV_TYPES.includes(file.mimetype) || file.originalname.endsWith('.csv');
    if (ok) return cb(null, true);
    cb(new Error('Only .csv files are allowed'));
  },
});

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer
 * @param {string} folder  e.g. 'students/photos'
 * @param {object} options  extra cloudinary options
 * @returns {Promise<{secure_url: string, public_id: string}>}
 */
function uploadToCloudinary(buffer, folder, options = {}) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, resource_type: 'auto', ...options },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    ).end(buffer);
  });
}

/**
 * Extract the Cloudinary public_id from a secure_url.
 * URL format: https://res.cloudinary.com/{cloud}/image/upload/v{ver}/{public_id}.{ext}
 */
function publicIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^./]+)?$/);
  return match ? match[1] : null;
}

/**
 * Delete a file from Cloudinary by its stored URL.
 * Tries image resource type first, then raw (for PDFs/docs).
 */
async function deleteFromCloudinary(url) {
  const publicId = publicIdFromUrl(url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch {
    try { await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' }); } catch {}
  }
}

module.exports = { photoUpload, docUpload, csvUpload, uploadToCloudinary, deleteFromCloudinary };
