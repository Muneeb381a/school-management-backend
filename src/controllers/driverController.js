/**
 * driverController.js
 * Full CRUD for the drivers table (CNIC, license, phone, address, photo).
 */

const db       = require('../db');
const AppError = require('../utils/AppError');
const { uploadToCloudinary } = require('../middleware/upload');

// GET /transport/drivers
const getDrivers = async (req, res) => {
  const { status, search } = req.query;
  const conds = ['1=1'];
  const vals  = [];
  const push  = v => { vals.push(v); return `$${vals.length}`; };

  if (status) conds.push(`d.status = ${push(status)}`);
  if (search) {
    const p = push(`%${search}%`);
    conds.push(`(d.full_name ILIKE ${p} OR d.cnic ILIKE ${p} OR d.phone ILIKE ${p})`);
  }

  const { rows } = await db.query(
    `SELECT
       d.*,
       b.id          AS bus_id,
       b.bus_number,
       b.vehicle_number,
       b.vehicle_type,
       r.route_name,
       COUNT(st.id)::INT AS assigned_students
     FROM drivers d
     LEFT JOIN buses b ON b.driver_id = d.id AND b.status = 'active'
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = TRUE
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     LEFT JOIN student_transport st ON st.bus_id = b.id AND st.status = 'active'
     WHERE ${conds.join(' AND ')}
     GROUP BY d.id, b.id, b.bus_number, b.vehicle_number, b.vehicle_type, r.route_name
     ORDER BY d.full_name`,
    vals
  );
  res.json({ success: true, data: rows });
};

// GET /transport/drivers/:id
const getDriverById = async (req, res) => {
  const { rows: [driver] } = await db.query(
    `SELECT d.*,
            b.id AS bus_id, b.bus_number, b.vehicle_number,
            b.vehicle_type, b.make_model, b.capacity,
            r.route_name
     FROM drivers d
     LEFT JOIN buses b ON b.driver_id = d.id AND b.status = 'active'
     LEFT JOIN bus_route_assignments bra ON bra.bus_id = b.id AND bra.is_active = TRUE
     LEFT JOIN transport_routes r ON r.id = bra.route_id
     WHERE d.id = $1`,
    [req.params.id]
  );
  if (!driver) throw new AppError('Driver not found', 404);

  // Get students on this driver's bus
  const { rows: students } = await db.query(
    `SELECT st.id, s.full_name AS student_name, s.roll_number,
            c.name || ' – ' || c.section AS class_section,
            rs.stop_name, st.transport_type, st.status
     FROM student_transport st
     JOIN students s ON s.id = st.student_id
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN route_stops rs ON rs.id = st.stop_id
     WHERE st.bus_id = $1 AND st.status = 'active'
     ORDER BY s.full_name`,
    [driver.bus_id ?? -1]   // -1 never matches a real id when driver has no bus
  );

  res.json({ success: true, data: { ...driver, students } });
};

// POST /transport/drivers
const createDriver = async (req, res) => {
  const {
    full_name, cnic, license_number, license_expiry,
    phone, emergency_phone, address, date_of_birth,
    status = 'active', notes, user_id,
  } = req.body;

  if (!full_name?.trim()) throw new AppError('full_name is required', 400);
  if (!phone?.trim())     throw new AppError('phone is required', 400);

  let photo_url = null;
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'drivers/photos', {
        public_id: `driver-${Date.now()}`,
      });
      photo_url = result.secure_url;
    } catch (uploadErr) {
      console.warn('[driver] Cloudinary upload failed on create:', uploadErr.message);
      // Driver is created without a photo rather than failing the whole request
    }
  }

  const { rows } = await db.query(
    `INSERT INTO drivers
       (full_name, cnic, license_number, license_expiry, phone, emergency_phone,
        address, date_of_birth, photo_url, status, notes, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      full_name.trim(),
      cnic?.trim()            || null,
      license_number?.trim()  || null,
      license_expiry          || null,
      phone.trim(),
      emergency_phone?.trim() || null,
      address?.trim()         || null,
      date_of_birth           || null,
      photo_url,
      status,
      notes?.trim()           || null,
      user_id ? Number(user_id) : null,
    ]
  );
  res.status(201).json({ success: true, data: rows[0], message: 'Driver added' });
};

// PUT /transport/drivers/:id
const updateDriver = async (req, res) => {
  const {
    full_name, cnic, license_number, license_expiry,
    phone, emergency_phone, address, date_of_birth,
    status, notes, user_id,
  } = req.body;

  const vals = [
    full_name?.trim()        || null,
    cnic?.trim()             || null,
    license_number?.trim()   || null,
    license_expiry           || null,
    phone?.trim()            || null,
    emergency_phone?.trim()  || null,
    address?.trim()          || null,
    date_of_birth            || null,
    status                   || null,
    notes?.trim()            || null,
    user_id ? Number(user_id) : null,
  ];

  // Photo upload — parameterized to prevent SQL injection
  let photoClause = '';
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'drivers/photos', {
        public_id: `driver-${req.params.id}-${Date.now()}`,
      });
      vals.push(result.secure_url);
      photoClause = `, photo_url = $${vals.length}`;
    } catch (uploadErr) {
      console.warn('[driver] Cloudinary upload failed:', uploadErr.message);
      // Continue update without changing photo
    }
  }

  vals.push(req.params.id);
  const p = vals.length;

  const { rows } = await db.query(
    `UPDATE drivers SET
       full_name       = COALESCE($1,  full_name),
       cnic            = COALESCE($2,  cnic),
       license_number  = COALESCE($3,  license_number),
       license_expiry  = COALESCE($4,  license_expiry),
       phone           = COALESCE($5,  phone),
       emergency_phone = COALESCE($6,  emergency_phone),
       address         = COALESCE($7,  address),
       date_of_birth   = COALESCE($8,  date_of_birth),
       status          = COALESCE($9,  status),
       notes           = COALESCE($10, notes),
       user_id         = COALESCE($11, user_id)
       ${photoClause},
       updated_at      = NOW()
     WHERE id = $${p} RETURNING *`,
    vals
  );
  if (!rows[0]) throw new AppError('Driver not found', 404);
  res.json({ success: true, data: rows[0], message: 'Driver updated' });
};

// DELETE /transport/drivers/:id
const deleteDriver = async (req, res) => {
  // Unlink from any buses first
  await db.query(
    `UPDATE buses SET driver_id = NULL WHERE driver_id = $1`, [req.params.id]
  );
  const { rows } = await db.query(
    'DELETE FROM drivers WHERE id=$1 RETURNING id', [req.params.id]
  );
  if (!rows[0]) throw new AppError('Driver not found', 404);
  res.json({ success: true, message: 'Driver deleted' });
};

module.exports = { getDrivers, getDriverById, createDriver, updateDriver, deleteDriver };
