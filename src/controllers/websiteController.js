const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/website/config  (public — no auth)
async function getConfig(req, res) {
  const { rows: [config] } = await db.query(`SELECT * FROM website_config LIMIT 1`);
  const { rows: sections } = await db.query(
    `SELECT * FROM website_sections WHERE visible = true ORDER BY sort_order, id`
  );
  res.json({ success: true, data: { config: config || {}, sections } });
}

// PUT /api/website/config  (admin)
async function updateConfig(req, res) {
  const {
    school_name, tagline, logo_url, hero_image_url, hero_title, hero_subtitle,
    about_text, contact_email, contact_phone, contact_address,
    facebook_url, twitter_url, instagram_url, youtube_url,
    primary_color, accent_color, published, custom_domain,
  } = req.body;

  const { rows: [row] } = await db.query(
    `UPDATE website_config SET
       school_name     = COALESCE($1,  school_name),
       tagline         = COALESCE($2,  tagline),
       logo_url        = COALESCE($3,  logo_url),
       hero_image_url  = COALESCE($4,  hero_image_url),
       hero_title      = COALESCE($5,  hero_title),
       hero_subtitle   = COALESCE($6,  hero_subtitle),
       about_text      = COALESCE($7,  about_text),
       contact_email   = COALESCE($8,  contact_email),
       contact_phone   = COALESCE($9,  contact_phone),
       contact_address = COALESCE($10, contact_address),
       facebook_url    = COALESCE($11, facebook_url),
       twitter_url     = COALESCE($12, twitter_url),
       instagram_url   = COALESCE($13, instagram_url),
       youtube_url     = COALESCE($14, youtube_url),
       primary_color   = COALESCE($15, primary_color),
       accent_color    = COALESCE($16, accent_color),
       published       = COALESCE($17, published),
       custom_domain   = COALESCE($18, custom_domain),
       updated_at      = NOW()
     WHERE id = (SELECT id FROM website_config LIMIT 1) RETURNING *`,
    [school_name, tagline, logo_url, hero_image_url, hero_title, hero_subtitle,
     about_text, contact_email, contact_phone, contact_address,
     facebook_url, twitter_url, instagram_url, youtube_url,
     primary_color, accent_color, published, custom_domain]
  );
  res.json({ success: true, data: row });
}

// ── Sections ──────────────────────────────────────────────────────────────────
async function getSections(req, res) {
  const { rows } = await db.query(
    `SELECT * FROM website_sections ORDER BY sort_order, id`
  );
  res.json({ success: true, data: rows });
}

async function createSection(req, res) {
  const { type, title, content, image_url, link_url, sort_order, visible = true } = req.body;
  if (!type) throw new AppError('type is required', 400);
  const { rows: [row] } = await db.query(
    `INSERT INTO website_sections (type, title, content, image_url, link_url, sort_order, visible)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [type, title || null, content || null, image_url || null, link_url || null, sort_order || 0, visible]
  );
  res.status(201).json({ success: true, data: row });
}

async function updateSection(req, res) {
  const { type, title, content, image_url, link_url, sort_order, visible } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE website_sections SET
       type       = COALESCE($1, type),
       title      = COALESCE($2, title),
       content    = COALESCE($3, content),
       image_url  = COALESCE($4, image_url),
       link_url   = COALESCE($5, link_url),
       sort_order = COALESCE($6, sort_order),
       visible    = COALESCE($7, visible),
       updated_at = NOW()
     WHERE id = $8 RETURNING *`,
    [type, title, content, image_url, link_url, sort_order, visible, req.params.id]
  );
  if (!row) throw new AppError('Section not found', 404);
  res.json({ success: true, data: row });
}

async function deleteSection(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM website_sections WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Section not found', 404);
  res.json({ success: true, message: 'Section deleted' });
}

// POST /api/website/publish  (admin)
async function togglePublish(req, res) {
  const { published } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE website_config SET published = $1, updated_at = NOW()
     WHERE id = (SELECT id FROM website_config LIMIT 1) RETURNING published`,
    [published]
  );
  res.json({ success: true, data: row });
}

module.exports = {
  getConfig, updateConfig,
  getSections, createSection, updateSection, deleteSection,
  togglePublish,
};
