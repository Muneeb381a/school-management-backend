/**
 * Cloudinary helpers — signed URL generation for sensitive assets.
 *
 * Why signed URLs?
 * Public Cloudinary URLs are permanent and guessable by anyone who has the URL.
 * Signed URLs have a short expiry, so even if a URL leaks it becomes useless quickly.
 *
 * Usage:
 *   const { getSignedUrl } = require('../utils/cloudinary');
 *   const url = getSignedUrl('students/photos/abc123', 3600); // 1-hour expiry
 */

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Generate a signed delivery URL for a Cloudinary asset.
 *
 * @param {string} publicId          The Cloudinary public_id of the asset.
 * @param {number} expiresInSeconds  URL lifetime in seconds (default: 3600 = 1 hour).
 * @returns {string}                 Signed Cloudinary URL.
 */
function getSignedUrl(publicId, expiresInSeconds = 3600) {
  if (!publicId) return null;

  return cloudinary.url(publicId, {
    sign_url:  true,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    type:      'upload',
    secure:    true,
  });
}

/**
 * Extract the public_id from a full Cloudinary URL.
 * e.g. "https://res.cloudinary.com/demo/image/upload/v123/students/photos/abc.jpg"
 *      → "students/photos/abc"
 *
 * @param {string} url  Full Cloudinary URL.
 * @returns {string|null}
 */
function publicIdFromUrl(url) {
  if (!url) return null;
  try {
    // Strip base + /v<version>/ + extension
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

module.exports = { cloudinary, getSignedUrl, publicIdFromUrl };
