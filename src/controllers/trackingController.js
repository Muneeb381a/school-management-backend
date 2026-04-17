/**
 * trackingController.js
 * REST API handlers for vehicle tracking.
 * These complement the Socket.IO real-time layer.
 * Used by:
 *  - Driver app as FALLBACK when socket disconnects (poor internet)
 *  - Parent app to get initial state on page load
 *  - Admin dashboard for historical data
 */

const db = require('../db');
const AppError = require('../utils/AppError');
const {
  shouldAcceptLocation,
  buildLocationPayload,
  isOverspeed,
  isDeviatingFromRoute,
  calcEtaMinutes,
  SPEED_LIMIT_KMH,
} = require('../services/trackingService');
const { getSocketService } = require('../services/socketService');

// ── GET /api/tracking/live/:busId ─────────────────────────────────────────────
// Returns the current live state of a bus (last location + trip info).
async function getLiveBus(req, res) {
  const { busId } = req.params;

  // Try in-memory cache first (fastest path)
  const { busStateCache } = getSocketService();
  const cached = busStateCache.get(+busId);

  const { rows: [bus] } = await db.query(
    `SELECT b.id, b.bus_number, b.vehicle_number, b.make_model, b.status,
            b.driver_name, b.driver_phone, b.gps_device_id,
            b.current_lat, b.current_lng, b.current_speed,
            b.last_seen, b.is_online, b.trip_status, b.driver_user_id,
            u.name AS driver_user_name,
            ts.id  AS trip_id, ts.trip_type, ts.started_at, ts.route_id
     FROM buses b
     LEFT JOIN users u ON u.id = b.driver_user_id
     LEFT JOIN trip_sessions ts ON ts.bus_id = b.id AND ts.status = 'active'
     WHERE b.id = $1`, [busId]
  );

  if (!bus) throw new AppError('Bus not found', 404);

  // Last 10 locations for breadcrumb trail
  const { rows: breadcrumb } = await db.query(
    `SELECT lat, lng, speed, heading, recorded_at
     FROM vehicle_locations WHERE bus_id = $1
     ORDER BY recorded_at DESC LIMIT 10`, [busId]
  );

  res.json({
    success: true,
    data: {
      bus,
      liveLocation: cached || (bus.current_lat ? {
        lat: +bus.current_lat, lng: +bus.current_lng,
        speed: +bus.current_speed, ts: bus.last_seen,
      } : null),
      breadcrumb: breadcrumb.reverse(),
    },
  });
}

// ── GET /api/tracking/all-buses ───────────────────────────────────────────────
// Admin: overview of all buses with their current live state.
async function getAllBusesLive(req, res) {
  const { rows } = await db.query(
    `SELECT b.id, b.bus_number, b.vehicle_number, b.vehicle_type, b.capacity, b.status,
            b.current_lat, b.current_lng, b.current_speed,
            b.last_seen, b.is_online, b.trip_status,
            COALESCE(d.full_name, b.driver_name)   AS driver_name,
            COALESCE(d.phone,     b.driver_phone)  AS driver_phone,
            d.photo_url AS driver_photo,
            b.driver_user_id,
            r.route_name, r.id AS route_id,
            COUNT(st.id)::INT AS passenger_count
     FROM buses b
     LEFT JOIN drivers d ON d.id = b.driver_id
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = true
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     LEFT JOIN student_transport st ON st.bus_id = b.id AND st.status = 'active'
     WHERE b.status = 'active'
     GROUP BY b.id, d.full_name, b.driver_name, d.phone, b.driver_phone, d.photo_url, r.route_name, r.id
     ORDER BY b.is_online DESC, b.bus_number`
  );

  const { busStateCache } = getSocketService();
  const buses = rows.map(b => ({
    ...b,
    liveLocation: busStateCache.get(b.id) || null,
  }));

  res.json({ success: true, data: buses });
}

// ── GET /api/tracking/my-bus ──────────────────────────────────────────────────
// Parent: returns the bus assigned to their child.
async function getMyBus(req, res) {
  const userId = req.user.id;

  const { rows } = await db.query(
    `SELECT b.id AS bus_id, b.bus_number, b.vehicle_number,
            b.driver_name, b.driver_phone,
            b.current_lat, b.current_lng, b.current_speed,
            b.last_seen, b.is_online, b.trip_status,
            r.route_name, r.id AS route_id,
            s.name AS student_name, st.transport_type,
            rs.stop_name, rs.latitude AS stop_lat, rs.longitude AS stop_lng,
            rs.pickup_time, rs.dropoff_time
     FROM student_transport st
     JOIN students s       ON s.id = st.student_id
     JOIN buses b          ON b.id = st.bus_id
     JOIN transport_routes r ON r.id = st.route_id
     LEFT JOIN route_stops rs ON rs.id = st.stop_id
     WHERE s.parent_user_id = $1 AND st.status = 'active'
     LIMIT 5`, [userId]
  );

  if (!rows.length) throw new AppError('No active transport assignment found for your child', 404);

  const { busStateCache } = getSocketService();
  const enriched = rows.map(r => ({
    ...r,
    liveLocation: busStateCache.get(r.bus_id) || null,
  }));

  res.json({ success: true, data: enriched });
}

// ── GET /api/tracking/route-stops/:busId ─────────────────────────────────────
// Returns all stops for a bus's current route (for map rendering).
async function getRouteStops(req, res) {
  const { busId } = req.params;
  const { rows } = await db.query(
    `SELECT rs.id, rs.stop_name, rs.stop_order, rs.pickup_time, rs.dropoff_time,
            rs.latitude, rs.longitude, rs.landmark,
            r.route_name, r.start_point, r.end_point
     FROM route_stops rs
     JOIN bus_route_assignments bra ON bra.route_id = rs.route_id
     JOIN transport_routes r ON r.id = bra.route_id
     WHERE bra.bus_id = $1 AND bra.is_active = true
     ORDER BY rs.stop_order`, [busId]
  );
  res.json({ success: true, data: rows });
}

// ── POST /api/tracking/location ───────────────────────────────────────────────
// REST FALLBACK: Driver sends location when socket is not connected.
// Accepts same payload as socket 'location:update'.
async function postLocationFallback(req, res) {
  const { busId, tripId, lat, lng, speed, heading, accuracy } = req.body;
  if (!busId || !lat || !lng) throw new AppError('busId, lat, lng required', 400);

  if (!shouldAcceptLocation(busId)) {
    return res.json({ success: true, throttled: true });
  }

  const payload = buildLocationPayload({ busId: +busId, tripId, lat: +lat, lng: +lng, speed, heading, accuracy });

  // Write to DB (single insert — no batching for REST)
  await db.query(
    `INSERT INTO vehicle_locations (bus_id, trip_id, lat, lng, speed, heading, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [payload.busId, payload.tripId || null, payload.lat, payload.lng,
     payload.speed, payload.heading, new Date(payload.ts)]
  );

  await db.query(
    `UPDATE buses SET current_lat=$1, current_lng=$2, current_speed=$3, last_seen=NOW()
     WHERE id=$4`,
    [payload.lat, payload.lng, payload.speed, payload.busId]
  );

  // Broadcast via Socket.IO if available
  if (req.io) {
    req.io.to(`bus:${busId}`).emit('location:update', payload);
  }

  // Overspeed check
  if (isOverspeed(payload.speed)) {
    if (req.io) {
      req.io.to('admin:tracking').emit('alert:overspeed', {
        busId, speed: payload.speed, lat: payload.lat, lng: payload.lng, ts: payload.ts,
      });
    }
  }

  res.json({ success: true, data: payload });
}

// ── POST /api/tracking/start-trip ────────────────────────────────────────────
async function startTrip(req, res) {
  const { busId, tripType = 'morning', lat, lng } = req.body;
  if (!busId) throw new AppError('busId required', 400);

  const { rows: [assignment] } = await db.query(
    `SELECT route_id FROM bus_route_assignments WHERE bus_id = $1 AND is_active = true LIMIT 1`, [busId]
  );

  const { rows: [trip] } = await db.query(
    `INSERT INTO trip_sessions (bus_id, route_id, driver_id, trip_type, start_lat, start_lng)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [busId, assignment?.route_id || null, req.user.id, tripType, lat || null, lng || null]
  );

  await db.query(
    `UPDATE buses SET trip_status='started', is_online=true, last_seen=NOW(),
                     driver_user_id=$1 WHERE id=$2`,
    [req.user.id, busId]
  );

  await db.query(
    `INSERT INTO trip_events (trip_id, bus_id, event_type, description)
     VALUES ($1,$2,'trip_started','Trip started via REST fallback')`,
    [trip.id, busId]
  );

  if (req.io) {
    req.io.to(`bus:${busId}`).emit('trip:started', {
      tripId: trip.id, busId, tripType, driverName: req.user.name, ts: Date.now(), lat, lng,
    });
  }

  res.status(201).json({ success: true, data: trip });
}

// ── POST /api/tracking/end-trip ───────────────────────────────────────────────
async function endTrip(req, res) {
  const { tripId, busId, lat, lng } = req.body;
  if (!tripId) throw new AppError('tripId required', 400);

  await db.query(
    `UPDATE trip_sessions SET status='completed', ended_at=NOW(), end_lat=$1, end_lng=$2
     WHERE id=$3`, [lat || null, lng || null, tripId]
  );

  await db.query(
    `UPDATE buses SET trip_status='idle', is_online=false, last_seen=NOW() WHERE id=$1`, [busId]
  );

  if (req.io && busId) {
    req.io.to(`bus:${busId}`).emit('trip:ended', { busId, ts: Date.now() });
  }

  res.json({ success: true, message: 'Trip ended' });
}

// ── POST /api/tracking/event ──────────────────────────────────────────────────
// Log any trip event (picked, dropped, emergency).
async function logTripEvent(req, res) {
  const { tripId, busId, studentId, stopId, eventType, lat, lng, description } = req.body;
  if (!busId || !eventType) throw new AppError('busId and eventType required', 400);

  const { rows: [event] } = await db.query(
    `INSERT INTO trip_events (trip_id, bus_id, student_id, stop_id, event_type, lat, lng, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tripId || null, busId, studentId || null, stopId || null,
     eventType, lat || null, lng || null, description || null]
  );

  // Broadcast to parents if student event
  if (req.io && studentId && ['student_picked', 'student_dropped'].includes(eventType)) {
    const { rows: [student] } = await db.query(
      `SELECT name, parent_user_id FROM students WHERE id = $1`, [studentId]
    );
    if (student?.parent_user_id) {
      req.io.to(`parent:${student.parent_user_id}`).emit('notification', {
        type: eventType,
        message: eventType === 'student_picked'
          ? `${student.name} has boarded the van`
          : `${student.name} has been dropped at their stop`,
        studentName: student.name, busId, ts: Date.now(),
      });
    }
  }

  if (req.io && eventType === 'emergency') {
    req.io.to('admin:tracking').emit('alert:emergency', {
      busId, lat, lng, description, ts: Date.now(),
    });
  }

  res.status(201).json({ success: true, data: event });
}

// ── GET /api/tracking/history/:busId ─────────────────────────────────────────
async function getLocationHistory(req, res) {
  const { busId } = req.params;
  const { tripId, limit = 200 } = req.query;
  const conditions = ['bus_id = $1'];
  const vals = [busId];

  if (tripId) { vals.push(tripId); conditions.push(`trip_id = $${vals.length}`); }

  const { rows } = await db.query(
    `SELECT lat, lng, speed, heading, recorded_at
     FROM vehicle_locations WHERE ${conditions.join(' AND ')}
     ORDER BY recorded_at DESC LIMIT $${vals.length + 1}`,
    [...vals, +limit]
  );

  res.json({ success: true, data: rows.reverse() });
}

// ── GET /api/tracking/trips/:busId ────────────────────────────────────────────
async function getTripHistory(req, res) {
  const { busId } = req.params;
  const { rows } = await db.query(
    `SELECT ts.*, u.name AS driver_name, r.route_name,
            COUNT(te.id) AS event_count
     FROM trip_sessions ts
     LEFT JOIN users u ON u.id = ts.driver_id
     LEFT JOIN transport_routes r ON r.id = ts.route_id
     LEFT JOIN trip_events te ON te.trip_id = ts.id
     WHERE ts.bus_id = $1
     GROUP BY ts.id, u.name, r.route_name
     ORDER BY ts.started_at DESC LIMIT 30`, [busId]
  );
  res.json({ success: true, data: rows });
}

// ── GET /api/tracking/events/:tripId ─────────────────────────────────────────
async function getTripEvents(req, res) {
  const { rows } = await db.query(
    `SELECT te.*, s.name AS student_name, rs.stop_name
     FROM trip_events te
     LEFT JOIN students s ON s.id = te.student_id
     LEFT JOIN route_stops rs ON rs.id = te.stop_id
     WHERE te.trip_id = $1
     ORDER BY te.created_at`, [req.params.tripId]
  );
  res.json({ success: true, data: rows });
}

// ── POST /api/tracking/emergency ─────────────────────────────────────────────
async function reportEmergency(req, res) {
  const { busId, tripId, lat, lng, message } = req.body;
  if (!busId) throw new AppError('busId required', 400);

  const { rows: [event] } = await db.query(
    `INSERT INTO trip_events (trip_id, bus_id, event_type, lat, lng, description)
     VALUES ($1,$2,'emergency',$3,$4,$5) RETURNING *`,
    [tripId || null, busId, lat || null, lng || null,
     message || 'EMERGENCY - Panic button activated']
  );

  if (req.io) {
    req.io.to('admin:tracking').emit('alert:emergency', {
      busId, lat, lng, message, ts: Date.now(),
    });
    req.io.to(`bus:${busId}`).emit('alert:emergency', {
      busId, lat, lng, message, ts: Date.now(),
    });
  }

  res.status(201).json({ success: true, data: event });
}

// ── GET /api/tracking/summary ─────────────────────────────────────────────────
async function getTrackingSummary(req, res) {
  const { rows: [stats] } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM buses WHERE status = 'active') AS total_active_buses,
       (SELECT COUNT(*) FROM buses WHERE is_online = true) AS online_buses,
       (SELECT COUNT(*) FROM trip_sessions WHERE status = 'active') AS active_trips,
       (SELECT COUNT(*) FROM trip_events WHERE event_type = 'emergency'
         AND created_at >= NOW() - INTERVAL '24 hours') AS emergency_alerts_today`
  );
  res.json({ success: true, data: stats });
}

module.exports = {
  getLiveBus,
  getAllBusesLive,
  getMyBus,
  getRouteStops,
  postLocationFallback,
  startTrip,
  endTrip,
  logTripEvent,
  getLocationHistory,
  getTripHistory,
  getTripEvents,
  reportEmergency,
  getTrackingSummary,
};
