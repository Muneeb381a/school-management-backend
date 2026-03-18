const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');
const { JWT_SECRET } = require('../middleware/authMiddleware');

const TOKEN_TTL = '7d';

/* ─── POST /api/auth/login ─────────────────────────────────── */
async function login(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = TRUE',
      [username.trim().toLowerCase()]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const payload = {
      id:        user.id,
      username:  user.username,
      name:      user.name,
      role:      user.role,
      entity_id: user.entity_id,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });

    return res.json({ success: true, data: { token, user: payload } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

/* ─── GET /api/auth/me ─────────────────────────────────────── */
async function me(req, res) {
  // req.user is set by verifyToken middleware
  return res.json({ success: true, data: req.user });
}

/* ─── PUT /api/auth/change-password ───────────────────────── */
async function changePassword(req, res) {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ success: false, message: 'Both passwords required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

/* ─── POST /api/auth/setup ─────────────────────────────────── */
// Only works when zero admin users exist — first-run setup protection
async function setup(req, res) {
  const { username, password, name } = req.body;
  if (!username || !password || !name)
    return res.status(400).json({ success: false, message: 'username, password and name are required' });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

  try {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
    );
    if (rows.length > 0)
      return res.status(403).json({ success: false, message: 'Setup already complete. Please login.' });

    const hashed = await bcrypt.hash(password, 10);
    const { rows: created } = await pool.query(
      `INSERT INTO users (username, password, role, name, is_active)
       VALUES ($1, $2, 'admin', $3, TRUE) RETURNING id, username, name, role`,
      [username.trim().toLowerCase(), hashed, name.trim()]
    );

    const payload = { id: created[0].id, username: created[0].username, name: created[0].name, role: 'admin' };
    const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });

    return res.status(201).json({ success: true, data: { token, user: payload }, message: 'Admin account created' });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Username already taken' });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

module.exports = { login, me, changePassword, setup };
