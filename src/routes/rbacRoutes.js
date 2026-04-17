const { Router }      = require('express');
const { requireRole } = require('../middleware/authMiddleware');
const {
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
} = require('../controllers/rbacController');

const router = Router();

// All RBAC routes are admin-only (role-based guard stays in place)
router.use(requireRole('admin'));

// ── Permissions (read-only — defined in migration) ────────────────────────────
router.get('/permissions', listPermissions);

// ── Roles ─────────────────────────────────────────────────────────────────────
router.get('/roles',              listRoles);
router.get('/roles/:id',          getRole);
router.post('/roles',             createRole);
router.put('/roles/:id',          updateRole);
router.delete('/roles/:id',       deleteRole);
router.put('/roles/:id/permissions', setRolePermissions);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users',                          listUsers);
router.put('/users/:userId/role',             setUserRole);
router.get('/users/:userId/permissions',      getUserPermissions);
router.put('/users/:userId/permissions',      setUserPermissions);

// ── Summary dashboard ─────────────────────────────────────────────────────────
router.get('/summary', getSummary);

module.exports = router;
