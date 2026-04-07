const express = require('express');
const router  = express.Router();
const {
  getBuses, getBusById, createBus, updateBus, deleteBus,
  getRoutes, getRouteById, createRoute, updateRoute, deleteRoute,
  getStops, addStop, updateStop, deleteStop,
  getAssignments, createAssignment, updateAssignment, deleteAssignment,
  getSummary, getStudentsWithoutTransport,
} = require('../controllers/transportController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const asyncHandler        = require('../utils/asyncHandler');
const db                  = require('../db');

router.use(auditMiddleware('transport'));

// Driver: returns the bus assigned to the logged-in driver (by driver_user_id)
router.get('/my-bus-driver', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id, b.bus_number, b.vehicle_number, b.make_model,
            b.driver_name, b.driver_phone, b.status,
            b.current_lat, b.current_lng, b.is_online, b.trip_status,
            r.route_name, r.id AS route_id
     FROM buses b
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = true
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     WHERE b.driver_user_id = $1 AND b.status = 'active'
     LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: 'No active bus assigned to this driver' });
  }
  res.json({ success: true, data: rows[0] });
}));

// Summary
router.get('/summary',                    requireRole('admin', 'teacher'), getSummary);
router.get('/students-without-transport', requireRole('admin', 'teacher'), getStudentsWithoutTransport);

// Buses
router.get('/buses',        requireRole('admin', 'teacher'), getBuses);
router.post('/buses',       requireRole('admin'),            createBus);
router.get('/buses/:id',    requireRole('admin', 'teacher'), getBusById);
router.put('/buses/:id',    requireRole('admin'),            updateBus);
router.delete('/buses/:id', requireRole('admin'),            deleteBus);

// Routes
router.get('/routes',           requireRole('admin', 'teacher'), getRoutes);
router.post('/routes',          requireRole('admin'),            createRoute);
router.get('/routes/:id',       requireRole('admin', 'teacher'), getRouteById);
router.put('/routes/:id',       requireRole('admin'),            updateRoute);
router.delete('/routes/:id',    requireRole('admin'),            deleteRoute);

// Stops
router.get('/routes/:routeId/stops',  requireRole('admin', 'teacher'), getStops);
router.post('/routes/:routeId/stops', requireRole('admin'),            addStop);
router.put('/stops/:id',              requireRole('admin'),            updateStop);
router.delete('/stops/:id',           requireRole('admin'),            deleteStop);

// Assignments
router.get('/assignments',      requireRole('admin', 'teacher'), getAssignments);
router.post('/assignments',     requireRole('admin'),            createAssignment);
router.put('/assignments/:id',  requireRole('admin'),            updateAssignment);
router.delete('/assignments/:id', requireRole('admin'),          deleteAssignment);

module.exports = router;
