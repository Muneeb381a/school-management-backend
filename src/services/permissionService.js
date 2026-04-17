/**
 * permissionService.js
 * Shared helpers for fetching and checking permissions.
 * Used by: authController (embed in JWT), authMiddleware (checkPermission).
 */

const db = require('../db');

/**
 * Fetch all permission keys for a given role name.
 * Includes role-level permissions + any user-level grants/revokes.
 *
 * @param {string} roleName   - e.g. 'teacher'
 * @param {number} [userId]   - optional, to apply per-user overrides
 * @returns {Promise<string[]>} - e.g. ['students:read', 'attendance:mark']
 */
async function fetchPermissionsForRole(roleName, userId = null) {
  // Admin always gets all permissions — no DB query needed
  if (roleName === 'admin') {
    const { rows } = await db.query(`SELECT key FROM permissions ORDER BY sort_order`);
    return rows.map(r => r.key);
  }

  // Base role permissions
  const { rows: rolePerms } = await db.query(
    `SELECT p.key
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN roles r ON r.id = rp.role_id
     WHERE r.name = $1
     ORDER BY p.sort_order`,
    [roleName]
  );

  const permSet = new Set(rolePerms.map(r => r.key));

  // Apply per-user overrides if userId provided
  if (userId) {
    const { rows: userOverrides } = await db.query(
      `SELECT p.key, up.type
       FROM user_permissions up
       JOIN permissions p ON p.id = up.permission_id
       WHERE up.user_id = $1`,
      [userId]
    );
    for (const { key, type } of userOverrides) {
      if (type === 'grant')  permSet.add(key);
      if (type === 'revoke') permSet.delete(key);
    }
  }

  return [...permSet];
}

/**
 * Check a single permission key against the database directly.
 * Used as DB fallback when JWT permissions are stale.
 *
 * @param {string} roleName
 * @param {string} permKey  - e.g. 'students:create'
 * @param {number} [userId]
 * @returns {Promise<boolean>}
 */
async function hasPermissionInDb(roleName, permKey, userId = null) {
  if (roleName === 'admin') return true;

  const { rows } = await db.query(
    `SELECT 1 FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     JOIN roles r ON r.id = rp.role_id
     WHERE r.name = $1 AND p.key = $2
     LIMIT 1`,
    [roleName, permKey]
  );
  if (rows.length) return true;

  // Check user-level grant override
  if (userId) {
    const { rows: uRows } = await db.query(
      `SELECT up.type FROM user_permissions up
       JOIN permissions p ON p.id = up.permission_id
       WHERE up.user_id = $1 AND p.key = $2
       LIMIT 1`,
      [userId, permKey]
    );
    if (uRows[0]?.type === 'grant') return true;
    if (uRows[0]?.type === 'revoke') return false;
  }

  return false;
}

module.exports = { fetchPermissionsForRole, hasPermissionInDb };
