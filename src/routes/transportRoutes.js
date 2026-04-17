const express = require('express');
const router  = express.Router();
const transport = require('../controllers/transportController');
const driver    = require('../controllers/driverController');
const { requireRole }     = require('../middleware/authMiddleware');
const { auditMiddleware } = require('../middleware/auditLog');
const asyncHandler        = require('../utils/asyncHandler');
const { photoUpload }     = require('../middleware/upload');
const db                  = require('../db');

router.use(auditMiddleware('transport'));

// ── Driver self-lookup (used by driver app / tracking page) ──────────────────
router.get('/my-bus-driver', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id, b.bus_number, b.vehicle_number, b.vehicle_type, b.make_model,
            b.driver_name, b.driver_phone, b.status,
            b.current_lat, b.current_lng, b.is_online, b.trip_status,
            d.full_name AS driver_full_name, d.cnic, d.phone AS driver_mobile,
            r.route_name, r.id AS route_id
     FROM buses b
     LEFT JOIN drivers d ON d.id = b.driver_id
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = true
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     WHERE (b.driver_user_id = $1 OR d.user_id = $1) AND b.status = 'active'
     LIMIT 1`,
    [req.user.id]
  );
  res.json({ success: true, data: rows[0] ?? null });
}));

// ── Summary & unassigned students ────────────────────────────────────────────
router.get('/summary',                    requireRole('admin','teacher'), asyncHandler(transport.getSummary));
router.get('/students-without-transport', requireRole('admin','teacher'), asyncHandler(transport.getStudentsWithoutTransport));

// ── Vehicles (Buses) ─────────────────────────────────────────────────────────
router.get   ('/buses',         requireRole('admin','teacher'), asyncHandler(transport.getBuses));
router.post  ('/buses',         requireRole('admin'),           asyncHandler(transport.createBus));
router.get   ('/buses/:id',     requireRole('admin','teacher'), asyncHandler(transport.getBusById));
router.put   ('/buses/:id',     requireRole('admin'),           asyncHandler(transport.updateBus));
router.delete('/buses/:id',     requireRole('admin'),           asyncHandler(transport.deleteBus));

// ── Drivers ───────────────────────────────────────────────────────────────────
router.get   ('/drivers',       requireRole('admin','teacher'), asyncHandler(driver.getDrivers));
router.post  ('/drivers',       requireRole('admin'),           photoUpload.single('photo'), asyncHandler(driver.createDriver));
router.get   ('/drivers/:id',   requireRole('admin','teacher'), asyncHandler(driver.getDriverById));
router.put   ('/drivers/:id',   requireRole('admin'),           photoUpload.single('photo'), asyncHandler(driver.updateDriver));
router.delete('/drivers/:id',   requireRole('admin'),           asyncHandler(driver.deleteDriver));

// ── Routes ────────────────────────────────────────────────────────────────────
router.get   ('/routes',        requireRole('admin','teacher'), asyncHandler(transport.getRoutes));
router.post  ('/routes',        requireRole('admin'),           asyncHandler(transport.createRoute));
router.get   ('/routes/:id',    requireRole('admin','teacher'), asyncHandler(transport.getRouteById));
router.put   ('/routes/:id',    requireRole('admin'),           asyncHandler(transport.updateRoute));
router.delete('/routes/:id',    requireRole('admin'),           asyncHandler(transport.deleteRoute));

// ── Stops ─────────────────────────────────────────────────────────────────────
router.get   ('/routes/:routeId/stops', requireRole('admin','teacher'), asyncHandler(transport.getStops));
router.post  ('/routes/:routeId/stops', requireRole('admin'),           asyncHandler(transport.addStop));
router.put   ('/stops/:id',             requireRole('admin'),           asyncHandler(transport.updateStop));
router.delete('/stops/:id',             requireRole('admin'),           asyncHandler(transport.deleteStop));

// ── Student assignments ───────────────────────────────────────────────────────
router.get   ('/assignments',        requireRole('admin','teacher'), asyncHandler(transport.getAssignments));
router.post  ('/assignments',        requireRole('admin'),           asyncHandler(transport.createAssignment));
router.put   ('/assignments/:id',    requireRole('admin'),           asyncHandler(transport.updateAssignment));
router.delete('/assignments/:id',    requireRole('admin'),           asyncHandler(transport.deleteAssignment));

// Transfer student to a different bus/route
router.post('/assignments/:id/transfer', requireRole('admin'), asyncHandler(transport.transferStudent));

// Transfer history for a student
router.get('/students/:studentId/transfer-history', requireRole('admin','teacher'), asyncHandler(transport.getTransferHistory));

// ── PDF transport slip ────────────────────────────────────────────────────────
router.get('/assignments/:id/pdf', requireRole('admin','teacher'), asyncHandler(transport.generatePdf));

module.exports = router;
