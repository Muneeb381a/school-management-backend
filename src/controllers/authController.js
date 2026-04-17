const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const AppError  = require('../utils/AppError');
const { logAction } = require('../middleware/auditLog');
const { sendMail }  = require('../utils/mailer');
const { fetchPermissionsForRole } = require('../services/permissionService');

// ── Secrets ───────────────────────────────────────────────────────────────────
const ACCESS_SECRET  = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET must both be set in environment variables.');
}

// ── Token config ──────────────────────────────────────────────────────────────
const ACCESS_TTL     = '15m';
const REFRESH_TTL    = '7d';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Account lockout ───────────────────────────────────────────────────────────
const MAX_FAIL_ATTEMPTS = 5;
const LOCK_WINDOW_MS    = 15 * 60 * 1000;

// Dummy hash — constant-time compare when user doesn't exist (prevents username enumeration)
const DUMMY_HASH = '$2a$10$E3p.jnEe8ZWWbHaxKFciou7PXEUmcOPQ0SjCvzkzZnp5z5QZF7.ki';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Look up a school by code in the PUBLIC schema.
 * Returns { schema, school_name, school_code } or throws.
 * Uses db.raw so it's never affected by AsyncLocalStorage (login runs before JWT).
 */
async function resolveSchoolByCode(code) {
  const { rows: [school] } = await db.raw.query(
    `SELECT name, slug, school_code, status
     FROM public.schools
     WHERE school_code = $1`,
    [code.toUpperCase().trim()]
  );

  if (!school) {
    throw new AppError(
      'Invalid school code. Please check with your administrator.',
      401, 'INVALID_SCHOOL'
    );
  }
  if (school.status !== 'active') {
    throw new AppError(
      'School account is inactive. Please contact support.',
      403, 'SCHOOL_INACTIVE'
    );
  }

  return {
    schema:      `school_${school.slug}`,
    school_name: school.name,
    school_code: school.school_code,
  };
}

/**
 * Run login-scoped DB queries inside the correct tenant schema.
 * We use a raw client (not pool.query) because at login time no JWT exists yet —
 * AsyncLocalStorage is empty. We manually SET search_path on the client.
 */
async function withSchema(schema, fn) {
  const client = await db.raw.connect();
  try {
    if (schema) {
      await client.query(`SET search_path TO "${schema}", public`);
    }
    return await fn(client);
  } finally {
    client.release();
  }
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
//
// Multi-tenant:    { school_code, username, password }
// Single-tenant:   { username, password }            (backward-compatible)
//
async function login(req, res, next) {
  const { username, password, school_code } = req.body;
  const ip        = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  try {
    // ── 1. Resolve tenant schema ─────────────────────────────────────────────
    let tenantInfo = null; // { schema, school_name, school_code }

    if (school_code?.trim()) {
      tenantInfo = await resolveSchoolByCode(school_code.trim());
    }
    // If no school_code: run in public schema (legacy single-tenant mode)

    const schema = tenantInfo?.schema ?? null;

    // ── 1b. Super-admin check — only when no school_code provided ────────────
    // Super admins live in public.super_admins, not in any tenant users table.
    if (!school_code?.trim()) {
      const { rows: [sa] } = await db.raw.query(
        `SELECT id, username, password, email FROM public.super_admins WHERE username = $1`,
        [username.trim().toLowerCase()]
      );
      if (sa) {
        const valid = await bcrypt.compare(password, sa.password);
        if (!valid) {
          throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
        }
        const payload = {
          id:             sa.id,
          username:       sa.username,
          name:           'Super Admin',
          role:           'admin',
          is_super_admin: true,
          entity_id:      null,
          mustChangePassword: false,
        };
        const accessToken  = signAccess(payload);
        const refreshToken = signRefresh({ id: sa.id, schema: null });
        return res.json({
          success: true,
          data: { accessToken, refreshToken, user: payload, mustChangePassword: false },
        });
      }
    }

    // ── 2. Run the rest of login inside the correct schema ───────────────────
    const result = await withSchema(schema, async (client) => {

      // Lockout check (login_attempts lives in the tenant schema)
      const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
      const { rows: lockRows } = await client.query(
        `SELECT COUNT(*) AS cnt FROM login_attempts
         WHERE username = $1 AND success = FALSE AND created_at > $2`,
        [username.toLowerCase(), since]
      );
      if (parseInt(lockRows[0].cnt, 10) >= MAX_FAIL_ATTEMPTS) {
        throw new AppError(
          'Too many failed login attempts. Account locked for 15 minutes.',
          429, 'ACCOUNT_LOCKED'
        );
      }

      // Fetch user
      const { rows } = await client.query(
        `SELECT id, username, password, name, role, entity_id, email,
                is_active, must_change_password
         FROM users
         WHERE username = $1 AND is_active = TRUE`,
        [username.trim().toLowerCase()]
      );
      const user = rows[0];

      // Constant-time compare — always runs bcrypt even if user missing
      const valid = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);

      // Record attempt
      await client.query(
        'INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, $3)',
        [username.toLowerCase(), ip, !!(user && valid)]
      ).catch(() => {});

      if (!user || !valid) {
        throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
      }

      // Update last login
      await client.query(
        'UPDATE users SET last_login_at = NOW() WHERE id = $1',
        [user.id]
      );

      return user;
    });

    // ── 3. Build JWT payload ─────────────────────────────────────────────────
    //
    // `schema` in the JWT is the key that drives ALL subsequent requests.
    // Every authenticated API call: authMiddleware reads this field and calls
    // db.schemaStore.run(schema, next) — making every pool.query target this school.
    //
    // Fetch permissions for this role (embedded in JWT for fast permission checks)
    // Wrapped in try/catch — if the permissions table hasn't been migrated yet,
    // login must still succeed. Permissions will default to [].
    const permissions = await withSchema(schema, async (client) => {
      const { rows } = await client.query(
        `SELECT p.key
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
         WHERE r.name = $1
         ORDER BY p.sort_order`,
        [result.role]
      );
      return rows.map(r => r.key);
    }).catch(() => []);

    const payload = {
      id:                 result.id,
      username:           result.username,
      name:               result.name,
      role:               result.role,
      entity_id:          result.entity_id,
      mustChangePassword: result.must_change_password || false,
      permissions,          // ← RBAC: array of 'module:action' keys
      // Multi-tenant fields — undefined in single-tenant mode (cleaner than null)
      ...(tenantInfo && {
        schema:      tenantInfo.schema,
        school_name: tenantInfo.school_name,
        school_code: tenantInfo.school_code,
      }),
    };

    const accessToken  = signAccess(payload);
    const refreshToken = signRefresh({ id: result.id, schema: tenantInfo?.schema ?? null });

    // Store refresh token in the correct schema
    await withSchema(schema, async (client) => {
      const hash      = sha256(refreshToken);
      const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [result.id, hash, expiresAt, ip, userAgent?.slice(0, 250) || null]
      );
    });

    logAction({ userId: result.id, username: result.username, action: 'LOGIN', resource: 'auth', req });

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user:               payload,
        mustChangePassword: result.must_change_password || false,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
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

    // Validate token in the correct schema
    const schema = decoded.schema ?? null;
    const user   = await withSchema(schema, async (client) => {
      const hash = sha256(refreshToken);
      const { rows } = await client.query(
        `SELECT * FROM refresh_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [hash]
      );
      if (!rows[0]) throw new AppError('Refresh token has been revoked.', 401, 'TOKEN_REVOKED');

      // Re-fetch user in case role/status changed
      const { rows: userRows } = await client.query(
        'SELECT * FROM users WHERE id = $1 AND is_active = TRUE',
        [decoded.id]
      );
      if (!userRows[0]) throw new AppError('User not found or deactivated.', 401);
      return userRows[0];
    });

    // Re-build access token — re-embed schema if it was in the refresh token
    let schoolInfo = {};
    if (schema) {
      // Re-fetch school name for the payload
      const { rows: [school] } = await db.raw.query(
        `SELECT name, school_code FROM public.schools WHERE slug = $1`,
        [schema.replace('school_', '')]
      );
      if (school) {
        schoolInfo = { schema, school_name: school.name, school_code: school.school_code };
      }
    }

    // Re-fetch permissions on refresh so tokens always carry fresh permissions
    const freshPermissions = await fetchPermissionsForRole(user.role, user.id).catch(() => []);

    const newAccessToken = signAccess({
      id:                 user.id,
      username:           user.username,
      name:               user.name,
      role:               user.role,
      entity_id:          user.entity_id,
      mustChangePassword: user.must_change_password || false,  // ← must be re-embedded every refresh
      permissions:        freshPermissions,
      ...schoolInfo,
    });

    return res.json({ success: true, data: { accessToken: newAccessToken } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
async function logout(req, res, next) {
  const { refreshToken } = req.body;
  try {
    if (refreshToken) {
      // Use pool.query — schema is already set in AsyncLocalStorage (user is authenticated)
      const hash = sha256(refreshToken);
      await db.query(
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

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
async function me(req, res) {
  return res.json({ success: true, data: req.user });
}

// ── PUT /api/auth/change-password ─────────────────────────────────────────────
async function changePassword(req, res, next) {
  const { current_password, new_password } = req.body;
  try {
    // db.query uses the schema from AsyncLocalStorage (set by authMiddleware)
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) throw new AppError('User not found.', 404);

    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) throw new AppError('Current password is incorrect.', 401, 'WRONG_PASSWORD');

    // Reject same-as-current password (validator checks length/strength; controller adds this)
    const sameAsCurrent = await bcrypt.compare(new_password, user.password);
    if (sameAsCurrent) {
      throw new AppError('New password must be different from your current password.', 400);
    }

    // Belt-and-suspenders strength check (validator middleware also enforces these)
    if (new_password.length < 8) throw new AppError('Password must be at least 8 characters.', 400);
    if (!/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
      throw new AppError('Password must contain at least one uppercase letter and one number.', 400);
    }

    const hashed = await bcrypt.hash(new_password, 12);
    await db.query(
      'UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2',
      [hashed, req.user.id]
    );

    // Revoke all active refresh tokens — force re-login on all devices
    await db.query(
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

// ── POST /api/auth/setup ──────────────────────────────────────────────────────
// Only available in single-tenant mode (no school_code) — initial admin creation.
async function setup(req, res, next) {
  const { username, password, name } = req.body;
  const ip = getClientIp(req);
  try {
    const { rows } = await db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (rows.length > 0) throw new AppError('Setup is already complete. Please log in.', 403, 'SETUP_DONE');

    const hashed = await bcrypt.hash(password, 12);
    const { rows: created } = await db.query(
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

    const hash      = sha256(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [created[0].id, hash, expiresAt, ip, req.headers['user-agent']?.slice(0, 250) || null]
    );

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

// ── GET /api/auth/sessions ────────────────────────────────────────────────────
async function getSessions(req, res, next) {
  try {
    const { rows } = await db.query(
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

// ── DELETE /api/auth/sessions/:id ─────────────────────────────────────────────
async function revokeSession(req, res, next) {
  try {
    const { rows } = await db.query(
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

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
const RESET_TTL_MS = 60 * 60 * 1000;

async function forgotPassword(req, res, next) {
  const { username, school_code } = req.body;
  const ip = getClientIp(req);

  const genericOk = () =>
    res.json({ success: true, message: 'If that username exists, a reset link has been sent to the associated email.' });

  try {
    if (!username?.trim()) return next(new AppError('Username is required.', 400));

    // Resolve schema same as login
    let schema = null;
    if (school_code?.trim()) {
      try {
        const info = await resolveSchoolByCode(school_code.trim());
        schema = info.schema;
      } catch { return genericOk(); }
    }

    const user = await withSchema(schema, async (client) => {
      const { rows } = await client.query(
        'SELECT id, username, name, email FROM users WHERE username = $1 AND is_active = TRUE',
        [username.trim().toLowerCase()]
      );
      return rows[0] || null;
    });

    if (!user || !user.email) return genericOk();

    await withSchema(schema, async (client) => {
      // Invalidate existing tokens
      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [user.id]
      );

      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = sha256(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TTL_MS);

      await client.query(
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
          <p>You requested a password reset. Click the link below:</p>
          <p><a href="${resetLink}">${resetLink}</a></p>
          <p>This link expires in <strong>1 hour</strong>.</p>
          <p>If you did not request this, ignore this email.</p>
        `,
      });
    });

    logAction({ userId: user.id, username: user.username, action: 'PASSWORD_RESET_REQUEST', resource: 'auth', req });
    return genericOk();
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
async function resetPassword(req, res, next) {
  const { token, new_password, school_code } = req.body;
  try {
    if (!token || !new_password) throw new AppError('Token and new_password are required.', 400);
    if (new_password.length < 8) throw new AppError('Password must be at least 8 characters.', 400);

    let schema = null;
    if (school_code?.trim()) {
      try {
        const info = await resolveSchoolByCode(school_code.trim());
        schema = info.schema;
      } catch { /* fall through to token lookup failure */ }
    }

    const tokenHash = sha256(token);

    const record = await withSchema(schema, async (client) => {
      const { rows } = await client.query(
        `SELECT prt.*, u.id AS uid, u.username
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
         WHERE prt.token_hash = $1
           AND prt.used_at IS NULL
           AND prt.expires_at > NOW()`,
        [tokenHash]
      );
      return rows[0] || null;
    });

    if (!record) {
      throw new AppError('Password reset link is invalid or has expired.', 400, 'INVALID_RESET_TOKEN');
    }

    const { uid, username, id: prtId } = record;

    await withSchema(schema, async (client) => {
      const hashed = await bcrypt.hash(new_password, 12);
      await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, uid]);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [prtId]);
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [uid]
      );
    });

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
