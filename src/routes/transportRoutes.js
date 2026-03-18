const express = require('express');
const router  = express.Router();

const {
  getBuses, getBusById, createBus, updateBus, deleteBus,
  getRoutes, getRouteById, createRoute, updateRoute, deleteRoute,
  getStops, addStop, updateStop, deleteStop,
  getAssignments, createAssignment, updateAssignment, deleteAssignment,
  getSummary, getStudentsWithoutTransport,
} = require('../controllers/transportController');

// ── Dashboard summary (static — before any /:id) ────────────
router.get('/summary',                      getSummary);
router.get('/students-without-transport',   getStudentsWithoutTransport);

// ── Buses ────────────────────────────────────────────────────
router.get   ('/buses',       getBuses);
router.post  ('/buses',       createBus);
router.get   ('/buses/:id',   getBusById);
router.put   ('/buses/:id',   updateBus);
router.delete('/buses/:id',   deleteBus);

// ── Routes ───────────────────────────────────────────────────
router.get   ('/routes',          getRoutes);
router.post  ('/routes',          createRoute);
router.get   ('/routes/:id',      getRouteById);
router.put   ('/routes/:id',      updateRoute);
router.delete('/routes/:id',      deleteRoute);

// ── Route stops (nested under routes) ────────────────────────
router.get   ('/routes/:routeId/stops',  getStops);
router.post  ('/routes/:routeId/stops',  addStop);

// ── Individual stop update/delete (not nested) ───────────────
router.put   ('/stops/:id',   updateStop);
router.delete('/stops/:id',   deleteStop);

// ── Student transport assignments ─────────────────────────────
router.get   ('/assignments',      getAssignments);
router.post  ('/assignments',      createAssignment);
router.put   ('/assignments/:id',  updateAssignment);
router.delete('/assignments/:id',  deleteAssignment);

module.exports = router;
