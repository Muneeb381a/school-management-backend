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

module.exports = { login, me, changePassword };
