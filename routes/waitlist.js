const express = require('express');
const router = express.Router();
const { query, loadSettings } = require('../config/db');

function authCheck(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  next();
}

// DEBUG: ทดสอบ query ห้องปัจจุบัน สำหรับ HN ที่ระบุ
router.get('/debug-room/:hn', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query(`
      SELECT hi.an, hi.hn, hi.dchdate, hi.confirm_discharge,
             ia.bedno, ia.roomno,
             rn.name as roomno_name,
             concat(rn.name, ' เตียง ', ia.bedno) as room_display
      FROM ipt hi
      LEFT JOIN iptadm ia ON ia.an = hi.an
      LEFT JOIN roomno rn ON rn.roomno = ia.roomno
      WHERE hi.hn = $1
      ORDER BY hi.an DESC LIMIT 5
    `, [req.params.hn], cfg);
    res.json({ success: true, hn: req.params.hn, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET waiting list
router.get('/', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const showAll = req.query.all === 'true';
    const statusFilter = req.query.status;
    const conditions = [];
    if (statusFilter) conditions.push(`w.status = '${statusFilter.replace(/'/g,"''")}'`);
    else if (!showAll) conditions.push(`w.status = 'waiting'`);
    // ตัดรายการที่ AN มี confirm_discharge = 'Y' แล้วออก
    conditions.push(`(w.an IS NULL OR w.an = '' OR NOT EXISTS (
      SELECT 1 FROM ipt WHERE ipt.an = w.an AND ipt.confirm_discharge = 'Y'
    ))`);
    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await query(`
      SELECT w.*,
        COALESCE(w.roomtype_name, rt.type_name)  AS type_name,
        rt.price_per_day, rt.food_price_per_day,
        COALESCE(w.roomtype_name_2, rt2.type_name) AS type_name_2,
        rt2.price_per_day AS price_per_day_2, rt2.food_price_per_day AS food_price_per_day_2,
        COALESCE(w.roomtype_name_3, rt3.type_name) AS type_name_3,
        rt3.price_per_day AS price_per_day_3, rt3.food_price_per_day AS food_price_per_day_3,
        cur_room.room_name AS current_room_name,
        cur_room.bed_no   AS current_bed_no
      FROM waiting_list w
      LEFT JOIN room_types rt  ON rt.id  = w.room_type_id
      LEFT JOIN room_types rt2 ON rt2.id = w.room_type_id_2
      LEFT JOIN room_types rt3 ON rt3.id = w.room_type_id_3
      LEFT JOIN LATERAL (
        SELECT r.name AS room_name, a.bedno AS bed_no
        FROM ipt i
        LEFT JOIN iptadm a ON a.an = i.an
        LEFT JOIN roomno r ON r.roomno = a.roomno
        WHERE i.hn = w.hn AND r.name IS NOT NULL
        ORDER BY i.an DESC LIMIT 1
      ) cur_room ON TRUE
      ${whereClause}
      ORDER BY w.request_date ASC
    `, [], cfg);
    res.json({ success: true, list: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST add to waiting list
router.post('/', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const {
    hn, patient_name, room_type_id, preferred_room, rights_type, notes, no_pay_reason,
    an, ward, ward_code, doctor_name, roomtype_code, roomtype_name, bedno,
    check_in_date, check_out_date, deposit_amount, contact_name, contact_phone, priority_type
  } = req.body;
  try {
    // ถ้า HN มีอยู่ในคิวรอแล้ว ให้ update แทน insert ใหม่
    const existing = await query(
      `SELECT id FROM waiting_list WHERE hn = $1 AND status = 'waiting' LIMIT 1`,
      [hn], cfg
    );
    if (existing && existing.length > 0) {
      await query(
        `UPDATE waiting_list SET an=$1, patient_name=$2, ward=$3, doctor_name=$4, room_type_id=$5, preferred_room=$6,
         rights_type=$7, notes=$8, contact_name=$9, contact_phone=$10, priority_type=$11,
         roomtype_code=$12, roomtype_name=$13, check_in_date=$14, no_pay_reason=$15,
         request_date=CURRENT_TIMESTAMP WHERE id=$16`,
        [an||null, patient_name, ward||ward_code||null, doctor_name||null,
         room_type_id, preferred_room, rights_type, notes,
         contact_name||null, contact_phone||null, priority_type||null,
         roomtype_code||null, roomtype_name||null, check_in_date||null,
         no_pay_reason||null, existing[0].id],
        cfg
      );
    } else {
      await query(
        `INSERT INTO waiting_list (hn, an, patient_name, ward, doctor_name, room_type_id, preferred_room, rights_type, notes, no_pay_reason, check_in_date, contact_name, contact_phone, priority_type, roomtype_code, roomtype_name, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'waiting',$17)`,
        [hn, an||null, patient_name, ward||ward_code||null, doctor_name||null,
         room_type_id, preferred_room, rights_type, notes, no_pay_reason||null, check_in_date||null,
         contact_name||null, contact_phone||null, priority_type||null,
         roomtype_code||null, roomtype_name||null, req.session.user.login_name],
        cfg
      );
    }

    // INSERT into roomtype_reserve (HIS)
    try {
      const statusRows = await query(
        `SELECT room_reserve_status_id FROM room_reserve_status WHERE hos_guid = 'waiting' LIMIT 1`,
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
            reserve_date, reserve_time, room_reserve_status_id)
         VALUES (get_serialnumber('roomtype_reserve_id'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [hn, an||null, contact_name||null, contact_phone||null,
         ward_code||null, roomtype_code||null, bedno||null,
         estAdmDate, check_out_date||null,
         deposit_amount ? parseFloat(deposit_amount) : null,
         notes||null, reserveDate, reserveTime, statusId],
        cfg
      );
    } catch {}

    req.io.emit('waitlist_updated');
    res.json({ success: true, message: 'เพิ่มในคิวรอเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH confirm from waitlist (assign room)
router.patch('/:id/confirm', authCheck, async (req, res) => {
  const cfg = loadSettings();
  const { room_id, room_number, check_in_date, check_out_date } = req.body;
  try {
    const rows = await query('SELECT * FROM waiting_list WHERE id = $1', [req.params.id], cfg);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลในคิว' });
    const item = rows[0];

    // Create booking
    await query(
      `INSERT INTO bookings (hn, patient_name, room_id, room_number, room_type_id, check_in_date, check_out_date, rights_type, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10)`,
      [item.hn, item.patient_name, room_id, room_number, item.room_type_id,
       check_in_date, check_out_date, item.rights_type, item.notes, req.session.user.login_name],
      cfg
    );
    // Update room status
    await query(`UPDATE rooms SET status = 'reserved' WHERE id = $1`, [room_id], cfg);
    // Remove from waitlist
    await query(`UPDATE waiting_list SET status = 'assigned' WHERE id = $1`, [req.params.id], cfg);

    req.io.emit('room_updated');
    req.io.emit('waitlist_updated');
    res.json({ success: true, message: 'จัดห้องให้ผู้ป่วยเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH ยืนยันเข้าพักแล้ว (checkedin) — เปลี่ยน status + อัพ roomtype_reserve status = 2
router.patch('/:id/checkedin', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const rows = await query('SELECT * FROM waiting_list WHERE id = $1', [req.params.id], cfg);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
    const item = rows[0];

    await query(`UPDATE waiting_list SET status = 'checkedin' WHERE id = $1`, [req.params.id], cfg);

    // อัพ roomtype_reserve → room_reserve_status_id = 2
    try {
      const isPg = cfg.db_type === 'postgresql';
      if (isPg) {
        await query(
          `UPDATE roomtype_reserve SET room_reserve_status_id = 2
           WHERE roomtype_reserve_id = (
             SELECT roomtype_reserve_id FROM roomtype_reserve
             WHERE hn = $1 AND ($2::text = '' OR an = $2)
             ORDER BY roomtype_reserve_id DESC LIMIT 1
           )`,
          [item.hn, item.an || ''], cfg
        );
      } else {
        await query(
          `UPDATE roomtype_reserve SET room_reserve_status_id = 2
           WHERE hn = ? AND (? = '' OR an = ?)
           ORDER BY roomtype_reserve_id DESC LIMIT 1`,
          [item.hn, item.an || '', item.an || ''], cfg
        );
      }
    } catch {}

    req.io.emit('waitlist_updated');
    res.json({ success: true, message: 'ยืนยันเข้าพักแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE / cancel from waitlist
router.patch('/:id/cancel', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await query(`UPDATE waiting_list SET status = 'cancelled' WHERE id = $1`, [req.params.id], cfg);
    req.io.emit('waitlist_updated');
    res.json({ success: true, message: 'ยกเลิกคิวรอเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH cancel all waiting entries by HN (called after booking success)
router.patch('/by-hn/:hn/assign', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await query(
      `UPDATE waiting_list SET status = 'assigned' WHERE hn = $1 AND status = 'waiting'`,
      [req.params.hn], cfg
    );
    req.io.emit('waitlist_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
