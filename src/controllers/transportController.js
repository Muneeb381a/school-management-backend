const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// ══════════════════════════════════════════════════════════════
//  BUSES
// ══════════════════════════════════════════════════════════════

// GET /api/transport/buses
const getBuses = async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? `WHERE b.status = $1` : '';
    const vals  = status ? [status] : [];

    const { rows } = await pool.query(
      `SELECT
         b.*,
         r.id   AS assigned_route_id,
         r.route_name,
         bra.academic_year AS assigned_year,
         COUNT(st.id)::INT AS assigned_students
       FROM buses b
       LEFT JOIN bus_route_assignments bra
         ON bra.bus_id = b.id AND bra.is_active = TRUE
       LEFT JOIN transport_routes r ON r.id = bra.route_id
       LEFT JOIN student_transport st
         ON st.bus_id = b.id AND st.status = 'active'
         AND st.academic_year = bra.academic_year
       ${where}
       GROUP BY b.id, r.id, r.route_name, bra.academic_year
       ORDER BY b.bus_number`,
      vals
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// GET /api/transport/buses/:id
const getBusById = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*,
         r.route_name,
         bra.academic_year AS assigned_year,
         COUNT(st.id)::INT AS assigned_students
       FROM buses b
       LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = TRUE
       LEFT JOIN transport_routes r ON r.id = bra.route_id
       LEFT JOIN student_transport st
         ON st.bus_id = b.id AND st.status = 'active'
         AND st.academic_year = bra.academic_year
       WHERE b.id = $1
       GROUP BY b.id, r.route_name, bra.academic_year`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// POST /api/transport/buses
const createBus = async (req, res) => {
  try {
    const {
      bus_number, vehicle_number, capacity, make_model,
      manufacture_year, driver_name, driver_phone, driver_license,
      status = 'active', notes,
    } = req.body;

    if (!bus_number?.trim())    return res.status(400).json({ success: false, message: 'bus_number is required' });
    if (!vehicle_number?.trim())return res.status(400).json({ success: false, message: 'vehicle_number is required' });
    if (!capacity || capacity <= 0) return res.status(400).json({ success: false, message: 'capacity must be > 0' });

    const { rows } = await pool.query(
      `INSERT INTO buses
         (bus_number, vehicle_number, capacity, make_model, manufacture_year,
          driver_name, driver_phone, driver_license, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        bus_number.trim(), vehicle_number.trim(), Number(capacity),
        make_model || null, manufacture_year ? Number(manufacture_year) : null,
        driver_name || null, driver_phone || null, driver_license || null,
        status, notes || null,
      ]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Bus added' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Bus number or vehicle number already exists' });
    serverErr(res, err);
  }
};

// PUT /api/transport/buses/:id
const updateBus = async (req, res) => {
  try {
    const {
      bus_number, vehicle_number, capacity, make_model,
      manufacture_year, driver_name, driver_phone, driver_license,
      status, notes,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE buses SET
         bus_number       = COALESCE($1,  bus_number),
         vehicle_number   = COALESCE($2,  vehicle_number),
         capacity         = COALESCE($3,  capacity),
         make_model       = COALESCE($4,  make_model),
         manufacture_year = COALESCE($5,  manufacture_year),
         driver_name      = COALESCE($6,  driver_name),
         driver_phone     = COALESCE($7,  driver_phone),
         driver_license   = COALESCE($8,  driver_license),
         status           = COALESCE($9,  status),
         notes            = COALESCE($10, notes),
         updated_at       = NOW()
       WHERE id = $11 RETURNING *`,
      [
        bus_number?.trim() || null, vehicle_number?.trim() || null,
        capacity ? Number(capacity) : null,
        make_model || null, manufacture_year ? Number(manufacture_year) : null,
        driver_name || null, driver_phone || null, driver_license || null,
        status || null, notes || null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.json({ success: true, data: rows[0], message: 'Bus updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Bus number or vehicle number already exists' });
    serverErr(res, err);
  }
};

// DELETE /api/transport/buses/:id
const deleteBus = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM buses WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.json({ success: true, message: 'Bus deleted' });
  } catch (err) {
    if (err.code === '23503')
      return res.status(409).json({ success: false, message: 'Cannot delete: bus has student assignments' });
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/transport/routes
const getRoutes = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         r.*,
         COUNT(DISTINCT rs.id)::INT  AS total_stops,
         COUNT(DISTINCT st.id)::INT  AS assigned_students,
         b.bus_number,
         b.id AS bus_id
       FROM transport_routes r
       LEFT JOIN route_stops rs ON rs.route_id = r.id
       LEFT JOIN bus_route_assignments bra
         ON bra.route_id = r.id AND bra.is_active = TRUE
       LEFT JOIN buses b ON b.id = bra.bus_id
       LEFT JOIN student_transport st
         ON st.route_id = r.id AND st.status = 'active'
       GROUP BY r.id, b.bus_number, b.id
       ORDER BY r.route_name`
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// GET /api/transport/routes/:id
const getRouteById = async (req, res) => {
  try {
    const [routeRes, stopsRes, studentsRes] = await Promise.all([
      pool.query(
        `SELECT r.*, b.bus_number, b.id AS bus_id, b.driver_name
         FROM transport_routes r
         LEFT JOIN bus_route_assignments bra ON bra.route_id = r.id AND bra.is_active = TRUE
         LEFT JOIN buses b ON b.id = bra.bus_id
         WHERE r.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_order`,
        [req.params.id]
      ),
      pool.query(
        `SELECT st.id, s.first_name||' '||s.last_name AS student_name,
                s.roll_number, rs.stop_name, b.bus_number, st.transport_type, st.status
         FROM student_transport st
         JOIN students s ON s.id = st.student_id
         LEFT JOIN route_stops rs ON rs.id = st.stop_id
         JOIN buses b ON b.id = st.bus_id
         WHERE st.route_id = $1 AND st.status = 'active'
         ORDER BY s.first_name`,
        [req.params.id]
      ),
    ]);
    if (!routeRes.rows[0]) return res.status(404).json({ success: false, message: 'Route not found' });
    res.json({
      success: true,
      data: { ...routeRes.rows[0], stops: stopsRes.rows, students: studentsRes.rows },
    });
  } catch (err) { serverErr(res, err); }
};

// POST /api/transport/routes
const createRoute = async (req, res) => {
  try {
    const { route_name, description, start_point, end_point, estimated_time, distance_km } = req.body;
    if (!route_name?.trim())  return res.status(400).json({ success: false, message: 'route_name is required' });
    if (!start_point?.trim()) return res.status(400).json({ success: false, message: 'start_point is required' });
    if (!end_point?.trim())   return res.status(400).json({ success: false, message: 'end_point is required' });

    const { rows } = await pool.query(
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
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Route name already exists' });
    serverErr(res, err);
  }
};

// PUT /api/transport/routes/:id
const updateRoute = async (req, res) => {
  try {
    const { route_name, description, start_point, end_point, estimated_time, distance_km, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE transport_routes SET
         route_name      = COALESCE($1, route_name),
         description     = COALESCE($2, description),
         start_point     = COALESCE($3, start_point),
         end_point       = COALESCE($4, end_point),
         estimated_time  = COALESCE($5, estimated_time),
         distance_km     = COALESCE($6, distance_km),
         is_active       = COALESCE($7, is_active),
         updated_at      = NOW()
       WHERE id = $8 RETURNING *`,
      [
        route_name?.trim() || null, description || null,
        start_point?.trim() || null, end_point?.trim() || null,
        estimated_time ? Number(estimated_time) : null,
        distance_km ? Number(distance_km) : null,
        is_active != null ? is_active : null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Route not found' });
    res.json({ success: true, data: rows[0], message: 'Route updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Route name already exists' });
    serverErr(res, err);
  }
};

// DELETE /api/transport/routes/:id
const deleteRoute = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM transport_routes WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Route not found' });
    res.json({ success: true, message: 'Route deleted' });
  } catch (err) {
    if (err.code === '23503')
      return res.status(409).json({ success: false, message: 'Cannot delete: route has student assignments' });
    serverErr(res, err);
  }
};

// ══════════════════════════════════════════════════════════════
//  ROUTE STOPS
// ══════════════════════════════════════════════════════════════

// GET /api/transport/routes/:routeId/stops
const getStops = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rs.*, COUNT(st.id)::INT AS student_count
       FROM route_stops rs
       LEFT JOIN student_transport st ON st.stop_id = rs.id AND st.status = 'active'
       WHERE rs.route_id = $1
       GROUP BY rs.id
       ORDER BY rs.stop_order`,
      [req.params.routeId]
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /api/transport/routes/:routeId/stops
const addStop = async (req, res) => {
  try {
    const { stop_name, stop_order, pickup_time, dropoff_time, landmark } = req.body;
    if (!stop_name?.trim()) return res.status(400).json({ success: false, message: 'stop_name is required' });
    if (!stop_order)        return res.status(400).json({ success: false, message: 'stop_order is required' });

    const { rows } = await pool.query(
      `INSERT INTO route_stops
         (route_id, stop_name, stop_order, pickup_time, dropoff_time, landmark)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        req.params.routeId, stop_name.trim(), Number(stop_order),
        pickup_time || null, dropoff_time || null, landmark || null,
      ]
    );
    res.status(201).json({ success: true, data: rows[0], message: 'Stop added' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Stop order already exists for this route' });
    serverErr(res, err);
  }
};

// PUT /api/transport/stops/:id
const updateStop = async (req, res) => {
  try {
    const { stop_name, stop_order, pickup_time, dropoff_time, landmark } = req.body;
    const { rows } = await pool.query(
      `UPDATE route_stops SET
         stop_name    = COALESCE($1, stop_name),
         stop_order   = COALESCE($2, stop_order),
         pickup_time  = COALESCE($3, pickup_time),
         dropoff_time = COALESCE($4, dropoff_time),
         landmark     = COALESCE($5, landmark)
       WHERE id = $6 RETURNING *`,
      [
        stop_name?.trim() || null, stop_order ? Number(stop_order) : null,
        pickup_time || null, dropoff_time || null, landmark || null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Stop not found' });
    res.json({ success: true, data: rows[0], message: 'Stop updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Stop order conflict' });
    serverErr(res, err);
  }
};

// DELETE /api/transport/stops/:id
const deleteStop = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM route_stops WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Stop not found' });
    res.json({ success: true, message: 'Stop deleted' });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  STUDENT TRANSPORT ASSIGNMENTS
// ══════════════════════════════════════════════════════════════

// GET /api/transport/assignments
// Query: route_id, bus_id, academic_year, status, search
const getAssignments = async (req, res) => {
  try {
    const { route_id, bus_id, student_id, academic_year = '2024-25', status, search } = req.query;
    const conditions = ['st.academic_year = $1'];
    const values = [academic_year];
    const push = (v) => { values.push(v); return `$${values.length}`; };

    if (route_id)   conditions.push(`st.route_id = ${push(Number(route_id))}`);
    if (bus_id)     conditions.push(`st.bus_id = ${push(Number(bus_id))}`);
    if (student_id) conditions.push(`st.student_id = ${push(Number(student_id))}`);
    if (status)     conditions.push(`st.status = ${push(status)}`);
    if (search)   conditions.push(
      `(s.first_name ILIKE ${push(`%${search}%`)} OR s.last_name ILIKE $${values.length} OR s.roll_number ILIKE $${values.length})`
    );

    const { rows } = await pool.query(
      `SELECT
         st.id,
         st.student_id,
         s.first_name || ' ' || s.last_name   AS student_name,
         s.roll_number,
         c.class_name || ' – ' || c.section   AS class_section,
         r.id AS route_id, r.route_name,
         rs.id AS stop_id, rs.stop_name, rs.pickup_time, rs.dropoff_time,
         b.id AS bus_id, b.bus_number, b.driver_name, b.driver_phone,
         st.transport_type, st.status, st.academic_year,
         st.monthly_fee, st.fee_status,
         st.assigned_date, st.notes
       FROM student_transport st
       JOIN students s ON s.id = st.student_id
       LEFT JOIN classes c ON c.id = s.class_id
       JOIN transport_routes r ON r.id = st.route_id
       LEFT JOIN route_stops rs ON rs.id = st.stop_id
       JOIN buses b ON b.id = st.bus_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.first_name, s.last_name`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// POST /api/transport/assignments
const createAssignment = async (req, res) => {
  try {
    const {
      student_id, route_id, stop_id, bus_id,
      academic_year = '2024-25', transport_type = 'both',
      monthly_fee, notes,
    } = req.body;

    if (!student_id) return res.status(400).json({ success: false, message: 'student_id is required' });
    if (!route_id)   return res.status(400).json({ success: false, message: 'route_id is required' });
    if (!bus_id)     return res.status(400).json({ success: false, message: 'bus_id is required' });

    // Capacity check
    const { rows: capRows } = await pool.query(
      `SELECT b.capacity,
              (SELECT COUNT(*) FROM student_transport
               WHERE bus_id=$1 AND academic_year=$2 AND status='active') AS current_count
       FROM buses b WHERE b.id=$1`,
      [Number(bus_id), academic_year]
    );
    if (capRows[0] && Number(capRows[0].current_count) >= Number(capRows[0].capacity)) {
      return res.status(400).json({ success: false, message: 'Bus is at full capacity' });
    }

    const { rows } = await pool.query(
      `INSERT INTO student_transport
         (student_id, route_id, stop_id, bus_id, academic_year,
          transport_type, monthly_fee, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        Number(student_id), Number(route_id), stop_id ? Number(stop_id) : null,
        Number(bus_id), academic_year, transport_type,
        monthly_fee ? Number(monthly_fee) : null, notes || null,
      ]
    );

    // Return full joined row
    const { rows: full } = await pool.query(
      `SELECT st.*, s.first_name||' '||s.last_name AS student_name,
              r.route_name, rs.stop_name, b.bus_number
       FROM student_transport st
       JOIN students s ON s.id=st.student_id
       JOIN transport_routes r ON r.id=st.route_id
       LEFT JOIN route_stops rs ON rs.id=st.stop_id
       JOIN buses b ON b.id=st.bus_id
       WHERE st.id=$1`,
      [rows[0].id]
    );
    res.status(201).json({ success: true, data: full[0], message: 'Student assigned to transport' });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Student already has a transport assignment for this year' });
    serverErr(res, err);
  }
};

// PUT /api/transport/assignments/:id
const updateAssignment = async (req, res) => {
  try {
    const {
      route_id, stop_id, bus_id, status,
      transport_type, monthly_fee, fee_status, notes,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE student_transport SET
         route_id        = COALESCE($1, route_id),
         stop_id         = COALESCE($2, stop_id),
         bus_id          = COALESCE($3, bus_id),
         status          = COALESCE($4, status),
         transport_type  = COALESCE($5, transport_type),
         monthly_fee     = COALESCE($6, monthly_fee),
         fee_status      = COALESCE($7, fee_status),
         notes           = COALESCE($8, notes),
         updated_at      = NOW()
       WHERE id = $9 RETURNING id`,
      [
        route_id ? Number(route_id) : null,
        stop_id  ? Number(stop_id)  : null,
        bus_id   ? Number(bus_id)   : null,
        status || null, transport_type || null,
        monthly_fee ? Number(monthly_fee) : null,
        fee_status || null, notes || null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Assignment not found' });
    res.json({ success: true, message: 'Assignment updated' });
  } catch (err) { serverErr(res, err); }
};

// DELETE /api/transport/assignments/:id
const deleteAssignment = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM student_transport WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Assignment not found' });
    res.json({ success: true, message: 'Assignment removed' });
  } catch (err) { serverErr(res, err); }
};

// ══════════════════════════════════════════════════════════════
//  DASHBOARD SUMMARY
// ══════════════════════════════════════════════════════════════
const getSummary = async (req, res) => {
  try {
    const { academic_year = '2024-25' } = req.query;

    const [busRes, routeRes, assignRes, occupancyRes] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::INT AS count FROM buses GROUP BY status`),
      pool.query(`SELECT COUNT(*)::INT AS total FROM transport_routes WHERE is_active=TRUE`),
      pool.query(
        `SELECT COUNT(*)::INT AS total_assigned,
                COUNT(*) FILTER (WHERE status='active')::INT AS active,
                COUNT(*) FILTER (WHERE status='inactive')::INT AS inactive
         FROM student_transport WHERE academic_year=$1`,
        [academic_year]
      ),
      pool.query(
        `SELECT b.bus_number, b.capacity, b.driver_name, b.status AS bus_status,
                r.route_name,
                COUNT(st.id)::INT AS assigned_students,
                ROUND(COUNT(st.id)*100.0/NULLIF(b.capacity,0),1) AS occupancy_pct
         FROM buses b
         LEFT JOIN bus_route_assignments bra ON bra.bus_id=b.id AND bra.is_active=TRUE
         LEFT JOIN transport_routes r ON r.id=bra.route_id
         LEFT JOIN student_transport st ON st.bus_id=b.id
           AND st.status='active' AND st.academic_year=$1
         GROUP BY b.id, r.route_name
         ORDER BY occupancy_pct DESC NULLS LAST`,
        [academic_year]
      ),
    ]);

    const busByStatus = {};
    busRes.rows.forEach(r => { busByStatus[r.status] = r.count; });

    res.json({
      success: true,
      data: {
        buses:        { total: busRes.rows.reduce((a, r) => a + r.count, 0), by_status: busByStatus },
        routes:       routeRes.rows[0],
        assignments:  assignRes.rows[0],
        occupancy:    occupancyRes.rows,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// GET /api/transport/students-without-transport?academic_year=
const getStudentsWithoutTransport = async (req, res) => {
  try {
    const { academic_year = '2024-25', search } = req.query;
    const conditions = [
      `s.status = 'active'`,
      `s.id NOT IN (
        SELECT student_id FROM student_transport WHERE academic_year=$1
      )`,
    ];
    const values = [academic_year];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(
        `(s.first_name ILIKE $${values.length} OR s.last_name ILIKE $${values.length} OR s.roll_number ILIKE $${values.length})`
      );
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.first_name||' '||s.last_name AS student_name,
              s.roll_number, c.class_name||' – '||c.section AS class_section
       FROM students s
       LEFT JOIN classes c ON c.id=s.class_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.first_name, s.last_name
       LIMIT 100`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  getBuses, getBusById, createBus, updateBus, deleteBus,
  getRoutes, getRouteById, createRoute, updateRoute, deleteRoute,
  getStops, addStop, updateStop, deleteStop,
  getAssignments, createAssignment, updateAssignment, deleteAssignment,
  getSummary, getStudentsWithoutTransport,
};
