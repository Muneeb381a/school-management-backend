/**
 * trackingService.js
 * Core business logic for live vehicle tracking.
 * All math is pure functions — no DB calls here, easy to unit-test.
 */

// ── Haversine formula ─────────────────────────────────────────────────────────
// Returns distance in kilometres between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return (deg * Math.PI) / 180; }

// ── Speed calculation ─────────────────────────────────────────────────────────
// Returns speed in km/h between two GPS points separated by `elapsedMs` ms.
function calcSpeedKmh(lat1, lng1, lat2, lng2, elapsedMs) {
  if (elapsedMs <= 0) return 0;
  const distKm = haversineKm(lat1, lng1, lat2, lng2);
  return (distKm / elapsedMs) * 3_600_000; // convert ms → hours
}

// ── ETA calculation ───────────────────────────────────────────────────────────
// Returns ETA in minutes to reach `stopLat/stopLng` from current position
// at the bus's current speed. Falls back to straight-line estimate.
// `stops` is the ordered array of remaining route_stops [{lat, lng, stop_name}]
function calcEtaMinutes(busLat, busLng, stopLat, stopLng, speedKmh) {
  const distKm = haversineKm(busLat, busLng, stopLat, stopLng);
  const effectiveSpeed = speedKmh > 5 ? speedKmh : 25; // assume 25 km/h if still
  const hours = distKm / effectiveSpeed;
  return Math.round(hours * 60);
}

// ── Proximity detection ───────────────────────────────────────────────────────
// Returns true if bus is within `radiusKm` of the stop.
const NEAR_PICKUP_RADIUS_KM = 0.5; // 500 metres
function isNearStop(busLat, busLng, stopLat, stopLng, radiusKm = NEAR_PICKUP_RADIUS_KM) {
  return haversineKm(busLat, busLng, stopLat, stopLng) <= radiusKm;
}

// ── Overspeed detection ───────────────────────────────────────────────────────
const SPEED_LIMIT_KMH = 60; // school van limit
function isOverspeed(speedKmh, limit = SPEED_LIMIT_KMH) {
  return speedKmh > limit;
}

// ── Route deviation detection ─────────────────────────────────────────────────
// Returns true if bus is more than `thresholdKm` away from ALL route stops.
// Cheap proxy for "off-route" without needing road geometry.
const DEVIATION_THRESHOLD_KM = 1.5; // 1.5 km off nearest stop = deviation
function isDeviatingFromRoute(busLat, busLng, stops, thresholdKm = DEVIATION_THRESHOLD_KM) {
  if (!stops || stops.length === 0) return false;
  const minDist = Math.min(
    ...stops.map(s => haversineKm(busLat, busLng, +s.latitude, +s.longitude))
  );
  return minDist > thresholdKm;
}

// ── Next stop finder ──────────────────────────────────────────────────────────
// Returns the nearest unvisited stop from `remainingStops`.
function findNearestStop(busLat, busLng, remainingStops) {
  if (!remainingStops || remainingStops.length === 0) return null;
  return remainingStops.reduce((best, stop) => {
    const d = haversineKm(busLat, busLng, +stop.latitude, +stop.longitude);
    return !best || d < best.dist ? { stop, dist: d } : best;
  }, null);
}

// ── Location throttle store (in-memory, per process) ─────────────────────────
// Prevents a driver app from flooding the server with updates.
// Accepts at most one location per bus per MIN_INTERVAL_MS.
const MIN_INTERVAL_MS  = 5_000;  // 5 seconds min between accepted updates
const _lastAccepted = new Map();   // busId → timestamp

function shouldAcceptLocation(busId) {
  const now   = Date.now();
  const last  = _lastAccepted.get(busId) || 0;
  if (now - last >= MIN_INTERVAL_MS) {
    _lastAccepted.set(busId, now);
    return true;
  }
  return false;
}

// ── Heading calculation ───────────────────────────────────────────────────────
function calcHeading(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const lat1R = toRad(lat1);
  const lat2R = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(lat2R);
  const x = Math.cos(lat1R) * Math.sin(lat2R) - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ── Build location payload (normalise driver data) ────────────────────────────
function buildLocationPayload({ busId, tripId, lat, lng, speed, heading, accuracy, prevLat, prevLng, prevTs }) {
  const now = Date.now();
  let computedSpeed = speed;
  let computedHeading = heading || 0;

  if (prevLat && prevLng && prevTs) {
    const elapsed = now - prevTs;
    if (!computedSpeed || computedSpeed <= 0) {
      computedSpeed = calcSpeedKmh(prevLat, prevLng, lat, lng, elapsed);
    }
    if (!heading) {
      computedHeading = calcHeading(prevLat, prevLng, lat, lng);
    }
  }

  return {
    busId,
    tripId,
    lat: +lat,
    lng: +lng,
    speed: Math.round(computedSpeed * 10) / 10,
    heading: Math.round(computedHeading),
    accuracy: accuracy || null,
    ts: now,
  };
}

module.exports = {
  haversineKm,
  calcSpeedKmh,
  calcEtaMinutes,
  isNearStop,
  isOverspeed,
  isDeviatingFromRoute,
  findNearestStop,
  shouldAcceptLocation,
  calcHeading,
  buildLocationPayload,
  NEAR_PICKUP_RADIUS_KM,
  SPEED_LIMIT_KMH,
  DEVIATION_THRESHOLD_KM,
};
