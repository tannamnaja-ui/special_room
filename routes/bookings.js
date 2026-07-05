const express = require('express');
const router = express.Router();
const { query, loadSettings } = require('../config/db');

function authCheck(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  next();
}

function genBookingRef(id) {
  const now = new Date();
  const y = String(now.getFullYear()).slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `BK${y}${m}${d}${String(id).padStart(4, '0')}`;
}

// Search patients (modal) — by HN or name
router.get('/patient-search', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json({ success: true, patients: [] });
  const like = `%${q.trim()}%`;
  try {
    let patients = null;
    const queries = [
      `SELECT hn, concat(pname,fname,' ',lname) as patient_name FROM patient WHERE hn LIKE $1 OR fname LIKE $1 OR lname LIKE $1 ORDER BY hn LIMIT 30`,
      `SELECT hn, concat(fname,' ',lname) as patient_name FROM patient WHERE hn LIKE $1 OR fname LIKE $1 OR lname LIKE $1 ORDER BY hn LIMIT 30`,
    ];
    for (const sql of queries) {
      try {
        const rows = await query(sql, [like], cfg);
        if (rows !== null) { patients = rows; break; }
      } catch {}
    }
    res.json({ success: true, patients: patients || [] });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Search admissions (modal) — by AN or HN or name (ipt only active)
router.get('/admission-search', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json({ success: true, admissions: [] });
  const like = `%${q.trim()}%`;
  try {
    let admissions = null;
    const queries = [
      `SELECT i.an, i.hn, concat(p.pname,p.fname,' ',p.lname) as patient_name, to_char(i.regdate,'DD/MM/YY') as admit_date
       FROM ipt i LEFT OUTER JOIN patient p ON p.hn = i.hn
       WHERE i.dchdate IS NULL AND (i.an LIKE $1 OR i.hn LIKE $1 OR p.fname LIKE $1 OR p.lname LIKE $1)
       ORDER BY i.regdate DESC LIMIT 30`,
      `SELECT i.an, i.hn, concat(p.fname,' ',p.lname) as patient_name, i.regdate::text as admit_date
       FROM ipt i LEFT OUTER JOIN patient p ON p.hn = i.hn
       WHERE i.dchdate IS NULL AND (i.an LIKE $1 OR i.hn LIKE $1 OR p.fname LIKE $1 OR p.lname LIKE $1)
       ORDER BY i.regdate DESC LIMIT 30`,
    ];
    for (const sql of queries) {
      try {
        const rows = await query(sql, [like], cfg);
        if (rows !== null) { admissions = rows; break; }
      } catch {}
    }
    res.json({ success: true, admissions: admissions || [] });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Search patient by HN
router.get('/patient/:hn', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { hn } = req.params;
  try {
    let patient = null;
    const queries = [
      `SELECT hn, concat(pname,fname,' ',lname) as patient_name FROM patient WHERE hn = $1 LIMIT 1`,
      `SELECT hn, concat(fname,' ',lname) as patient_name FROM patient WHERE hn = $1 LIMIT 1`,
    ];
    for (const sql of queries) {
      try {
        const rows = await query(sql, [hn], cfg);
        if (rows && rows.length > 0) { patient = rows[0]; break; }
      } catch {}
    }
    if (patient) return res.json({ success: true, patient });
    res.json({ success: false, message: 'ไม่พบข้อมูลผู้ป่วย HN: ' + hn });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Get ward + doctor from AN (single call)
router.get('/info-by-an/:an', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { an } = req.params;
  try {
    const [wardRows, doctorRows, rightsRows] = await Promise.all([
      query(
        `SELECT w.name as ward_name FROM ipt i LEFT OUTER JOIN ward w ON w.ward = i.ward WHERE i.an = $1 LIMIT 1`,
        [an], cfg
      ),
      query(
        `SELECT d.name as doctor_name FROM ipt i
         LEFT JOIN ipt_doctor_list dl ON dl.an = i.an
         LEFT JOIN doctor d ON d.code = dl.doctor
         WHERE i.an = $1 AND dl.active_doctor = 'Y' LIMIT 1`,
        [an], cfg
      ),
      query(
        `SELECT p.pttype as rights_code, p.name as rights_name FROM ipt i
         LEFT JOIN pttype p ON p.pttype = i.pttype
         WHERE i.an = $1 LIMIT 1`,
        [an], cfg
      )
    ]);
    const r = rightsRows?.[0];
    const rightsDisplay = r ? [r.rights_code, r.rights_name].filter(Boolean).join(' ') : null;
    res.json({
      success:     true,
      ward_name:   wardRows?.[0]?.ward_name    || null,
      doctor_name: doctorRows?.[0]?.doctor_name || null,
      rights_name: rightsDisplay
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Get ward name from AN
router.get('/ward-by-an/:an', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { an } = req.params;
  try {
    const rows = await query(
      `SELECT w.name as ward_name FROM ipt i LEFT OUTER JOIN ward w ON w.ward = i.ward WHERE i.an = $1 LIMIT 1`,
      [an], cfg
    );
    if (rows && rows.length > 0 && rows[0].ward_name)
      return res.json({ success: true, ward_name: rows[0].ward_name });
    res.json({ success: false, message: 'ไม่พบข้อมูล Ward' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Search patient rights by HN
router.get('/rights/:hn', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { hn } = req.params;
  try {
    let rights = null;
    const queries = [
      `SELECT hn, main_right as rights_type FROM patient_pttype WHERE hn = $1 AND del = 'N' ORDER BY id DESC LIMIT 1`,
      `SELECT hn, pttype as rights_type FROM pt_pttype WHERE hn = $1 LIMIT 1`,
      `SELECT hn, pttype as rights_type FROM patient WHERE hn = $1 LIMIT 1`,
    ];
    for (const sql of queries) {
      try {
        const rows = await query(sql, [hn], cfg);
        if (rows && rows.length > 0) { rights = rows[0]; break; }
      } catch {}
    }
    if (rights) {
      try {
        const nameRows = await query(
          `SELECT pttype, name FROM pttype WHERE pttype = $1 LIMIT 1`,
          [rights.rights_type], cfg
        );
        if (nameRows?.[0]?.name) {
          rights.rights_display = [nameRows[0].pttype, nameRows[0].name].filter(Boolean).join(' ');
        } else {
          rights.rights_display = rights.rights_type;
        }
      } catch { rights.rights_display = rights.rights_type; }
      return res.json({ success: true, rights });
    }
    res.json({ success: false, message: 'ไม่พบข้อมูลสิทธิ์การรักษา' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// GET current occupants from HIS
router.get('/occupants', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(`
      SELECT w.name as ward, rt.name as roomtype, b.bedno, r.ward as ward_code,
             tmp.an, i.regdate,
             concat(p.pname, p.fname, '  ', p.lname) as ptname,
             dd.name as doctor,
             EXISTS (
               SELECT 1 FROM bookings bk
               WHERE bk.room_number = b.bedno
                 AND bk.status = 'reserved'
             ) as has_next_reserve
      FROM bedno b
      LEFT OUTER JOIN roomno r ON b.roomno = r.roomno
      LEFT OUTER JOIN roomtype rt ON rt.roomtype = r.roomtype
      LEFT OUTER JOIN ward w ON r.ward = w.ward
      LEFT JOIN (
        SELECT bedno, d.an, ipt.regdate, ipt.dchdate
        FROM iptadm d
        LEFT OUTER JOIN ipt ON d.an = ipt.an
        WHERE ipt.dchdate IS NULL
      ) tmp ON b.bedno = tmp.bedno
      LEFT OUTER JOIN ipt i ON i.an = tmp.an
      LEFT OUTER JOIN patient p ON p.hn = i.hn
      LEFT OUTER JOIN ipt_doctor_list idl ON idl.an = i.an
      LEFT OUTER JOIN doctor dd ON dd.code = idl.doctor AND idl.active_doctor = 'Y'
      WHERE b.bed_status_type_id = 1
        AND r.name NOT LIKE '%รอรับ%'
        AND rt.hos_guid = 'Y'
        AND w.ward_active = 'Y'
        AND tmp.an IS NOT NULL
        AND (
          COALESCE(NULL, '') = ''
          OR (NULL = 'NULL' AND w.spclty IS NULL)
          OR w.spclty LIKE CONCAT('%', NULL, '%')
        )
      GROUP BY w.name, rt.name, b.bedno, r.ward, tmp.an, i.regdate,
               p.pname, p.fname, p.lname, dd.name
      ORDER BY w.name, rt.name, b.bedno
    `, [], cfg);
    res.json({ success: true, occupants: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET bookings for a specific bedno (right panel)
router.get('/room-bookings/:bedno', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(`
      SELECT b.booking_ref, b.an, b.patient_name, b.doctor_name,
             b.check_in_date, b.check_out_date, b.rights_type,
             b.ward, b.status, b.notes
      FROM bookings b
      WHERE b.room_number = $1
        AND b.status IN ('reserved','occupied')
      ORDER BY b.check_in_date ASC
    `, [req.params.bedno], cfg);
    res.json({ success: true, bookings: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET all wards from HIS for booking form
router.get('/his-wards', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(`
      SELECT w.ward, w.name
      FROM roomtype rt
      LEFT OUTER JOIN roomno r ON r.roomtype = rt.roomtype
      LEFT OUTER JOIN ward w ON w.ward = r.ward
      WHERE rt.hos_guid = 'Y'
      GROUP BY w.ward, w.name
      ORDER BY w.name
    `, [], cfg);
    res.json({ success: true, wards: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET all room types from HIS for booking form
router.get('/his-roomtypes', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(`
      SELECT roomtype, name FROM roomtype
      WHERE hos_guid = 'Y'
      ORDER BY name
    `, [], cfg);
    res.json({ success: true, roomtypes: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET available beds from HIS — ward optional, roomtype required
router.get('/his-beds', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { ward, roomtype } = req.query;
  if (!roomtype) return res.json({ success: true, beds: [] });
  try {
    let sql, params;
    if (ward) {
      sql = `
        SELECT b.bedno
        FROM bedno b
        JOIN roomno r ON b.roomno = r.roomno
        LEFT JOIN (
          SELECT bedno FROM iptadm d
          JOIN ipt ON d.an = ipt.an
          WHERE ipt.dchdate IS NULL
        ) occ ON b.bedno = occ.bedno
        LEFT JOIN bookings bk ON bk.room_number = b.bedno AND bk.status IN ('reserved','occupied')
        WHERE r.ward = $1
          AND r.roomtype = $2
          AND b.bed_status_type_id = 1
          AND r.name NOT LIKE '%รอรับ%'
          AND occ.bedno IS NULL
          AND bk.id IS NULL
        ORDER BY b.bedno`;
      params = [ward, roomtype];
    } else {
      sql = `
        SELECT b.bedno
        FROM bedno b
        JOIN roomno r ON b.roomno = r.roomno
        LEFT JOIN (
          SELECT bedno FROM iptadm d
          JOIN ipt ON d.an = ipt.an
          WHERE ipt.dchdate IS NULL
        ) occ ON b.bedno = occ.bedno
        LEFT JOIN bookings bk ON bk.room_number = b.bedno AND bk.status IN ('reserved','occupied')
        WHERE r.roomtype = $1
          AND b.bed_status_type_id = 1
          AND r.name NOT LIKE '%รอรับ%'
          AND occ.bedno IS NULL
          AND bk.id IS NULL
        ORDER BY b.bedno`;
      params = [roomtype];
    }
    const rows = await query(sql, params, cfg);
    res.json({ success: true, beds: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET priority types for booking form
router.get('/priority-types', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(
      `SELECT room_priority_type_name as name FROM room_priority_type ORDER BY room_priority_type_id`,
      [], cfg
    );
    res.json({ success: true, types: rows });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// GET all active bookings
router.get('/', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(`
      SELECT b.*, rt.type_name, rt.price_per_day, rt.food_price_per_day
      FROM bookings b
      LEFT JOIN room_types rt ON b.room_type_id = rt.id
      WHERE b.status NOT IN ('cancelled','checked_out')
      ORDER BY b.created_at DESC
    `, [], cfg);
    res.json({ success: true, bookings: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create booking
router.post('/', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const {
    hn, an, patient_name, ward, doctor_name,
    room_id, room_number, room_type_id,
    check_in_date, check_out_date,
    rights_type, deposit_amount, contact_name, contact_phone,
    priority_type, notes,
    ward_code, roomtype_code,
    waiting_list_id
  } = req.body;

  try {
    // Double-booking check: by room_id or room_number
    const dupRows = room_id
      ? await query(`SELECT id FROM bookings WHERE room_id = $1 AND status IN ('reserved','occupied') LIMIT 1`, [room_id], cfg)
      : await query(`SELECT id FROM bookings WHERE room_number = $1 AND status IN ('reserved','occupied') LIMIT 1`, [room_number], cfg);
    if (dupRows && dupRows.length > 0)
      return res.status(409).json({ success: false, message: 'ห้องนี้ถูกจองแล้ว กรุณาเลือกห้องอื่นหรือเพิ่มในคิวรอ' });

    // Insert booking (without booking_ref first)
    await query(
      `INSERT INTO bookings
        (hn, an, patient_name, ward, doctor_name, room_id, room_number, room_type_id,
         check_in_date, check_out_date, rights_type, deposit_amount,
         contact_name, contact_phone, priority_type, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'reserved',$17)`,
      [hn, an||null, patient_name, ward||null, doctor_name||null,
       room_id, room_number, room_type_id,
       check_in_date, check_out_date||null,
       rights_type||null, deposit_amount||0,
       contact_name||null, contact_phone||null,
       priority_type||null, notes||null,
       req.session.user.login_name],
      cfg
    );

    // Get inserted ID and set booking_ref
    const last = await query(
      `SELECT id FROM bookings WHERE hn = $1 AND room_id = $2 ORDER BY id DESC LIMIT 1`,
      [hn, room_id], cfg
    );
    if (last && last.length > 0) {
      const newId = last[0].id;
      const ref = genBookingRef(newId);
      await query(`UPDATE bookings SET booking_ref = $1 WHERE id = $2`, [ref, newId], cfg);
    }

    if (room_id) await query(`UPDATE rooms SET status = 'reserved', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [room_id], cfg);

    // INSERT into roomtype_reserve (HIS)
    let hisWarning = null;
    try {
      const statusRows = await query(
        `SELECT room_reserve_status_id FROM room_reserve_status WHERE hos_guid = 'reserved' LIMIT 1`,
        [], cfg
      );
      let statusId = statusRows?.[0]?.room_reserve_status_id ?? null;
      if (!statusId) {
        const fallback = await query(
          `SELECT room_reserve_status_id FROM room_reserve_status ORDER BY room_reserve_status_id LIMIT 1`,
          [], cfg
        );
        statusId = fallback?.[0]?.room_reserve_status_id ?? null;
      }
      const now = new Date();
      const reserveDate = now.toISOString().split('T')[0];
      const reserveTime = now.toTimeString().slice(0, 8);
      const estAdmDate  = check_in_date ? check_in_date.split('T')[0] : null;
      await query(
        `INSERT INTO roomtype_reserve
           (roomtype_reserve_id, hn, an, contact_person, contact_phone, ward, roomtype, bedno,
            est_adm_date, est_dch_date, deposit, reserve_note,
            reserve_date, reserve_time, room_reserve_status_id, waiting_list_id)
         VALUES (get_serialnumber('roomtype_reserve_id'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [hn, an||null, contact_name||null, contact_phone||null,
         ward_code||null, roomtype_code||null, room_number||null,
         estAdmDate, check_out_date||null,
         deposit_amount ? parseFloat(deposit_amount) : null,
         notes||null, reserveDate, reserveTime, statusId,
         waiting_list_id ? parseInt(waiting_list_id) : null],
        cfg
      );
    } catch (e) {
      hisWarning = `บันทึกหลักสำเร็จ แต่บันทึก roomtype_reserve ไม่สำเร็จ: ${e.message}`;
    }

    // Update waiting_list status to 'reserved' if came from waitlist
    if (waiting_list_id) {
      try {
        await query(
          `UPDATE waiting_list SET status = 'reserved' WHERE id = $1`,
          [parseInt(waiting_list_id)], cfg
        );
      } catch (e) {}
    }

    req.io.emit('room_updated');
    res.json({ success: true, message: 'บันทึกการจองเรียบร้อย', warning: hisWarning });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH check-in
router.patch('/:id/checkin', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id], cfg);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการจอง' });
    const booking = rows[0];
    await query(
      `UPDATE bookings SET status = 'occupied', actual_check_in = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.id], cfg
    );
    await query(`UPDATE rooms SET status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [booking.room_id], cfg);
    req.io.emit('room_updated');
    res.json({ success: true, message: 'Check-in เรียบร้อย' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH pending discharge (แจ้งกำลังจะ Discharge)
router.patch('/:id/pending-discharge', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id], cfg);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการจอง' });
    const booking = rows[0];
    await query(`UPDATE rooms SET status = 'pending_discharge', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [booking.room_id], cfg);
    req.io.emit('room_updated');
    res.json({ success: true, message: 'อัปเดตสถานะ: กำลังจะจำหน่าย' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH check-out
router.patch('/:id/checkout', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id], cfg);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการจอง' });
    const booking = rows[0];
    await query(
      `UPDATE bookings SET status = 'checked_out', actual_check_out = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.id], cfg
    );
    await query(`UPDATE rooms SET status = 'cleaning', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [booking.room_id], cfg);
    req.io.emit('room_updated');
    res.json({ success: true, message: 'Check-out เรียบร้อย ห้องอยู่ระหว่างทำความสะอาด' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH cancel
router.patch('/:id/cancel', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id], cfg);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลการจอง' });
    const booking = rows[0];
    await query(`UPDATE bookings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id], cfg);
    await query(`UPDATE rooms SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [booking.room_id], cfg);
    req.io.emit('room_updated');
    res.json({ success: true, message: 'ยกเลิกการจองเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
