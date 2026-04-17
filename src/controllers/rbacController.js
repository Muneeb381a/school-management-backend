/**
 * rbacController.js
 * Full CRUD for roles, permissions, and user-role assignment.
 * All endpoints require admin role.
 */

const db       = require('../db');
const AppError = require('../utils/AppError');

// ── GET /api/rbac/permissions ─────────────────────────────────────────────────
// Returns all permissions grouped by module, with sort_order.
async function listPermissions(req, res) {
  const { rows } = await db.query(
    `SELECT id, module, action, key, label, description, sort_order
     FROM permissions
     ORDER BY sort_order, module, action`
  );

  // Group by module for frontend convenience
  const grouped = {};
  for (const perm of rows) {
    if (!grouped[perm.module]) grouped[perm.module] = [];
    grouped[perm.module].push(perm);
  }

  res.json({ success: true, data: { permissions: rows, grouped } });
}

// ── GET /api/rbac/roles ───────────────────────────────────────────────────────
// Returns all roles with their permission count and permission key array.
async function listRoles(req, res) {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.label, r.description, r.color, r.is_system,
            r.created_at,
            COUNT(rp.permission_id)::INT AS permission_count,
            COALESCE(
              JSON_AGG(p.key ORDER BY p.sort_order) FILTER (WHERE p.key IS NOT NULL),
              '[]'::json
            ) AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     GROUP BY r.id
     ORDER BY r.is_system DESC, r.name`
  );

  res.json({ success: true, data: rows });
}

// ── GET /api/rbac/roles/:id ───────────────────────────────────────────────────
async function getRole(req, res) {
  const { rows: [role] } = await db.query(
    `SELECT r.id, r.name, r.label, r.description, r.color, r.is_system,
            COALESCE(
              JSON_AGG(p.key ORDER BY p.sort_order) FILTER (WHERE p.key IS NOT NULL),
              '[]'::json
            ) AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE r.id = $1
     GROUP BY r.id`,
    [req.params.id]
  );

  if (!role) throw new AppError('Role not found', 404);
  res.json({ success: true, data: role });
}

// ── POST /api/rbac/roles ──────────────────────────────────────────────────────
// Create a custom role with optional initial permissions.
async function createRole(req, res) {
  const { name, label, description, color = '#6366f1', permissions = [] } = req.body;
  if (!name?.trim() || !label?.trim()) throw new AppError('name and label are required', 400);

  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [role] } = await client.query(
      `INSERT INTO roles (name, label, description, color, is_system, created_by)
       VALUES ($1, $2, $3, $4, FALSE, $5)
       RETURNING *`,
      [safeName, label.trim(), description || null, color, req.user.id]
    );

    if (permissions.length) {
      // Resolve permission IDs from keys
      const { rows: permRows } = await client.query(
        `SELECT id FROM permissions WHERE key = ANY($1)`,
        [permissions]
      );
      if (permRows.length) {
        const values = permRows.map(p => `(${role.id}, ${p.id}, ${req.user.id})`).join(',');
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id, granted_by)
           VALUES ${values}
           ON CONFLICT DO NOTHING`
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: role });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new AppError(`Role name "${safeName}" already exists`, 409);
    throw err;
  } finally {
    client.release();
  }
}

// ── PUT /api/rbac/roles/:id ───────────────────────────────────────────────────
// Update role metadata (not permissions — use the permissions endpoint).
async function updateRole(req, res) {
  const { id } = req.params;
  const { label, description, color } = req.body;

  const { rows: [role] } = await db.query(
    `SELECT id, is_system FROM roles WHERE id = $1`, [id]
  );
  if (!role) throw new AppError('Role not found', 404);

  const { rows: [updated] } = await db.query(
    `UPDATE roles SET
       label       = COALESCE($1, label),
       description = COALESCE($2, description),
       color       = COALESCE($3, color)
     WHERE id = $4
     RETURNING *`,
    [label || null, description || null, color || null, id]
  );

  res.json({ success: true, data: updated });
}

// ── DELETE /api/rbac/roles/:id ────────────────────────────────────────────────
async function deleteRole(req, res) {
  const { rows: [role] } = await db.query(
    `SELECT id, is_system, name FROM roles WHERE id = $1`, [req.params.id]
  );
  if (!role) throw new AppError('Role not found', 404);
  if (role.is_system) throw new AppError('System roles cannot be deleted', 400);

  // Check if any users have this role
  const { rows: users } = await db.query(
    `SELECT COUNT(*) AS cnt FROM users WHERE role = $1`, [role.name]
  );
  if (parseInt(users[0]?.cnt) > 0) {
    throw new AppError(
      'Cannot delete role — users are currently assigned to it. Reassign them first.',
      400
    );
  }

  await db.query(`DELETE FROM roles WHERE id = $1`, [req.params.id]);
  res.json({ success: true, message: 'Role deleted successfully' });
}

// ── PUT /api/rbac/roles/:id/permissions ───────────────────────────────────────
// Replace ALL permissions for a role (full replace, not partial).
async function setRolePermissions(req, res) {
  const { id } = req.params;
  const { permissions } = req.body; // array of permission keys: ['students:read', ...]

  if (!Array.isArray(permissions)) throw new AppError('permissions must be an array', 400);

  const { rows: [role] } = await db.query(
    `SELECT id, name, is_system FROM roles WHERE id = $1`, [id]
  );
  if (!role) throw new AppError('Role not found', 404);
  if (role.name === 'admin') throw new AppError('Admin permissions cannot be modified', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Remove all existing permissions for this role
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);

    // Re-insert new set
    if (permissions.length) {
      const { rows: permRows } = await client.query(
        `SELECT id, key FROM permissions WHERE key = ANY($1)`,
        [permissions]
      );

      if (permRows.length) {
        const values = permRows
          .map(p => `(${id}, ${p.id}, ${req.user.id})`)
          .join(',');
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id, granted_by)
           VALUES ${values}
           ON CONFLICT DO NOTHING`
        );
      }
    }

    await client.query('COMMIT');

    // Return updated role with permissions
    const { rows: [updated] } = await db.query(
      `SELECT r.id, r.name, r.label, r.color,
              COALESCE(
                JSON_AGG(p.key ORDER BY p.sort_order) FILTER (WHERE p.key IS NOT NULL),
                '[]'::json
              ) AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE r.id = $1
       GROUP BY r.id`,
      [id]
    );

    res.json({ success: true, data: updated, message: 'Permissions updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── GET /api/rbac/users ───────────────────────────────────────────────────────
// List all users with their current role and permission count.
async function listUsers(req, res) {
  const { role: filterRole, search, limit = 50, offset = 0 } = req.query;

  const conditions = ['u.is_active = TRUE'];
  const params = [];

  if (filterRole) {
    params.push(filterRole);
    conditions.push(`u.role = $${params.length}`);
  }
  if (search?.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(u.name ILIKE $${params.length} OR u.username ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(+limit, +offset);

  const { rows } = await db.query(
    `SELECT u.id, u.username, u.name, u.role, u.entity_id, u.created_at,
            r.label AS role_label, r.color AS role_color,
            COUNT(rp.permission_id)::INT AS permission_count
     FROM users u
     LEFT JOIN roles r ON r.name = u.role
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     ${where}
     GROUP BY u.id, r.label, r.color
     ORDER BY u.name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const { rows: [{ total }] } = await db.query(
    `SELECT COUNT(*)::INT AS total FROM users u ${where}`,
    params.slice(0, -2)
  );

  res.json({ success: true, data: rows, total });
}

// ── PUT /api/rbac/users/:userId/role ─────────────────────────────────────────
// Change a user's role (admin cannot change their own role to non-admin).
async function setUserRole(req, res) {
  const { userId } = req.params;
  const { role } = req.body;
  if (!role) throw new AppError('role is required', 400);

  // Prevent admin from removing their own admin status
  if (+userId === req.user.id && role !== 'admin') {
    throw new AppError('You cannot remove your own admin role', 400);
  }

  // Validate role exists
  const { rows: [roleRow] } = await db.query(
    `SELECT id FROM roles WHERE name = $1`, [role]
  );
  if (!roleRow) throw new AppError(`Role "${role}" does not exist`, 400);

  const { rows: [user] } = await db.query(
    `UPDATE users SET role = $1 WHERE id = $2 AND is_active = TRUE RETURNING id, name, role`,
    [role, userId]
  );
  if (!user) throw new AppError('User not found', 404);

  res.json({ success: true, data: user, message: `Role updated to "${role}"` });
}

// ── GET /api/rbac/users/:userId/permissions ───────────────────────────────────
// Get effective permissions for a specific user (role perms + overrides).
async function getUserPermissions(req, res) {
  const { userId } = req.params;

  const { rows: [user] } = await db.query(
    `SELECT id, name, role FROM users WHERE id = $1`, [userId]
  );
  if (!user) throw new AppError('User not found', 404);

  // Role-level permissions
  const { rows: rolePerms } = await db.query(
    `SELECT p.key, p.label, p.module, p.action, 'role' AS source
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN roles r ON r.id = rp.role_id
     WHERE r.name = $1
     ORDER BY p.sort_order`,
    [user.role]
  );

  // Per-user overrides
  const { rows: userOverrides } = await db.query(
    `SELECT p.key, p.label, up.type AS override_type
     FROM user_permissions up
     JOIN permissions p ON p.id = up.permission_id
     WHERE up.user_id = $1`,
    [userId]
  );

  const overrideMap = Object.fromEntries(userOverrides.map(o => [o.key, o.override_type]));
  const effective = rolePerms
    .filter(p => overrideMap[p.key] !== 'revoke')
    .map(p => ({ ...p, source: overrideMap[p.key] === 'grant' ? 'user_grant' : 'role' }));

  // Add user-granted perms not in role
  for (const o of userOverrides.filter(o => o.override_type === 'grant')) {
    if (!effective.find(p => p.key === o.key)) {
      effective.push({ key: o.key, label: o.label, source: 'user_grant' });
    }
  }

  res.json({ success: true, data: { user, permissions: effective, overrides: userOverrides } });
}

// ── PUT /api/rbac/users/:userId/permissions ───────────────────────────────────
// Set per-user permission overrides.
async function setUserPermissions(req, res) {
  const { userId } = req.params;
  const { grants = [], revokes = [] } = req.body;

  const { rows: [user] } = await db.query(
    `SELECT id FROM users WHERE id = $1`, [userId]
  );
  if (!user) throw new AppError('User not found', 404);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Clear existing overrides
    await client.query(`DELETE FROM user_permissions WHERE user_id = $1`, [userId]);

    const allKeys = [...new Set([...grants, ...revokes])];
    if (allKeys.length) {
      const { rows: permRows } = await client.query(
        `SELECT id, key FROM permissions WHERE key = ANY($1)`, [allKeys]
      );

      const permMap = Object.fromEntries(permRows.map(p => [p.key, p.id]));

      const values = [
        ...grants.filter(k => permMap[k]).map(k => `(${userId}, ${permMap[k]}, 'grant', ${req.user.id})`),
        ...revokes.filter(k => permMap[k]).map(k => `(${userId}, ${permMap[k]}, 'revoke', ${req.user.id})`),
      ];

      if (values.length) {
        await client.query(
          `INSERT INTO user_permissions (user_id, permission_id, type, granted_by)
           VALUES ${values.join(',')}
           ON CONFLICT (user_id, permission_id) DO UPDATE SET type = EXCLUDED.type`
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'User permissions updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── GET /api/rbac/summary ─────────────────────────────────────────────────────
async function getSummary(req, res) {
  const { rows } = await db.query(
    `SELECT r.name, r.label, r.color, r.is_system,
            COUNT(DISTINCT u.id)::INT   AS user_count,
            COUNT(DISTINCT rp.permission_id)::INT AS perm_count
     FROM roles r
     LEFT JOIN users u ON u.role = r.name AND u.is_active = TRUE
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id
     ORDER BY r.is_system DESC, r.name`
  );
  res.json({ success: true, data: rows });
}

module.exports = {
  listPermissions,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  setRolePermissions,
  listUsers,
  setUserRole,
  getUserPermissions,
  setUserPermissions,
  getSummary,
};
