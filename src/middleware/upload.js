const multer     = require('multer');
const cloudinary = require('../config/cloudinary');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES   = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function makeUploader(allowedTypes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (_req, file, cb) => {
      if (allowedTypes.includes(file.mimetype)) return cb(null, true);
      cb(new Error(`Only ${allowedTypes.join(', ')} files are allowed`));
    },
  });
}

const photoUpload = makeUploader(IMAGE_TYPES);
const docUpload   = makeUploader(DOC_TYPES);

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

module.exports = { photoUpload, docUpload, uploadToCloudinary, deleteFromCloudinary };
