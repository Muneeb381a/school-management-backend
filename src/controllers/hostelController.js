const db = require('../db');
const AppError = require('../utils/AppError');

// ── Hostels ───────────────────────────────────────────────────────────────────
async function getHostels(req, res) {
  const { rows } = await db.query(
    `SELECT h.*,
            u.name AS warden_name,
            COUNT(DISTINCT r.id) AS room_count,
            COUNT(DISTINCT b.id) FILTER (WHERE b.active = true) AS boarder_count
     FROM hostels h
     LEFT JOIN users u ON u.id = h.warden_id
     LEFT JOIN hostel_rooms r ON r.hostel_id = h.id
     LEFT JOIN hostel_boarders b ON b.room_id = r.id
     GROUP BY h.id, u.name ORDER BY h.name`
  );
  res.json({ success: true, data: rows });
}

async function createHostel(req, res) {
  const { name, type = 'boys', warden_id, address, capacity, notes } = req.body;
  if (!name) throw new AppError('name is required', 400);
  const { rows: [row] } = await db.query(
    `INSERT INTO hostels (name, type, warden_id, address, capacity, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, type, warden_id || null, address || null, capacity || 0, notes || null]
  );
  res.status(201).json({ success: true, data: row });
}

async function updateHostel(req, res) {
  const { name, type, warden_id, address, capacity, notes } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE hostels SET
       name      = COALESCE($1, name),
       type      = COALESCE($2, type),
       warden_id = COALESCE($3, warden_id),
       address   = COALESCE($4, address),
       capacity  = COALESCE($5, capacity),
       notes     = COALESCE($6, notes),
       updated_at = NOW()
     WHERE id = $7 RETURNING *`,
    [name, type, warden_id, address, capacity, notes, req.params.id]
  );
  if (!row) throw new AppError('Hostel not found', 404);
  res.json({ success: true, data: row });
}

async function deleteHostel(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM hostels WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Hostel not found', 404);
  res.json({ success: true, message: 'Hostel deleted' });
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
async function getRooms(req, res) {
  const { hostel_id, status } = req.query;
  const conditions = [];
  const vals = [];
  if (hostel_id) { vals.push(hostel_id); conditions.push(`r.hostel_id = $${vals.length}`); }
  if (status)    { vals.push(status);    conditions.push(`r.status = $${vals.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT r.*,
            h.name AS hostel_name,
            COUNT(b.id) FILTER (WHERE b.active = true) AS current_occupants
     FROM hostel_rooms r
     JOIN hostels h ON h.id = r.hostel_id
     LEFT JOIN hostel_boarders b ON b.room_id = r.id
     ${where}
     GROUP BY r.id, h.name ORDER BY r.hostel_id, r.floor, r.room_number`,
    vals
  );
  res.json({ success: true, data: rows });
}

async function createRoom(req, res) {
  const { hostel_id, room_number, capacity = 2, floor = 1, type = 'dormitory', notes } = req.body;
  if (!hostel_id || !room_number) throw new AppError('hostel_id and room_number are required', 400);
  const { rows: [row] } = await db.query(
    `INSERT INTO hostel_rooms (hostel_id, room_number, capacity, floor, type, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [hostel_id, room_number, capacity, floor, type, notes || null]
  );
  res.status(201).json({ success: true, data: row });
}

async function updateRoom(req, res) {
  const { room_number, capacity, floor, type, status, notes } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE hostel_rooms SET
       room_number = COALESCE($1, room_number),
       capacity    = COALESCE($2, capacity),
       floor       = COALESCE($3, floor),
       type        = COALESCE($4, type),
       status      = COALESCE($5, status),
       notes       = COALESCE($6, notes)
     WHERE id = $7 RETURNING *`,
    [room_number, capacity, floor, type, status, notes, req.params.id]
  );
  if (!row) throw new AppError('Room not found', 404);
  res.json({ success: true, data: row });
}

async function deleteRoom(req, res) {
  const { rows: [row] } = await db.query(
    `DELETE FROM hostel_rooms WHERE id = $1 RETURNING id`, [req.params.id]
  );
  if (!row) throw new AppError('Room not found', 404);
  res.json({ success: true, message: 'Room deleted' });
}

// ── Boarders ──────────────────────────────────────────────────────────────────
async function getBoarders(req, res) {
  const { hostel_id, room_id, active } = req.query;
  const conditions = [];
  const vals = [];

  if (hostel_id) { vals.push(hostel_id); conditions.push(`r.hostel_id = $${vals.length}`); }
  if (room_id)   { vals.push(room_id);   conditions.push(`b.room_id = $${vals.length}`); }
  if (active !== undefined && active !== '') {
    vals.push(active === 'true');
    conditions.push(`b.active = $${vals.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT b.*,
            s.name AS student_name, s.roll_number,
            r.room_number, h.name AS hostel_name
     FROM hostel_boarders b
     JOIN students s ON s.id = b.student_id
     JOIN hostel_rooms r ON r.id = b.room_id
     JOIN hostels h ON h.id = r.hostel_id
     ${where}
     ORDER BY b.active DESC, s.name`,
    vals
  );
  res.json({ success: true, data: rows });
}

async function assignBoarder(req, res) {
  const { student_id, room_id, check_in, notes } = req.body;
  if (!student_id || !room_id) throw new AppError('student_id and room_id are required', 400);

  // Check room capacity
  const { rows: [room] } = await db.query(
    `SELECT r.capacity, COUNT(b.id) AS occupied
     FROM hostel_rooms r
     LEFT JOIN hostel_boarders b ON b.room_id = r.id AND b.active = true
     WHERE r.id = $1 GROUP BY r.capacity`, [room_id]
  );
  if (!room) throw new AppError('Room not found', 404);
  if (room.occupied >= room.capacity) throw new AppError('Room is at full capacity', 400);

  // Deactivate any existing active assignment for this student
  await db.query(
    `UPDATE hostel_boarders SET active = false, check_out = NOW()
     WHERE student_id = $1 AND active = true`, [student_id]
  );

  const { rows: [row] } = await db.query(
    `INSERT INTO hostel_boarders (student_id, room_id, check_in, notes)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [student_id, room_id, check_in || new Date().toISOString().slice(0, 10), notes || null]
  );

  // Update room status if now full
  await db.query(
    `UPDATE hostel_rooms r
     SET status = CASE
       WHEN (SELECT COUNT(*) FROM hostel_boarders WHERE room_id = r.id AND active = true) >= r.capacity THEN 'full'
       ELSE 'available'
     END WHERE r.id = $1`, [room_id]
  );

  res.status(201).json({ success: true, data: row });
}

async function checkOutBoarder(req, res) {
  const { check_out } = req.body;
  const { rows: [row] } = await db.query(
    `UPDATE hostel_boarders
     SET active = false, check_out = $1
     WHERE id = $2 AND active = true RETURNING *`,
    [check_out || new Date().toISOString().slice(0, 10), req.params.id]
  );
  if (!row) throw new AppError('Active boarder record not found', 404);

  // Update room status to available
  await db.query(
    `UPDATE hostel_rooms SET status = 'available' WHERE id = $1`, [row.room_id]
  );

  res.json({ success: true, data: row });
}

// GET /api/hostel/summary
async function getSummary(req, res) {
  const { rows: [stats] } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM hostels) AS total_hostels,
       (SELECT COUNT(*) FROM hostel_rooms) AS total_rooms,
       (SELECT COUNT(*) FROM hostel_rooms WHERE status = 'available') AS available_rooms,
       (SELECT COUNT(*) FROM hostel_boarders WHERE active = true) AS active_boarders`
  );
  const { rows: hostelStats } = await db.query(
    `SELECT h.id, h.name, h.type,
            COUNT(DISTINCT r.id) AS rooms,
            COUNT(DISTINCT b.id) FILTER (WHERE b.active = true) AS boarders,
            h.capacity
     FROM hostels h
     LEFT JOIN hostel_rooms r ON r.hostel_id = h.id
     LEFT JOIN hostel_boarders b ON b.room_id = r.id
     GROUP BY h.id ORDER BY h.name`
  );
  res.json({ success: true, data: { ...stats, by_hostel: hostelStats } });
}

module.exports = {
  getHostels, createHostel, updateHostel, deleteHostel,
  getRooms, createRoom, updateRoom, deleteRoom,
  getBoarders, assignBoarder, checkOutBoarder,
  getSummary,
};
