const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const pool    = require('../db');
const AppError  = require('../utils/AppError');
const { logAction } = require('../middleware/auditLog');
const { sendMail }  = require('../utils/mailer');

// ── Secrets (MUST be set in .env — no insecure fallbacks) ────────
const ACCESS_SECRET  = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error(
    'FATAL: JWT_SECRET and JWT_REFRESH_SECRET must both be set in environment variables.'
  );
}

// ── Token config ─────────────────────────────────────────────────
const ACCESS_TTL      = '15m';
const REFRESH_TTL     = '7d';
const REFRESH_TTL_MS  = 7 * 24 * 60 * 60 * 1000;

// ── Account lockout config ────────────────────────────────────────
const MAX_FAIL_ATTEMPTS = 5;
const LOCK_WINDOW_MS    = 15 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL });
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

async function checkLockout(username) {
  const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM login_attempts
     WHERE username = $1 AND success = FALSE AND created_at > $2`,
    [username.toLowerCase(), since]
  );
  if (parseInt(rows[0].cnt, 10) >= MAX_FAIL_ATTEMPTS) {
    throw new AppError(
      'Too many failed login attempts. Account locked for 15 minutes.',
      429, 'ACCOUNT_LOCKED'
    );
  }
}

async function recordAttempt(username, ip, success) {
  await pool.query(
    'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, $3)',
    [username.toLowerCase(), ip, success]
  ).catch(() => {});
}

async function storeRefreshToken(userId, rawToken, ip, userAgent) {
  const hash      = sha256(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hash, expiresAt, ip, userAgent?.slice(0, 250) || null]
  );
}

// ── POST /api/auth/login ──────────────────────────────────────────
async function login(req, res, next) {
  const { username, password } = req.body;
  const ip        = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  try {
    await checkLockout(username);

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = TRUE',
      [username.trim().toLowerCase()]
    );
    const user = rows[0];

    if (!user) {
      await recordAttempt(username, ip, false);
      throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      await recordAttempt(username, ip, false);
      throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
    }

    await recordAttempt(username, ip, true);

    const payload = {
      id:        user.id,
      username:  user.username,
      name:      user.name,
      role:      user.role,
      entity_id: user.entity_id,
    };

    const accessToken  = signAccess(payload);
    const refreshToken = signRefresh({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, ip, userAgent);

    logAction({ userId: user.id, username: user.username, action: 'LOGIN', resource: 'auth', req });

    return res.json({ success: true, data: { accessToken, refreshToken, user: payload } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/refresh ────────────────────────────────────────
async function refresh(req, res, next) {
  const { refreshToken } = req.body;
  if (!refreshToken) return next(new AppError('Refresh token is required.', 400));

  try {
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch {
      throw new AppError('Refresh token is invalid or expired.', 401, 'TOKEN_EXPIRED');
    }

    const hash = sha256(refreshToken);
    const { rows } = await pool.query(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [hash]
    );
    if (!rows[0]) throw new AppError('Refresh token has been revoked.', 401, 'TOKEN_REVOKED');

    // Re-fetch user in case role/status changed since token was issued
    const { rows: userRows } = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND is_active = TRUE',
      [decoded.id]
    );
    if (!userRows[0]) throw new AppError('User not found or deactivated.', 401);

    const user = userRows[0];
    const newAccessToken = signAccess({
      id: user.id, username: user.username, name: user.name,
      role: user.role, entity_id: user.entity_id,
    });

    return res.json({ success: true, data: { accessToken: newAccessToken } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/logout ─────────────────────────────────────────
async function logout(req, res, next) {
  const { refreshToken } = req.body;
  try {
    if (refreshToken) {
      const hash = sha256(refreshToken);
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
        [hash]
      );
    }
    logAction({ userId: req.user?.id, username: req.user?.username, action: 'LOGOUT', resource: 'auth', req });
    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/auth/me ──────────────────────────────────────────────
async function me(req, res) {
  return res.json({ success: true, data: req.user });
}

// ── PUT /api/auth/change-password ─────────────────────────────────
async function changePassword(req, res, next) {
  const { current_password, new_password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) throw new AppError('User not found.', 404);

    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) throw new AppError('Current password is incorrect.', 401, 'WRONG_PASSWORD');

    const hashed = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);

    // Revoke ALL active refresh tokens — forces re-login on all devices
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [req.user.id]
    );

    logAction({
      userId: req.user.id, username: req.user.username,
      action: 'PASSWORD_CHANGE', resource: 'auth', req,
    });

    return res.json({ success: true, message: 'Password changed. Please log in again on all devices.' });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/setup ──────────────────────────────────────────
async function setup(req, res, next) {
  const { username, password, name } = req.body;
  const ip = getClientIp(req);
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (rows.length > 0) throw new AppError('Setup is already complete. Please log in.', 403, 'SETUP_DONE');

    const hashed = await bcrypt.hash(password, 12);
    const { rows: created } = await pool.query(
      `INSERT INTO users (username, password, role, name, is_active)
       VALUES ($1, $2, 'admin', $3, TRUE)
       RETURNING id, username, name, role`,
      [username.trim().toLowerCase(), hashed, name.trim()]
    );

    const payload = {
      id: created[0].id, username: created[0].username,
      name: created[0].name, role: 'admin',
    };

    const accessToken  = signAccess(payload);
    const refreshToken = signRefresh({ id: created[0].id });
    await storeRefreshToken(created[0].id, refreshToken, ip, req.headers['user-agent']);

    logAction({ userId: created[0].id, username: created[0].username, action: 'SETUP', resource: 'auth', req });

    return res.status(201).json({
      success: true,
      data:    { accessToken, refreshToken, user: payload },
      message: 'Admin account created successfully.',
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/auth/sessions ─────────────────────────────────────────
async function getSessions(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, ip_address, user_agent, created_at, expires_at
       FROM refresh_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/auth/sessions/:id ─────────────────────────────────
async function revokeSession(req, res, next) {
  try {
    const { rows } = await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) throw new AppError('Session not found.', 404);
    logAction({ userId: req.user.id, username: req.user.username, action: 'REVOKE_SESSION', resource: 'auth', req });
    return res.json({ success: true, message: 'Session revoked.' });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/forgot-password ────────────────────────────────
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

async function forgotPassword(req, res, next) {
  const { username } = req.body;
  const ip = getClientIp(req);

  // Always respond the same way — prevents username enumeration
  const genericOk = () =>
    res.json({ success: true, message: 'If that username exists, a reset link has been sent to the associated email.' });

  try {
    if (!username?.trim()) return next(new AppError('Username is required.', 400));

    const { rows } = await pool.query(
      'SELECT id, username, name, email FROM users WHERE username = $1 AND is_active = TRUE',
      [username.trim().toLowerCase()]
    );
    if (!rows[0]) return genericOk(); // don't reveal whether user exists

    const user = rows[0];
    if (!user.email) return genericOk(); // no email on file

    // Invalidate any existing unexpired tokens for this user
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [user.id]
    );

    // Generate and store new token
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [user.id, tokenHash, expiresAt, ip]
    );

    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${rawToken}`;

    await sendMail({
      to:      user.email,
      subject: 'Password Reset Request — School Management System',
      html: `
        <p>Hello ${user.name},</p>
        <p>You requested a password reset. Click the link below to set a new password:</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>This link expires in <strong>1 hour</strong>.</p>
        <p>If you did not request this, ignore this email — your password will not change.</p>
      `,
    });

    logAction({ userId: user.id, username: user.username, action: 'PASSWORD_RESET_REQUEST', resource: 'auth', req });

    return genericOk();
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/reset-password ─────────────────────────────────
async function resetPassword(req, res, next) {
  const { token, new_password } = req.body;
  try {
    if (!token || !new_password) throw new AppError('Token and new_password are required.', 400);
    if (new_password.length < 8) throw new AppError('Password must be at least 8 characters.', 400);

    const tokenHash = sha256(token);

    const { rows } = await pool.query(
      `SELECT prt.*, u.id AS uid, u.username, u.name
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = $1
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()`,
      [tokenHash]
    );

    if (!rows[0]) throw new AppError('Password reset link is invalid or has expired.', 400, 'INVALID_RESET_TOKEN');

    const { uid, username, name, id: prtId } = rows[0];

    const hashed = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, uid]);

    // Mark token as used
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [prtId]);

    // Revoke all active refresh tokens — force re-login everywhere
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [uid]
    );

    logAction({ userId: uid, username, action: 'PASSWORD_RESET', resource: 'auth', req });

    return res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login, refresh, logout, me, changePassword, setup,
  getSessions, revokeSession,
  forgotPassword, resetPassword,
};
