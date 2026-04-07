/**
 * socketService.js
 * Socket.IO server — manages all real-time transport tracking events.
 *
 * ROOM NAMING:
 *   bus:{busId}        — drivers + parents watching a specific bus
 *   driver:{userId}    — driver's own room (for acks back to driver)
 *   admin:tracking     — admin room (all bus events)
 *
 * EVENT FLOW (driver → server → parents):
 *   driver emits  →  server validates + writes DB  →  broadcasts to bus room
 */

const jwt         = require('jsonwebtoken');
const db          = require('../db');
const logger      = require('../utils/logger');
const { setupChatSocket } = require('./chatSocketService');
const {
  shouldAcceptLocation,
  buildLocationPayload,
  isOverspeed,
  isNearStop,
  isDeviatingFromRoute,
  calcEtaMinutes,
  findNearestStop,
  SPEED_LIMIT_KMH,
} = require('./trackingService');

// ── In-memory bus state cache (reduces DB reads on hot path) ──────────────────
// busId → { lat, lng, speed, heading, ts, tripId, routeStops: [...] }
const busStateCache = new Map();

// ── In-memory pending location batch (written to DB every 10 s) ──────────────
const locationBatch = [];
let batchTimer = null;

async function flushLocationBatch() {
  if (locationBatch.length === 0) return;
  const toFlush = locationBatch.splice(0, locationBatch.length);
  try {
    const values = toFlush
      .map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`)
      .join(',');
    const params = toFlush.flatMap(p => [
      p.busId, p.tripId || null, p.lat, p.lng,
      p.speed, p.heading, new Date(p.ts),
    ]);
    await db.query(
      `INSERT INTO vehicle_locations (bus_id, trip_id, lat, lng, speed, heading, recorded_at)
       VALUES ${values}`, params
    );
  } catch (err) {
    logger.error({ err: err.message }, '[socket] location batch flush error');
  }
}

// ── Authenticate socket connection (JWT in handshake) ─────────────────────────
function authenticateSocket(socket, next) {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.replace('Bearer ', '');

  if (!token) return next(new Error('AUTH_REQUIRED'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;   // { id, role, schoolId, name, ... }
    next();
  } catch {
    next(new Error('AUTH_INVALID'));
  }
}

// ── Load route stops for a bus/trip (cached 60 s) ────────────────────────────
const stopsCache = new Map(); // busId → { stops, ts }
const STOPS_TTL  = 60_000;

async function getRouteStopsForBus(busId) {
  const cached = stopsCache.get(busId);
  if (cached && Date.now() - cached.ts < STOPS_TTL) return cached.stops;

  const { rows } = await db.query(
    `SELECT rs.id, rs.stop_name, rs.latitude, rs.longitude, rs.stop_order,
            rs.pickup_time, rs.dropoff_time
     FROM route_stops rs
     JOIN bus_route_assignments bra ON bra.route_id = rs.route_id
     WHERE bra.bus_id = $1 AND bra.is_active = true
       AND rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL
     ORDER BY rs.stop_order`,
    [busId]
  );
  stopsCache.set(busId, { stops: rows, ts: Date.now() });
  return rows;
}

// ── Validate driver owns this bus ─────────────────────────────────────────────
async function driverOwnsBus(userId, busId) {
  const { rows } = await db.query(
    `SELECT id FROM buses WHERE id = $1 AND driver_user_id = $2 AND status = 'active'`,
    [busId, userId]
  );
  return rows.length > 0;
}

// ── Validate parent has a child on this bus ───────────────────────────────────
async function parentHasBus(userId, busId) {
  // First look up student linked to this parent
  const { rows: students } = await db.query(
    `SELECT st.bus_id FROM student_transport st
     JOIN students s ON s.id = st.student_id
     WHERE s.parent_user_id = $1
       AND st.bus_id = $2
       AND st.status = 'active'
     LIMIT 1`,
    [userId, busId]
  );
  // Fallback: admin/teacher can always view
  return students.length > 0;
}

// ── Notify parents at a stop that bus is near ─────────────────────────────────
async function notifyNearPickup(io, busId, stop, etaMinutes) {
  // Get all students assigned to this stop
  const { rows } = await db.query(
    `SELECT s.parent_user_id, s.name AS student_name
     FROM student_transport st
     JOIN students s ON s.id = st.student_id
     WHERE st.bus_id = $1 AND st.stop_id = $2 AND st.status = 'active'`,
    [busId, stop.id]
  );

  rows.forEach(r => {
    if (r.parent_user_id) {
      io.to(`parent:${r.parent_user_id}`).emit('notification', {
        type: 'near_pickup',
        message: `Van is ${etaMinutes <= 1 ? 'almost at' : `${etaMinutes} min from`} your pickup point`,
        studentName: r.student_name,
        stopName: stop.stop_name,
        etaMinutes,
        busId,
        ts: Date.now(),
      });
    }
  });
}

// ── Main setup function (called from index.js) ────────────────────────────────
function setupSocketIO(io) {
  // Apply JWT authentication middleware to all socket connections
  io.use(authenticateSocket);

  // Start batch flush interval (10 seconds)
  batchTimer = setInterval(flushLocationBatch, 10_000);

  io.on('connection', async (socket) => {
    const { user } = socket;
    logger.info({ userId: user.id, role: user.role }, '[socket] connected');

    // ── Join personal room (for targeted notifications) ───────────────────────
    socket.join(`user:${user.id}`);
    if (user.role === 'admin') socket.join('admin:tracking');

    // ── Chat system — class-based Slack-style rooms ───────────────────────────
    setupChatSocket(io, socket);

    // ════════════════════════════════════════════════════════════════════════
    // DRIVER EVENTS
    // ════════════════════════════════════════════════════════════════════════

    // driver:join — driver announces which bus they're driving
    socket.on('driver:join', async ({ busId }, ack) => {
      try {
        if (!['admin', 'teacher'].includes(user.role)) {
          // For drivers, validate ownership
          const owns = await driverOwnsBus(user.id, busId);
          if (!owns) return ack?.({ error: 'Not your bus' });
        }

        socket.busId = busId;
        socket.join(`bus:${busId}`);
        socket.join(`driver:${user.id}`);

        // Mark bus online
        await db.query(
          `UPDATE buses SET is_online = true, last_seen = NOW() WHERE id = $1`,
          [busId]
        );

        // Pre-load route stops into cache
        await getRouteStopsForBus(busId);

        // Notify all watchers
        io.to(`bus:${busId}`).emit('bus:online', { busId, driverName: user.name, ts: Date.now() });
        io.to('admin:tracking').emit('bus:online', { busId, ts: Date.now() });

        logger.info({ busId, userId: user.id }, '[socket] driver joined bus');
        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] driver:join error');
        ack?.({ error: 'Server error' });
      }
    });

    // trip:start — driver begins a new trip session
    socket.on('trip:start', async ({ busId, tripType = 'morning', lat, lng }, ack) => {
      try {
        socket.busId = busId;

        // Get current route
        const { rows: [assignment] } = await db.query(
          `SELECT route_id FROM bus_route_assignments
           WHERE bus_id = $1 AND is_active = true LIMIT 1`, [busId]
        );

        // Create trip session
        const { rows: [trip] } = await db.query(
          `INSERT INTO trip_sessions (bus_id, route_id, driver_id, trip_type, start_lat, start_lng)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [busId, assignment?.route_id || null, user.id, tripType, lat || null, lng || null]
        );

        // Update bus trip status
        await db.query(
          `UPDATE buses SET trip_status = 'started', last_seen = NOW(), is_online = true WHERE id = $1`, [busId]
        );

        // Log event
        await db.query(
          `INSERT INTO trip_events (trip_id, bus_id, event_type, lat, lng, description)
           VALUES ($1,$2,'trip_started',$3,$4,'Trip started by driver')`,
          [trip.id, busId, lat || null, lng || null]
        );

        // Store in socket state
        socket.tripId = trip.id;

        // Broadcast trip started
        io.to(`bus:${busId}`).emit('trip:started', {
          tripId: trip.id, busId, tripType, driverName: user.name,
          ts: Date.now(), lat, lng,
        });
        io.to('admin:tracking').emit('trip:started', { tripId: trip.id, busId, ts: Date.now() });

        logger.info({ tripId: trip.id, busId }, '[socket] trip started');
        ack?.({ ok: true, tripId: trip.id });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] trip:start error');
        ack?.({ error: 'Failed to start trip' });
      }
    });

    // location:update — driver sends GPS coordinates
    socket.on('location:update', async (data, ack) => {
      try {
        const busId = data.busId || socket.busId;
        if (!busId) return ack?.({ error: 'No bus context' });

        // Throttle: reject if too frequent
        if (!shouldAcceptLocation(busId)) return ack?.({ throttled: true });

        // Get previous state for speed/heading calc
        const prev = busStateCache.get(busId);

        const payload = buildLocationPayload({
          busId,
          tripId: data.tripId || socket.tripId,
          lat: data.lat,
          lng: data.lng,
          speed: data.speed,
          heading: data.heading,
          accuracy: data.accuracy,
          prevLat: prev?.lat,
          prevLng: prev?.lng,
          prevTs:  prev?.ts,
        });

        // Update in-memory cache
        busStateCache.set(busId, { ...payload, tripId: payload.tripId });

        // Batch for DB write (non-blocking)
        locationBatch.push(payload);

        // Update bus live columns (fast, just one row)
        await db.query(
          `UPDATE buses SET current_lat=$1, current_lng=$2, current_speed=$3, last_seen=NOW()
           WHERE id=$4`,
          [payload.lat, payload.lng, payload.speed, busId]
        );

        // ── Smart checks ──────────────────────────────────────────────────────
        const stops = await getRouteStopsForBus(busId);

        // Overspeed check
        if (isOverspeed(payload.speed)) {
          await db.query(
            `INSERT INTO trip_events (trip_id, bus_id, event_type, lat, lng, speed, description)
             VALUES ($1,$2,'overspeed',$3,$4,$5,$6)`,
            [payload.tripId, busId, payload.lat, payload.lng, payload.speed,
             `Speed ${payload.speed} km/h exceeds ${SPEED_LIMIT_KMH} km/h limit`]
          );
          io.to('admin:tracking').emit('alert:overspeed', {
            busId, speed: payload.speed, lat: payload.lat, lng: payload.lng, ts: payload.ts,
          });
          socket.emit('warning:overspeed', { speed: payload.speed, limit: SPEED_LIMIT_KMH });
        }

        // Route deviation check
        if (stops.length > 0 && isDeviatingFromRoute(payload.lat, payload.lng, stops)) {
          io.to('admin:tracking').emit('alert:deviation', {
            busId, lat: payload.lat, lng: payload.lng, ts: payload.ts,
          });
        }

        // Near pickup check — find nearest stop and alert parents
        const nearest = findNearestStop(payload.lat, payload.lng, stops);
        if (nearest && isNearStop(payload.lat, payload.lng, +nearest.stop.latitude, +nearest.stop.longitude)) {
          const eta = calcEtaMinutes(payload.lat, payload.lng,
            +nearest.stop.latitude, +nearest.stop.longitude, payload.speed);
          // Only fire if not already fired recently (simple debounce with cache flag)
          const nKey = `near:${busId}:${nearest.stop.id}`;
          const lastNear = busStateCache.get(nKey);
          if (!lastNear || Date.now() - lastNear > 120_000) { // 2-min cooldown
            busStateCache.set(nKey, Date.now());
            notifyNearPickup(io, busId, nearest.stop, eta);
            io.to(`bus:${busId}`).emit('bus:near_stop', {
              busId, stopId: nearest.stop.id, stopName: nearest.stop.stop_name,
              etaMinutes: eta, ts: payload.ts,
            });
          }
        }

        // Broadcast location to all watchers (parents + admin)
        io.to(`bus:${busId}`).emit('location:update', payload);
        io.to('admin:tracking').emit('location:update', payload);

        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] location:update error');
        ack?.({ error: 'Failed to process location' });
      }
    });

    // student:picked — driver marks student as picked up
    socket.on('student:picked', async ({ busId, studentId, stopId, lat, lng }, ack) => {
      try {
        const tId = socket.tripId;
        await db.query(
          `INSERT INTO trip_events (trip_id, bus_id, student_id, stop_id, event_type, lat, lng, description)
           VALUES ($1,$2,$3,$4,'student_picked',$5,$6,'Student boarded the van')`,
          [tId, busId, studentId, stopId || null, lat || null, lng || null]
        );

        // Get student info for notification
        const { rows: [student] } = await db.query(
          `SELECT name, parent_user_id FROM students WHERE id = $1`, [studentId]
        );

        const payload = { busId, studentId, studentName: student?.name, ts: Date.now() };
        io.to(`bus:${busId}`).emit('student:picked', payload);

        if (student?.parent_user_id) {
          io.to(`parent:${student.parent_user_id}`).emit('notification', {
            type: 'student_picked',
            message: `${student.name} has boarded the van`,
            studentName: student.name,
            busId, ts: Date.now(),
          });
        }

        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] student:picked error');
        ack?.({ error: 'Failed' });
      }
    });

    // student:dropped — driver marks student as dropped off
    socket.on('student:dropped', async ({ busId, studentId, stopId, lat, lng }, ack) => {
      try {
        const tId = socket.tripId;
        await db.query(
          `INSERT INTO trip_events (trip_id, bus_id, student_id, stop_id, event_type, lat, lng, description)
           VALUES ($1,$2,$3,$4,'student_dropped',$5,$6,'Student dropped at stop')`,
          [tId, busId, studentId, stopId || null, lat || null, lng || null]
        );

        const { rows: [student] } = await db.query(
          `SELECT name, parent_user_id FROM students WHERE id = $1`, [studentId]
        );

        if (student?.parent_user_id) {
          io.to(`parent:${student.parent_user_id}`).emit('notification', {
            type: 'student_dropped',
            message: `${student.name} has been dropped at their stop`,
            studentName: student.name,
            busId, ts: Date.now(),
          });
        }

        io.to(`bus:${busId}`).emit('student:dropped', {
          busId, studentId, studentName: student?.name, ts: Date.now(),
        });

        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] student:dropped error');
        ack?.({ error: 'Failed' });
      }
    });

    // trip:end — driver ends the trip
    socket.on('trip:end', async ({ busId, lat, lng }, ack) => {
      try {
        const tId = socket.tripId;

        // Calculate total km from location log
        const { rows: [km] } = await db.query(
          `WITH ordered AS (
             SELECT lat, lng, recorded_at,
                    LAG(lat) OVER (ORDER BY recorded_at) AS prev_lat,
                    LAG(lng) OVER (ORDER BY recorded_at) AS prev_lng
             FROM vehicle_locations WHERE trip_id = $1
           )
           SELECT SUM(
             2 * 6371 * ASIN(SQRT(
               POWER(SIN((RADIANS(lat) - RADIANS(prev_lat))/2), 2) +
               COS(RADIANS(prev_lat)) * COS(RADIANS(lat)) *
               POWER(SIN((RADIANS(lng) - RADIANS(prev_lng))/2), 2)
             ))
           ) AS total_km FROM ordered WHERE prev_lat IS NOT NULL`,
          [tId]
        );

        await db.query(
          `UPDATE trip_sessions SET status='completed', ended_at=NOW(), end_lat=$1, end_lng=$2, total_km=$3
           WHERE id=$4`,
          [lat || null, lng || null, km?.total_km || 0, tId]
        );

        await db.query(
          `UPDATE buses SET trip_status='idle', is_online=false, last_seen=NOW() WHERE id=$1`, [busId]
        );

        await db.query(
          `INSERT INTO trip_events (trip_id, bus_id, event_type, lat, lng, description)
           VALUES ($1,$2,'trip_ended',$3,$4,'Trip completed')`,
          [tId, busId, lat || null, lng || null]
        );

        socket.tripId = null;
        busStateCache.delete(busId);
        stopsCache.delete(busId);

        io.to(`bus:${busId}`).emit('trip:ended', { busId, ts: Date.now() });
        io.to('admin:tracking').emit('trip:ended', { busId, ts: Date.now() });

        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] trip:end error');
        ack?.({ error: 'Failed to end trip' });
      }
    });

    // emergency — driver hits panic button
    socket.on('emergency', async ({ busId, lat, lng, message }, ack) => {
      try {
        const tId = socket.tripId;
        await db.query(
          `INSERT INTO trip_events (trip_id, bus_id, event_type, lat, lng, description)
           VALUES ($1,$2,'emergency',$3,$4,$5)`,
          [tId || null, busId, lat || null, lng || null, message || 'EMERGENCY - Driver pressed panic button']
        );

        const alert = {
          type: 'emergency', busId, lat, lng, message,
          driverName: user.name, ts: Date.now(),
        };

        io.to('admin:tracking').emit('alert:emergency', alert);
        io.to(`bus:${busId}`).emit('alert:emergency', alert);

        logger.error({ busId, lat, lng }, '[socket] EMERGENCY ALERT');
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ error: 'Failed' });
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // PARENT / VIEWER EVENTS
    // ════════════════════════════════════════════════════════════════════════

    // parent:join — parent subscribes to a bus's live feed
    socket.on('parent:join', async ({ busId }, ack) => {
      try {
        // Validate parent has a child on this bus
        if (user.role === 'parent') {
          const allowed = await parentHasBus(user.id, busId);
          if (!allowed) return ack?.({ error: 'Your child is not assigned to this bus' });
          // Join personal notification room
          socket.join(`parent:${user.id}`);
        }

        socket.join(`bus:${busId}`);

        // Send current bus state immediately
        const cached = busStateCache.get(busId);
        if (cached) {
          socket.emit('location:update', cached);
        } else {
          // Fallback: get last known from DB
          const { rows: [last] } = await db.query(
            `SELECT lat, lng, speed, heading, recorded_at AS ts
             FROM vehicle_locations WHERE bus_id = $1
             ORDER BY recorded_at DESC LIMIT 1`, [busId]
          );
          if (last) socket.emit('location:update', { ...last, busId });
        }

        ack?.({ ok: true });
      } catch (err) {
        logger.error({ err: err.message }, '[socket] parent:join error');
        ack?.({ error: 'Failed to join bus feed' });
      }
    });

    // ── Disconnect cleanup ────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const busId = socket.busId;
      if (busId && ['admin', 'teacher'].includes(user.role) === false) {
        await db.query(
          `UPDATE buses SET is_online = false, last_seen = NOW() WHERE id = $1`, [busId]
        ).catch(() => {});
        io.to(`bus:${busId}`).emit('bus:offline', { busId, ts: Date.now() });
        io.to('admin:tracking').emit('bus:offline', { busId, ts: Date.now() });
      }
      logger.info({ userId: user.id, busId }, '[socket] disconnected');
    });
  });

  logger.info('[socket] Socket.IO tracking service initialized');
  return io;
}

function getSocketService() {
  return { busStateCache, locationBatch };
}

function shutdownSocket() {
  if (batchTimer) {
    clearInterval(batchTimer);
    flushLocationBatch(); // final flush
  }
}

module.exports = { setupSocketIO, getSocketService, shutdownSocket };
