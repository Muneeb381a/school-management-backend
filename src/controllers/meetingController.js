const pool = require('../db');
const { serverErr } = require('../utils/serverErr');


// POST /meetings/slots
// Accept single object or array of slots. Bulk INSERT.
const createSlots = async (req, res) => {
  try {
    let slots = req.body;
    if (!Array.isArray(slots)) slots = [slots];

    if (slots.length === 0) {
      return res.status(400).json({ success: false, message: 'No slots provided' });
    }

    const inserted = [];
    for (const slot of slots) {
      const { teacher_id, slot_date, start_time, end_time, duration_min, location, academic_year } = slot;
      if (!teacher_id || !slot_date || !start_time || !end_time) {
        return res.status(400).json({ success: false, message: 'teacher_id, slot_date, start_time, end_time are required for each slot' });
      }
      const { rows } = await pool.query(
        `INSERT INTO meeting_slots (teacher_id, slot_date, start_time, end_time, duration_min, location, academic_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [teacher_id, slot_date, start_time, end_time, duration_min || 15,
         location || null, academic_year || '2024-25'],
      );
      inserted.push(rows[0]);
    }

    res.status(201).json({ success: true, data: inserted, message: `${inserted.length} slot(s) created` });
  } catch (err) { serverErr(res, err); }
};

// GET /meetings/slots?teacher_id&date&academic_year
const getSlots = async (req, res) => {
  try {
    const { teacher_id, date, academic_year } = req.query;
    let q = `
      SELECT ms.*, t.full_name AS teacher_name,
             mb.id AS booking_id, mb.parent_name, mb.parent_phone, mb.student_id,
             mb.status AS booking_status,
             s.full_name AS student_name
      FROM meeting_slots ms
      LEFT JOIN teachers t ON t.id = ms.teacher_id
      LEFT JOIN meeting_bookings mb ON mb.slot_id = ms.id AND mb.status = 'confirmed'
      LEFT JOIN students s ON s.id = mb.student_id
      WHERE 1=1
    `;
    const p = [];
    if (teacher_id)    { p.push(teacher_id);    q += ` AND ms.teacher_id=$${p.length}`; }
    if (date)          { p.push(date);           q += ` AND ms.slot_date=$${p.length}`; }
    if (academic_year) { p.push(academic_year);  q += ` AND ms.academic_year=$${p.length}`; }
    q += ' ORDER BY ms.slot_date, ms.start_time';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// DELETE /meetings/slots/:id  (only if not booked)
const deleteSlot = async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      'SELECT is_booked FROM meeting_slots WHERE id=$1', [req.params.id],
    );
    if (!check[0]) return res.status(404).json({ success: false, message: 'Slot not found' });
    if (check[0].is_booked) {
      return res.status(400).json({ success: false, message: 'Cannot delete a booked slot' });
    }
    await pool.query('DELETE FROM meeting_slots WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Slot deleted' });
  } catch (err) { serverErr(res, err); }
};

// POST /meetings/slots/:id/book
const bookSlot = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { student_id, parent_name, parent_phone, parent_email, notes } = req.body;

    if (!student_id) {
      return res.status(400).json({ success: false, message: 'student_id is required' });
    }

    await client.query('BEGIN');

    // 1) Check slot exists and is not booked
    const { rows: slotRows } = await client.query(
      'SELECT * FROM meeting_slots WHERE id=$1 FOR UPDATE', [id],
    );
    if (!slotRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Slot not found' });
    }
    if (slotRows[0].is_booked) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Slot is already booked' });
    }

    // 2) INSERT booking
    const { rows: bookingRows } = await client.query(
      `INSERT INTO meeting_bookings (slot_id, student_id, parent_name, parent_phone, parent_email, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed') RETURNING *`,
      [id, student_id, parent_name || null, parent_phone || null, parent_email || null, notes || null],
    );

    // 3) Mark slot as booked
    await client.query('UPDATE meeting_slots SET is_booked=TRUE WHERE id=$1', [id]);

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: {
        booking: bookingRows[0],
        slot: { ...slotRows[0], is_booked: true },
      },
      message: 'Slot booked successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// PUT /meetings/bookings/:id/cancel
const cancelBooking = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: bookingRows } = await client.query(
      'SELECT * FROM meeting_bookings WHERE id=$1 FOR UPDATE', [req.params.id],
    );
    if (!bookingRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    await client.query(
      `UPDATE meeting_bookings SET status='cancelled', updated_at=NOW() WHERE id=$1`,
      [req.params.id],
    );
    await client.query(
      'UPDATE meeting_slots SET is_booked=FALSE WHERE id=$1',
      [bookingRows[0].slot_id],
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    serverErr(res, err);
  } finally {
    client.release();
  }
};

// GET /meetings/bookings?teacher_id&date&status
const getBookings = async (req, res) => {
  try {
    const { teacher_id, date, status } = req.query;
    let q = `
      SELECT mb.*, ms.slot_date, ms.start_time, ms.end_time, ms.location,
             t.full_name AS teacher_name,
             s.full_name AS student_name, s.roll_number
      FROM meeting_bookings mb
      JOIN meeting_slots ms ON ms.id = mb.slot_id
      JOIN teachers t ON t.id = ms.teacher_id
      LEFT JOIN students s ON s.id = mb.student_id
      WHERE 1=1
    `;
    const p = [];
    if (teacher_id) { p.push(teacher_id); q += ` AND ms.teacher_id=$${p.length}`; }
    if (date)       { p.push(date);       q += ` AND ms.slot_date=$${p.length}`; }
    if (status)     { p.push(status);     q += ` AND mb.status=$${p.length}`; }
    q += ' ORDER BY ms.slot_date, ms.start_time';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) { serverErr(res, err); }
};

// GET /meetings/schedule/print?date&teacher_id
const getMeetingSchedulePrint = async (req, res) => {
  try {
    const { date, teacher_id } = req.query;
    let q = `
      SELECT t.id AS teacher_id, t.full_name AS teacher_name,
             ms.id AS slot_id, ms.slot_date, ms.start_time, ms.end_time, ms.location, ms.is_booked,
             mb.id AS booking_id, mb.parent_name, mb.parent_phone,
             s.full_name AS student_name, s.roll_number
      FROM meeting_slots ms
      JOIN teachers t ON t.id = ms.teacher_id
      LEFT JOIN meeting_bookings mb ON mb.slot_id = ms.id AND mb.status='confirmed'
      LEFT JOIN students s ON s.id = mb.student_id
      WHERE 1=1
    `;
    const p = [];
    if (date)       { p.push(date);       q += ` AND ms.slot_date=$${p.length}`; }
    if (teacher_id) { p.push(teacher_id); q += ` AND ms.teacher_id=$${p.length}`; }
    q += ' ORDER BY t.full_name, ms.start_time';

    const { rows } = await pool.query(q, p);

    // Group by teacher
    const grouped = {};
    for (const row of rows) {
      const key = row.teacher_id;
      if (!grouped[key]) {
        grouped[key] = { teacher_id: key, teacher_name: row.teacher_name, slots: [] };
      }
      grouped[key].slots.push({
        slot_id:      row.slot_id,
        slot_date:    row.slot_date,
        start_time:   row.start_time,
        end_time:     row.end_time,
        location:     row.location,
        is_booked:    row.is_booked,
        booking_id:   row.booking_id,
        parent_name:  row.parent_name,
        parent_phone: row.parent_phone,
        student_name: row.student_name,
        roll_number:  row.roll_number,
      });
    }

    res.json({ success: true, data: Object.values(grouped) });
  } catch (err) { serverErr(res, err); }
};

module.exports = {
  createSlots, getSlots, deleteSlot,
  bookSlot, cancelBooking, getBookings, getMeetingSchedulePrint,
};
