const router = require('express').Router();
const ctrl   = require('../controllers/trackingController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');

// Inject the Socket.IO instance into req so controllers can broadcast
router.use((req, res, next) => {
  req.io = req.app.get('io');
  next();
});

router.use(verifyToken);

// ── Admin / summary ───────────────────────────────────────────────────────────
router.get('/summary',           requireRole('admin', 'teacher'), asyncHandler(ctrl.getTrackingSummary));
router.get('/all-buses',         requireRole('admin', 'teacher'), asyncHandler(ctrl.getAllBusesLive));

// ── Parent ────────────────────────────────────────────────────────────────────
router.get('/my-bus',            asyncHandler(ctrl.getMyBus));

// ── Bus live state ────────────────────────────────────────────────────────────
router.get('/live/:busId',       asyncHandler(ctrl.getLiveBus));
router.get('/route-stops/:busId',asyncHandler(ctrl.getRouteStops));

// ── Driver REST fallback (when socket is disconnected) ────────────────────────
router.post('/location',         requireRole('admin', 'teacher'), asyncHandler(ctrl.postLocationFallback));
router.post('/start-trip',       requireRole('admin', 'teacher'), asyncHandler(ctrl.startTrip));
router.post('/end-trip',         requireRole('admin', 'teacher'), asyncHandler(ctrl.endTrip));
router.post('/event',            requireRole('admin', 'teacher'), asyncHandler(ctrl.logTripEvent));
router.post('/emergency',        asyncHandler(ctrl.reportEmergency)); // any role (driver)

// ── History ───────────────────────────────────────────────────────────────────
router.get('/history/:busId',    requireRole('admin', 'teacher'), asyncHandler(ctrl.getLocationHistory));
router.get('/trips/:busId',      requireRole('admin', 'teacher'), asyncHandler(ctrl.getTripHistory));
router.get('/events/:tripId',    requireRole('admin', 'teacher'), asyncHandler(ctrl.getTripEvents));

module.exports = router;
