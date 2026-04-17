/**
 * transportController.js — Production-grade transport management
 *
 * Fixed bugs:
 *  - students.full_name (not first_name/last_name)
 *  - classes.name (not class_name)
 *  - capacity re-check on bus transfer
 *  - search uses full_name
 *
 * New endpoints:
 *  - transferStudent  — move student between buses with history log
 *  - generatePdf      — printable transport slip
 *  - getTransferHistory — audit log per student
 */

const db      = require('../db');
const PDFKit  = require('pdfkit');
const AppError = require('../utils/AppError');
const { logLifecycleEvent } = require('../services/lifecycleService');

// ─── shared helpers ──────────────────────────────────────────────────────────

/** Full joined row for one assignment */
async function fetchAssignment(id) {
  const { rows } = await db.query(
    `SELECT
       st.id, st.student_id, st.route_id, st.stop_id, st.bus_id,
       st.academic_year, st.transport_type, st.status,
       st.monthly_fee, st.fee_status, st.assigned_date, st.notes,
       st.created_at, st.updated_at,
       s.full_name                         AS student_name,
       s.roll_number,
       s.father_name,
       s.phone                             AS student_phone,
       c.name || ' – ' || c.section        AS class_section,
       r.id   AS route_id,   r.route_name,
       r.start_point,        r.end_point,
       rs.id  AS stop_id,    rs.stop_name,
       rs.pickup_time,       rs.dropoff_time,
       rs.landmark,
       b.id   AS bus_id,     b.bus_number,  b.vehicle_number,
       b.vehicle_type,       b.make_model,  b.capacity,
       b.driver_name,        b.driver_phone,
       d.id   AS driver_id,  d.full_name  AS driver_full_name,
       d.cnic AS driver_cnic, d.license_number AS driver_license,
       d.phone AS driver_mobile, d.photo_url AS driver_photo
     FROM student_transport st
     JOIN students          s  ON s.id  = st.student_id
     LEFT JOIN classes      c  ON c.id  = s.class_id
     LEFT JOIN transport_routes  r  ON r.id  = st.route_id
     LEFT JOIN route_stops  rs ON rs.id = st.stop_id
     LEFT JOIN buses        b  ON b.id  = st.bus_id
     LEFT JOIN drivers      d  ON d.id  = b.driver_id
     WHERE st.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  BUSES / VEHICLES
// ══════════════════════════════════════════════════════════════════════════════

const getBuses = async (req, res) => {
  const { status } = req.query;
  const conds = ['1=1'];
  const vals  = [];
  if (status) { vals.push(status); conds.push(`b.status = $${vals.length}`); }

  const { rows } = await db.query(
    `SELECT
       b.*,
       d.full_name    AS driver_full_name,
       d.phone        AS driver_mobile,
       d.cnic         AS driver_cnic,
       d.photo_url    AS driver_photo,
       r.id           AS assigned_route_id,
       r.route_name,
       bra.academic_year AS assigned_year,
       COUNT(st.id)::INT AS assigned_students
     FROM buses b
     LEFT JOIN drivers d ON d.id = b.driver_id
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = TRUE
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     LEFT JOIN student_transport st
       ON st.bus_id = b.id AND st.status = 'active'
       AND st.academic_year = COALESCE(bra.academic_year, '2024-25')
     WHERE ${conds.join(' AND ')}
     GROUP BY b.id, d.full_name, d.phone, d.cnic, d.photo_url,
              r.id, r.route_name, bra.academic_year
     ORDER BY b.bus_number`,
    vals
  );
  res.json({ success: true, data: rows });
};

const getBusById = async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       b.*,
       d.full_name AS driver_full_name, d.phone AS driver_mobile,
       d.cnic AS driver_cnic, d.license_number AS driver_license,
       d.photo_url AS driver_photo,
       r.route_name, bra.academic_year AS assigned_year,
       COUNT(st.id)::INT AS assigned_students
     FROM buses b
     LEFT JOIN drivers d ON d.id = b.driver_id
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = TRUE
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     LEFT JOIN student_transport st
       ON st.bus_id = b.id AND st.status = 'active'
       AND st.academic_year = COALESCE(bra.academic_year,'2024-25')
     WHERE b.id = $1
     GROUP BY b.id, d.full_name, d.phone, d.cnic, d.license_number, d.photo_url,
              r.route_name, bra.academic_year`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Bus not found', 404);
  res.json({ success: true, data: rows[0] });
};

const createBus = async (req, res) => {
  const {
    bus_number, vehicle_number, capacity, make_model,
    manufacture_year, vehicle_type = 'bus',
    driver_name, driver_phone, driver_license, driver_id,
    status = 'active', notes,
  } = req.body;

  if (!bus_number?.trim())     throw new AppError('bus_number is required', 400);
  if (!vehicle_number?.trim()) throw new AppError('vehicle_number is required', 400);
  if (!capacity || capacity <= 0) throw new AppError('capacity must be > 0', 400);

  const { rows } = await db.query(
    `INSERT INTO buses
       (bus_number, vehicle_number, capacity, make_model, manufacture_year,
        vehicle_type, driver_name, driver_phone, driver_license, driver_id,
        status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      bus_number.trim(), vehicle_number.trim(), Number(capacity),
      make_model || null, manufacture_year ? Number(manufacture_year) : null,
      vehicle_type,
      driver_name || null, driver_phone || null, driver_license || null,
      driver_id ? Number(driver_id) : null,
      status, notes || null,
    ]
  );
  res.status(201).json({ success: true, data: rows[0], message: 'Vehicle added' });
};

const updateBus = async (req, res) => {
  const {
    bus_number, vehicle_number, capacity, make_model,
    manufacture_year, vehicle_type, driver_name, driver_phone,
    driver_license, driver_id, status, notes,
  } = req.body;

  const { rows } = await db.query(
    `UPDATE buses SET
       bus_number       = COALESCE($1,  bus_number),
       vehicle_number   = COALESCE($2,  vehicle_number),
       capacity         = COALESCE($3,  capacity),
       make_model       = COALESCE($4,  make_model),
       manufacture_year = COALESCE($5,  manufacture_year),
       vehicle_type     = COALESCE($6,  vehicle_type),
       driver_name      = COALESCE($7,  driver_name),
       driver_phone     = COALESCE($8,  driver_phone),
       driver_license   = COALESCE($9,  driver_license),
       driver_id        = COALESCE($10, driver_id),
       status           = COALESCE($11, status),
       notes            = COALESCE($12, notes),
       updated_at       = NOW()
     WHERE id = $13 RETURNING *`,
    [
      bus_number?.trim() || null, vehicle_number?.trim() || null,
      capacity ? Number(capacity) : null,
      make_model || null, manufacture_year ? Number(manufacture_year) : null,
      vehicle_type || null,
      driver_name || null, driver_phone || null, driver_license || null,
      driver_id ? Number(driver_id) : null,
      status || null, notes || null,
      req.params.id,
    ]
  );
  if (!rows[0]) throw new AppError('Bus not found', 404);
  res.json({ success: true, data: rows[0], message: 'Vehicle updated' });
};

const deleteBus = async (req, res) => {
  // Block delete if active student assignments exist
  const { rows: active } = await db.query(
    `SELECT id FROM student_transport WHERE bus_id = $1 AND status = 'active' LIMIT 1`,
    [req.params.id]
  );
  if (active.length) {
    throw new AppError(
      'Cannot delete vehicle — it has active student assignments. Remove or transfer students first.',
      409
    );
  }
  const { rows } = await db.query(
    'DELETE FROM buses WHERE id=$1 RETURNING id', [req.params.id]
  );
  if (!rows[0]) throw new AppError('Bus not found', 404);
  res.json({ success: true, message: 'Vehicle deleted' });
};

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════════

const getRoutes = async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       r.*,
       COUNT(DISTINCT rs.id)::INT  AS total_stops,
       COUNT(DISTINCT st.id)::INT  AS assigned_students,
       b.bus_number, b.id AS bus_id
     FROM transport_routes r
     LEFT JOIN route_stops rs ON rs.route_id = r.id
     LEFT JOIN bus_route_assignments bra ON bra.route_id = r.id AND bra.is_active = TRUE
     LEFT JOIN buses b ON b.id = bra.bus_id
     LEFT JOIN student_transport st ON st.route_id = r.id AND st.status = 'active'
     GROUP BY r.id, b.bus_number, b.id
     ORDER BY r.route_name`
  );
  res.json({ success: true, data: rows });
};

const getRouteById = async (req, res) => {
  const [routeRes, stopsRes, studentsRes] = await Promise.all([
    db.query(
      `SELECT r.*, b.bus_number, b.id AS bus_id,
              COALESCE(d.full_name, b.driver_name) AS driver_name
       FROM transport_routes r
       LEFT JOIN bus_route_assignments bra ON bra.route_id = r.id AND bra.is_active = TRUE
       LEFT JOIN buses b ON b.id = bra.bus_id
       LEFT JOIN drivers d ON d.id = b.driver_id
       WHERE r.id = $1`,
      [req.params.id]
    ),
    db.query(
      `SELECT rs.*, COUNT(st.id)::INT AS student_count
       FROM route_stops rs
       LEFT JOIN student_transport st ON st.stop_id = rs.id AND st.status = 'active'
       WHERE rs.route_id = $1
       GROUP BY rs.id
       ORDER BY rs.stop_order`,
      [req.params.id]
    ),
    db.query(
      `SELECT st.id, s.full_name AS student_name,
              s.roll_number, rs.stop_name, b.bus_number,
              st.transport_type, st.status
       FROM student_transport st
       JOIN students s ON s.id = st.student_id
       LEFT JOIN route_stops rs ON rs.id = st.stop_id
       JOIN buses b ON b.id = st.bus_id
       WHERE st.route_id = $1 AND st.status = 'active'
       ORDER BY s.full_name`,
      [req.params.id]
    ),
  ]);
  if (!routeRes.rows[0]) throw new AppError('Route not found', 404);
  res.json({
    success: true,
    data: { ...routeRes.rows[0], stops: stopsRes.rows, students: studentsRes.rows },
  });
};

const createRoute = async (req, res) => {
  const { route_name, description, start_point, end_point, estimated_time, distance_km } = req.body;
  if (!route_name?.trim())  throw new AppError('route_name is required', 400);
  if (!start_point?.trim()) throw new AppError('start_point is required', 400);
  if (!end_point?.trim())   throw new AppError('end_point is required', 400);

  const { rows } = await db.query(
    `INSERT INTO transport_routes
       (route_name, description, start_point, end_point, estimated_time, distance_km)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      route_name.trim(), description || null,
      start_point.trim(), end_point.trim(),
      estimated_time ? Number(estimated_time) : null,
      distance_km ? Number(distance_km) : null,
    ]
  );
  res.status(201).json({ success: true, data: rows[0], message: 'Route created' });
};

const updateRoute = async (req, res) => {
  const { route_name, description, start_point, end_point, estimated_time, distance_km, is_active } = req.body;
  const { rows } = await db.query(
    `UPDATE transport_routes SET
       route_name     = COALESCE($1, route_name),
       description    = COALESCE($2, description),
       start_point    = COALESCE($3, start_point),
       end_point      = COALESCE($4, end_point),
       estimated_time = COALESCE($5, estimated_time),
       distance_km    = COALESCE($6, distance_km),
       is_active      = COALESCE($7, is_active),
       updated_at     = NOW()
     WHERE id = $8 RETURNING *`,
    [
      route_name?.trim() || null, description || null,
      start_point?.trim() || null, end_point?.trim() || null,
      estimated_time ? Number(estimated_time) : null,
      distance_km    ? Number(distance_km)    : null,
      is_active != null ? is_active : null,
      req.params.id,
    ]
  );
  if (!rows[0]) throw new AppError('Route not found', 404);
  res.json({ success: true, data: rows[0], message: 'Route updated' });
};

const deleteRoute = async (req, res) => {
  // Block delete if students are still assigned to this route
  const { rows: active } = await db.query(
    `SELECT id FROM student_transport WHERE route_id = $1 AND status = 'active' LIMIT 1`,
    [req.params.id]
  );
  if (active.length) {
    throw new AppError(
      'Cannot delete route — it has active student assignments. Remove students first.',
      409
    );
  }
  const { rows } = await db.query(
    'DELETE FROM transport_routes WHERE id=$1 RETURNING id', [req.params.id]
  );
  if (!rows[0]) throw new AppError('Route not found', 404);
  res.json({ success: true, message: 'Route deleted' });
};

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTE STOPS
// ══════════════════════════════════════════════════════════════════════════════

const getStops = async (req, res) => {
  const { rows } = await db.query(
    `SELECT rs.*, COUNT(st.id)::INT AS student_count
     FROM route_stops rs
     LEFT JOIN student_transport st ON st.stop_id = rs.id AND st.status = 'active'
     WHERE rs.route_id = $1
     GROUP BY rs.id
     ORDER BY rs.stop_order`,
    [req.params.routeId]
  );
  res.json({ success: true, data: rows });
};

const addStop = async (req, res) => {
  const { stop_name, stop_order, pickup_time, dropoff_time, landmark, latitude, longitude } = req.body;
  if (!stop_name?.trim()) throw new AppError('stop_name is required', 400);
  if (!stop_order)        throw new AppError('stop_order is required', 400);

  const { rows } = await db.query(
    `INSERT INTO route_stops
       (route_id, stop_name, stop_order, pickup_time, dropoff_time, landmark, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      req.params.routeId, stop_name.trim(), Number(stop_order),
      pickup_time || null, dropoff_time || null, landmark || null,
      latitude ? Number(latitude) : null, longitude ? Number(longitude) : null,
    ]
  );
  res.status(201).json({ success: true, data: rows[0], message: 'Stop added' });
};

const updateStop = async (req, res) => {
  const { stop_name, stop_order, pickup_time, dropoff_time, landmark, latitude, longitude } = req.body;
  const { rows } = await db.query(
    `UPDATE route_stops SET
       stop_name    = COALESCE($1, stop_name),
       stop_order   = COALESCE($2, stop_order),
       pickup_time  = COALESCE($3, pickup_time),
       dropoff_time = COALESCE($4, dropoff_time),
       landmark     = COALESCE($5, landmark),
       latitude     = COALESCE($6, latitude),
       longitude    = COALESCE($7, longitude)
     WHERE id = $8 RETURNING *`,
    [
      stop_name?.trim() || null, stop_order ? Number(stop_order) : null,
      pickup_time || null, dropoff_time || null, landmark || null,
      latitude ? Number(latitude) : null, longitude ? Number(longitude) : null,
      req.params.id,
    ]
  );
  if (!rows[0]) throw new AppError('Stop not found', 404);
  res.json({ success: true, data: rows[0], message: 'Stop updated' });
};

const deleteStop = async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM route_stops WHERE id=$1 RETURNING id', [req.params.id]
  );
  if (!rows[0]) throw new AppError('Stop not found', 404);
  res.json({ success: true, message: 'Stop deleted' });
};

// ══════════════════════════════════════════════════════════════════════════════
//  STUDENT TRANSPORT ASSIGNMENTS
// ══════════════════════════════════════════════════════════════════════════════

const getAssignments = async (req, res) => {
  const {
    route_id, bus_id, student_id,
    academic_year = '2024-25', status, search,
  } = req.query;

  const conditions = ['st.academic_year = $1'];
  const values     = [academic_year];
  const push = v => { values.push(v); return `$${values.length}`; };

  if (route_id)   conditions.push(`st.route_id   = ${push(Number(route_id))}`);
  if (bus_id)     conditions.push(`st.bus_id     = ${push(Number(bus_id))}`);
  if (student_id) conditions.push(`st.student_id = ${push(Number(student_id))}`);
  if (status)     conditions.push(`st.status     = ${push(status)}`);
  if (search) {
    const p = push(`%${search}%`);
    conditions.push(
      `(s.full_name ILIKE ${p} OR s.roll_number ILIKE ${p})`
    );
  }

  const { rows } = await db.query(
    `SELECT
       st.id, st.student_id,
       s.full_name                         AS student_name,
       s.roll_number,
       c.name || ' – ' || c.section        AS class_section,
       r.id AS route_id,   r.route_name,
       rs.id AS stop_id,   rs.stop_name,
       rs.pickup_time,     rs.dropoff_time,
       b.id AS bus_id,     b.bus_number,  b.vehicle_type,
       COALESCE(d.full_name, b.driver_name) AS driver_name,
       COALESCE(d.phone,     b.driver_phone) AS driver_phone,
       st.transport_type, st.status, st.academic_year,
       st.monthly_fee,    st.fee_status,
       st.assigned_date,  st.notes
     FROM student_transport st
     JOIN students          s  ON s.id  = st.student_id
     LEFT JOIN classes      c  ON c.id  = s.class_id
     LEFT JOIN transport_routes  r  ON r.id  = st.route_id
     LEFT JOIN route_stops  rs ON rs.id = st.stop_id
     LEFT JOIN buses        b  ON b.id  = st.bus_id
     LEFT JOIN drivers      d  ON d.id  = b.driver_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.full_name`,
    values
  );
  res.json({ success: true, data: rows });
};

const createAssignment = async (req, res) => {
  const {
    student_id, route_id, stop_id, bus_id,
    academic_year = '2024-25', transport_type = 'both',
    monthly_fee, notes,
  } = req.body;

  if (!student_id) throw new AppError('student_id is required', 400);
  if (!route_id)   throw new AppError('route_id is required', 400);
  if (!bus_id)     throw new AppError('bus_id is required', 400);

  // Duplicate check — one assignment per student per academic year
  const { rows: existing } = await db.query(
    `SELECT id FROM student_transport WHERE student_id = $1 AND academic_year = $2 AND status = 'active'`,
    [Number(student_id), academic_year]
  );
  if (existing.length) throw new AppError('Student is already assigned to transport for this academic year', 409);

  // Capacity check
  const { rows: capRows } = await db.query(
    `SELECT b.capacity,
            (SELECT COUNT(*) FROM student_transport
             WHERE bus_id = $1 AND academic_year = $2 AND status = 'active') AS current_count
     FROM buses b WHERE b.id = $1`,
    [Number(bus_id), academic_year]
  );
  if (!capRows[0]) throw new AppError('Bus not found', 404);
  if (Number(capRows[0].current_count) >= Number(capRows[0].capacity)) {
    throw new AppError(
      `Bus is at full capacity (${capRows[0].capacity} seats). Choose a different vehicle.`,
      400
    );
  }

  const { rows } = await db.query(
    `INSERT INTO student_transport
       (student_id, route_id, stop_id, bus_id, academic_year,
        transport_type, monthly_fee, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      Number(student_id), Number(route_id),
      stop_id ? Number(stop_id) : null,
      Number(bus_id), academic_year, transport_type,
      monthly_fee ? Number(monthly_fee) : null,
      notes || null,
    ]
  );

  const assignment = await fetchAssignment(rows[0].id);

  logLifecycleEvent({
    studentId:   Number(student_id),
    eventType:   'transport_assigned',
    title:       `Assigned to bus ${assignment?.bus_number || bus_id}`,
    description: assignment ? `Route: ${assignment.route_name} · Stop: ${assignment.stop_name || 'N/A'}` : null,
    metadata:    { bus_id, route_id, stop_id, transport_type, assignment_id: rows[0].id },
    performedBy: req.user?.id ?? null,
  }).catch(() => {});

  res.status(201).json({
    success: true,
    data: assignment,
    message: 'Student assigned to transport',
  });
};

const updateAssignment = async (req, res) => {
  const {
    route_id, stop_id, bus_id, status,
    transport_type, monthly_fee, fee_status, notes,
    academic_year,
  } = req.body;

  // If changing bus, re-validate capacity
  if (bus_id) {
    const { rows: [cur] } = await db.query(
      'SELECT bus_id, academic_year FROM student_transport WHERE id = $1',
      [req.params.id]
    );
    if (cur && Number(bus_id) !== Number(cur.bus_id)) {
      const yr = academic_year || cur.academic_year;
      const { rows: capRows } = await db.query(
        `SELECT b.capacity,
                (SELECT COUNT(*) FROM student_transport
                 WHERE bus_id = $1 AND academic_year = $2
                   AND status = 'active' AND id != $3) AS current_count
         FROM buses b WHERE b.id = $1`,
        [Number(bus_id), yr, req.params.id]
      );
      if (capRows[0] && Number(capRows[0].current_count) >= Number(capRows[0].capacity)) {
        throw new AppError(
          `Target bus is at full capacity (${capRows[0].capacity} seats).`,
          400
        );
      }
    }
  }

  const { rows } = await db.query(
    `UPDATE student_transport SET
       route_id       = COALESCE($1, route_id),
       stop_id        = COALESCE($2, stop_id),
       bus_id         = COALESCE($3, bus_id),
       status         = COALESCE($4, status),
       transport_type = COALESCE($5, transport_type),
       monthly_fee    = COALESCE($6, monthly_fee),
       fee_status     = COALESCE($7, fee_status),
       notes          = COALESCE($8, notes),
       updated_at     = NOW()
     WHERE id = $9 RETURNING id`,
    [
      route_id ? Number(route_id) : null,
      stop_id  ? Number(stop_id)  : null,
      bus_id   ? Number(bus_id)   : null,
      status || null, transport_type || null,
      monthly_fee ? Number(monthly_fee) : null,
      fee_status  || null, notes || null,
      req.params.id,
    ]
  );
  if (!rows[0]) throw new AppError('Assignment not found', 404);

  const assignment = await fetchAssignment(rows[0].id);
  res.json({ success: true, data: assignment, message: 'Assignment updated' });
};

const deleteAssignment = async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM student_transport WHERE id=$1 RETURNING id', [req.params.id]
  );
  if (!rows[0]) throw new AppError('Assignment not found', 404);
  res.json({ success: true, message: 'Assignment removed' });
};

// ══════════════════════════════════════════════════════════════════════════════
//  TRANSFER STUDENT
//  POST /transport/assignments/:id/transfer
// ══════════════════════════════════════════════════════════════════════════════
const transferStudent = async (req, res) => {
  const assignmentId = Number(req.params.id);
  const { to_bus_id, to_route_id, to_stop_id, transfer_reason } = req.body;

  if (!to_bus_id)   throw new AppError('to_bus_id is required', 400);
  if (!to_route_id) throw new AppError('to_route_id is required', 400);

  // Fetch current assignment
  const { rows: [cur] } = await db.query(
    `SELECT * FROM student_transport WHERE id = $1`, [assignmentId]
  );
  if (!cur) throw new AppError('Assignment not found', 404);

  // Capacity check on destination bus
  const { rows: capRows } = await db.query(
    `SELECT b.capacity,
            (SELECT COUNT(*) FROM student_transport
             WHERE bus_id = $1 AND academic_year = $2 AND status = 'active') AS current_count
     FROM buses b WHERE b.id = $1`,
    [Number(to_bus_id), cur.academic_year]
  );
  if (!capRows[0]) throw new AppError('Target bus not found', 404);
  if (Number(capRows[0].current_count) >= Number(capRows[0].capacity)) {
    throw new AppError(
      `Target bus is full (${capRows[0].capacity} seats occupied).`,
      400
    );
  }

  // Perform transfer in a transaction
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Log transfer history
    await client.query(
      `INSERT INTO transport_transfer_history
         (student_id, assignment_id, from_bus_id, to_bus_id,
          from_route_id, to_route_id, from_stop_id, to_stop_id,
          transfer_reason, transferred_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        cur.student_id, assignmentId,
        cur.bus_id,     Number(to_bus_id),
        cur.route_id,   Number(to_route_id),
        cur.stop_id  || null, to_stop_id ? Number(to_stop_id) : null,
        transfer_reason || null, req.user.id,
      ]
    );

    // Update assignment
    await client.query(
      `UPDATE student_transport SET
         bus_id    = $1,
         route_id  = $2,
         stop_id   = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [Number(to_bus_id), Number(to_route_id), to_stop_id ? Number(to_stop_id) : null, assignmentId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchAssignment(assignmentId);

  logLifecycleEvent({
    studentId:   cur.student_id,
    eventType:   'transport_transferred',
    title:       `Transferred to bus ${updated?.bus_number || to_bus_id}`,
    description: transfer_reason || `Moved to route ${updated?.route_name || to_route_id}`,
    metadata:    {
      from_bus_id: cur.bus_id, to_bus_id,
      from_route_id: cur.route_id, to_route_id,
      assignment_id: assignmentId, transfer_reason,
    },
    performedBy: req.user?.id ?? null,
  }).catch(() => {});

  res.json({ success: true, data: updated, message: 'Student transferred successfully' });
};

// ══════════════════════════════════════════════════════════════════════════════
//  TRANSFER HISTORY
//  GET /transport/students/:studentId/transfer-history
// ══════════════════════════════════════════════════════════════════════════════
const getTransferHistory = async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       th.*,
       s.full_name  AS student_name, s.roll_number,
       fb.bus_number AS from_bus,    tb.bus_number AS to_bus,
       fr.route_name AS from_route,  tr2.route_name AS to_route,
       fs.stop_name  AS from_stop,   ts2.stop_name  AS to_stop,
       u.name        AS transferred_by_name
     FROM transport_transfer_history th
     JOIN students         s   ON s.id   = th.student_id
     LEFT JOIN buses       fb  ON fb.id  = th.from_bus_id
     LEFT JOIN buses       tb  ON tb.id  = th.to_bus_id
     LEFT JOIN transport_routes fr  ON fr.id  = th.from_route_id
     LEFT JOIN transport_routes tr2 ON tr2.id = th.to_route_id
     LEFT JOIN route_stops fs  ON fs.id  = th.from_stop_id
     LEFT JOIN route_stops ts2 ON ts2.id = th.to_stop_id
     LEFT JOIN users       u   ON u.id   = th.transferred_by
     WHERE th.student_id = $1
     ORDER BY th.transferred_at DESC`,
    [req.params.studentId]
  );
  res.json({ success: true, data: rows });
};

// ══════════════════════════════════════════════════════════════════════════════
//  PDF TRANSPORT SLIP
//  GET /transport/assignments/:id/pdf
// ══════════════════════════════════════════════════════════════════════════════
const generatePdf = async (req, res) => {
  const assignment = await fetchAssignment(req.params.id);
  if (!assignment) throw new AppError('Assignment not found', 404);

  // Fetch school settings for letterhead
  const { rows: [school] } = await db.query(
    `SELECT school_name, address, phone, email, logo_url
     FROM school_settings LIMIT 1`
  ).catch(() => ({ rows: [{}] }));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="transport-slip-${assignment.roll_number || assignment.student_id}.pdf"`
  );

  const doc = new PDFKit({ margin: 40, size: 'A4' });
  doc.pipe(res);

  const BRAND   = '#4f46e5'; // indigo
  const DARK    = '#1e293b';
  const MID     = '#64748b';
  const LIGHT   = '#f1f5f9';
  const W       = 515;       // usable width

  // ── HEADER ────────────────────────────────────────────────────────────────
  doc.rect(40, 40, W, 70).fill(BRAND);

  doc.fillColor('white')
     .fontSize(18).font('Helvetica-Bold')
     .text(school?.school_name || 'School Transport', 60, 55, { width: W - 20 });

  doc.fontSize(9).font('Helvetica')
     .text('STUDENT TRANSPORT SLIP', 60, 78, { width: W - 20 });

  doc.fillColor(DARK);

  // ── SLIP META ─────────────────────────────────────────────────────────────
  const slipNo = `TS-${String(assignment.id).padStart(5, '0')}`;
  const issued  = new Date().toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });

  doc.y = 125;
  drawRow(doc, 'Slip No.', slipNo,        'Academic Year', assignment.academic_year, W, MID, LIGHT);
  drawRow(doc, 'Issued',  issued,          'Valid For',     assignment.academic_year + ' Session', W, MID, LIGHT);

  // ── STUDENT SECTION ───────────────────────────────────────────────────────
  sectionHeading(doc, 'Student Information', BRAND, W);
  drawRow(doc, 'Name',        assignment.student_name,  'Roll No.', assignment.roll_number || '—', W, MID, LIGHT);
  drawRow(doc, 'Class',       assignment.class_section || '—', 'Father',  assignment.father_name || '—', W, MID, LIGHT);
  drawRow(doc, 'Phone',       assignment.student_phone  || '—', 'Assigned',  fmtDate(assignment.assigned_date), W, MID, LIGHT);

  // ── VEHICLE SECTION ───────────────────────────────────────────────────────
  sectionHeading(doc, 'Vehicle Information', BRAND, W);
  const vType = (assignment.vehicle_type || 'bus').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  drawRow(doc, 'Vehicle No.', assignment.bus_number,         'Type',     vType, W, MID, LIGHT);
  drawRow(doc, 'Reg. Plate',  assignment.vehicle_number || '—', 'Model', assignment.make_model || '—', W, MID, LIGHT);
  drawRow(doc, 'Capacity',    String(assignment.capacity || '—'), 'Status', 'Active', W, MID, LIGHT);

  // ── DRIVER SECTION ────────────────────────────────────────────────────────
  sectionHeading(doc, 'Driver Information', BRAND, W);
  const dName  = assignment.driver_full_name || assignment.driver_name || '—';
  const dPhone = assignment.driver_mobile    || assignment.driver_phone || '—';
  drawRow(doc, 'Driver Name',   dName,                           'Phone',    dPhone, W, MID, LIGHT);
  drawRow(doc, 'License No.',   assignment.driver_license || '—', 'CNIC',    assignment.driver_cnic || '—', W, MID, LIGHT);

  // ── ROUTE & STOP SECTION ──────────────────────────────────────────────────
  sectionHeading(doc, 'Route & Stop Information', BRAND, W);
  drawRow(doc, 'Route',        assignment.route_name,           'Type',     (assignment.transport_type || '').toUpperCase(), W, MID, LIGHT);
  drawRow(doc, 'Pickup Stop',  assignment.stop_name || '—',     'Landmark', assignment.landmark || '—', W, MID, LIGHT);
  if (assignment.pickup_time || assignment.dropoff_time) {
    drawRow(doc, 'Pickup Time', assignment.pickup_time  || '—', 'Drop Time', assignment.dropoff_time || '—', W, MID, LIGHT);
  }

  // ── TERMS ─────────────────────────────────────────────────────────────────
  doc.moveDown(1.2);
  doc.fontSize(7.5).fillColor(MID)
     .text('• This slip is valid for the academic year shown above and must be presented upon request.', 40, doc.y, { width: W })
     .text('• Loss of this slip should be reported to the school office immediately.', 40, doc.y + 12, { width: W })
     .text('• The school reserves the right to revise transport arrangements with prior notice.', 40, doc.y + 24, { width: W });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const footerY = 770;
  doc.rect(40, footerY, W, 0.5).fill(BRAND);
  doc.fontSize(8).fillColor(MID)
     .text(`Generated: ${new Date().toLocaleString('en-PK')}  |  ${school?.phone || ''}  |  ${school?.email || ''}`,
       40, footerY + 8, { width: W, align: 'center' });

  doc.end();
};

// ─── PDF helpers ──────────────────────────────────────────────────────────────
function sectionHeading(doc, title, color, W) {
  doc.moveDown(0.6);
  doc.rect(40, doc.y, W, 18).fill(color);
  doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
     .text(title, 48, doc.y - 14, { width: W - 16 });
  doc.fillColor('#1e293b').font('Helvetica');
  doc.moveDown(0.15);
}

function drawRow(doc, k1, v1, k2, v2, W, MID, LIGHT) {
  const y   = doc.y + 2;
  const col = W / 2;
  // alternating row bg
  doc.rect(40, y, W, 20).fill(LIGHT);
  // labels
  doc.fontSize(8).fillColor(MID).font('Helvetica-Bold')
     .text(k1 + ':', 48, y + 5, { width: col - 60 });
  doc.fontSize(8.5).fillColor('#1e293b').font('Helvetica')
     .text(v1 || '—', 110, y + 4, { width: col - 70 });
  // right side
  doc.fontSize(8).fillColor(MID).font('Helvetica-Bold')
     .text(k2 + ':', 40 + col + 8, y + 5, { width: col - 60 });
  doc.fontSize(8.5).fillColor('#1e293b').font('Helvetica')
     .text(v2 || '—', 40 + col + 70, y + 4, { width: col - 80 });
  doc.y = y + 22;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
const getSummary = async (req, res) => {
  const { academic_year = '2024-25' } = req.query;

  const [busRes, routeRes, assignRes, occupancyRes, driverRes] = await Promise.all([
    db.query(`SELECT status, COUNT(*)::INT AS count FROM buses GROUP BY status`),
    db.query(`SELECT COUNT(*)::INT AS total FROM transport_routes WHERE is_active = TRUE`),
    db.query(
      `SELECT COUNT(*)::INT AS total_assigned,
              COUNT(*) FILTER (WHERE status='active')::INT   AS active,
              COUNT(*) FILTER (WHERE status='inactive')::INT AS inactive
       FROM student_transport WHERE academic_year = $1`,
      [academic_year]
    ),
    db.query(
      `SELECT b.bus_number, b.capacity, b.vehicle_type,
              COALESCE(d.full_name, b.driver_name) AS driver_name,
              b.status AS bus_status, r.route_name,
              COUNT(st.id)::INT AS assigned_students,
              ROUND(COUNT(st.id)*100.0/NULLIF(b.capacity,0),1) AS occupancy_pct
       FROM buses b
       LEFT JOIN drivers d ON d.id = b.driver_id
       LEFT JOIN bus_route_assignments bra ON bra.bus_id=b.id AND bra.is_active=TRUE
       LEFT JOIN transport_routes r ON r.id=bra.route_id
       LEFT JOIN student_transport st ON st.bus_id=b.id
         AND st.status='active' AND st.academic_year=$1
       GROUP BY b.id, d.full_name, r.route_name
       ORDER BY occupancy_pct DESC NULLS LAST`,
      [academic_year]
    ),
    db.query(
      `SELECT COUNT(*)::INT AS total,
              COUNT(*) FILTER (WHERE status='active')::INT AS active
       FROM drivers`
    ),
  ]);

  const busByStatus = {};
  busRes.rows.forEach(r => { busByStatus[r.status] = r.count; });

  res.json({
    success: true,
    data: {
      buses:       { total: busRes.rows.reduce((a, r) => a + r.count, 0), by_status: busByStatus },
      routes:      routeRes.rows[0],
      assignments: assignRes.rows[0],
      occupancy:   occupancyRes.rows,
      drivers:     driverRes.rows[0],
    },
  });
};

const getStudentsWithoutTransport = async (req, res) => {
  const { academic_year = '2024-25', search } = req.query;
  const conditions = [
    `s.status = 'active'`,
    `s.deleted_at IS NULL`,
    `s.id NOT IN (SELECT student_id FROM student_transport WHERE academic_year = $1 AND status = 'active')`,
  ];
  const values = [academic_year];

  if (search) {
    values.push(`%${search}%`);
    const p = `$${values.length}`;
    conditions.push(`(s.full_name ILIKE ${p} OR s.roll_number ILIKE ${p})`);
  }

  const { rows } = await db.query(
    `SELECT s.id, s.full_name AS student_name,
            s.roll_number,
            c.name || ' – ' || c.section AS class_section
     FROM students s
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.full_name
     LIMIT 100`,
    values
  );
  res.json({ success: true, data: rows });
};

module.exports = {
  getBuses, getBusById, createBus, updateBus, deleteBus,
  getRoutes, getRouteById, createRoute, updateRoute, deleteRoute,
  getStops, addStop, updateStop, deleteStop,
  getAssignments, createAssignment, updateAssignment, deleteAssignment,
  transferStudent, getTransferHistory,
  generatePdf,
  getSummary, getStudentsWithoutTransport,
};
