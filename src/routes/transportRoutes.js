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

router.use(auditMiddleware('transport'));

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
