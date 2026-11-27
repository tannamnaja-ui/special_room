const express = require('express');
const router = express.Router();
const { query, loadSettings } = require('../config/db');
const { ensureTables } = require('./rooms');

function authCheck(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  next();
}

// เติมเงื่อนไขช่วงวันที่ลง WHERE แบบไดนามิก (from/to เป็น optional query string YYYY-MM-DD)
function dateRangeClause(col, from, to, params) {
  let clause = '';
  if (from) { params.push(from + ' 00:00:00'); clause += ` AND ${col} >= $${params.length}`; }
  if (to)   { params.push(to + ' 23:59:59');   clause += ` AND ${col} <= $${params.length}`; }
  return clause;
}

// เติมเงื่อนไขกรอง ward (ward code จากตาราง ward) — ward ว่าง/ไม่ส่งมา = ทุก ward
function wardClause(col, ward, params) {
  if (!ward) return '';
  params.push(ward);
  return ` AND ${col} = $${params.length}`;
}

// รายได้ = ราคาห้อง (room_types.price_per_day ที่ผูกกับการจอง) x จำนวนคืนที่พักจริง (actual_check_in -> actual_check_out)
// นับเฉพาะการจองที่มีการเข้าพักจริงแล้ว (actual_check_in ไม่ว่าง) — ถ้ายังไม่ออก (checked_out) ใช้เวลาปัจจุบันคำนวณคืนที่ผ่านมาแล้ว
// ward ของแต่ละการจอง อิงจากห้อง/เตียงที่ใช้จริง (bookings.room_number -> bedno -> roomno -> ward) ไม่ใช่ ward ต้นสังกัดของผู้ป่วย
const STAY_CTE = `
  WITH stay AS (
    SELECT b.*, rt.price_per_day, rt.type_name, w.ward as ward_code, w.name as ward_name,
           GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(b.actual_check_out, NOW()) - b.actual_check_in)) / 86400.0)) AS nights
    FROM bookings b
    LEFT JOIN room_types rt ON b.room_type_id = rt.id
    LEFT JOIN bedno bn ON bn.bedno = b.room_number
    LEFT JOIN roomno rn ON rn.roomno = bn.roomno
    LEFT JOIN ward w ON w.ward = rn.ward
    WHERE b.actual_check_in IS NOT NULL
  )
`;

// 1) สรุประยะเวลาการส่งซ่อม
router.get('/repair-duration', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await ensureTables(cfg);
    const { from, to, ward } = req.query;
    const params = [4];
    let where = dateRangeClause('h.start_date', from, to, params);
    where += wardClause('w.ward', ward, params);
    const rows = await query(`
      SELECT h.*, rn.name as room_name, w.name as ward_name
      FROM bed_status_history h
      LEFT JOIN bedno b ON b.bedno = h.bedno
      LEFT JOIN roomno rn ON rn.roomno = b.roomno
      LEFT JOIN ward w ON w.ward = rn.ward
      WHERE h.status_type_id = $1 ${where}
      ORDER BY h.start_date DESC
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2) สรุประยะเวลาการใช้ห้องพิเศษเป็นห้องแยกโรค
router.get('/isolation-duration', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await ensureTables(cfg);
    const { from, to, ward } = req.query;
    const params = [5];
    let where = dateRangeClause('h.start_date', from, to, params);
    where += wardClause('w.ward', ward, params);
    const rows = await query(`
      SELECT h.*, rn.name as room_name, w.name as ward_name
      FROM bed_status_history h
      LEFT JOIN bedno b ON b.bedno = h.bedno
      LEFT JOIN roomno rn ON rn.roomno = b.roomno
      LEFT JOIN ward w ON w.ward = rn.ward
      WHERE h.status_type_id = $1 ${where}
      ORDER BY h.start_date DESC
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// รายได้จาก AN จริง (ข้อมูล HIS) = ราคาห้องพิเศษจริง (nondrugitems.price ผ่าน bedno.room_charge_icode) x จำนวนวันนอน (an_stat.admdate)
// นับเฉพาะ AN ที่เคยเข้าพักเตียงที่เป็น "ห้องพิเศษ" (bedtype.hos_guid='Y') อย่างน้อย 1 เตียง — ถ้าเข้าพักหลายเตียงในหนึ่ง AN ใช้เตียงล่าสุด (iptadm.indate ล่าสุด) เป็นตัวแทนราคาห้อง
// เดือนอิงจากวันที่จำหน่าย (dchdate) เพราะเป็นวันที่ปิดการรักษา/ทราบจำนวนวันนอนที่แน่นอนแล้ว — นับเฉพาะ AN ที่จำหน่ายแล้ว (dchdate ไม่ว่าง)
const AN_REVENUE_CTE = `
  WITH an_special_bed AS (
    SELECT DISTINCT ON (i.an) i.an, i.bedno, i.roomno, rn.ward
    FROM iptadm i
    JOIN bedno bn ON bn.bedno = i.bedno
    JOIN bedtype bt ON bt.bedtype = bn.bedtype
    LEFT JOIN roomno rn ON rn.roomno = i.roomno
    WHERE bt.hos_guid = 'Y'
    ORDER BY i.an, i.indate DESC
  ),
  an_revenue AS (
    SELECT a.an, a.hn, a.dchdate, a.regdate, a.admdate as days, a.pttype,
           asb.bedno, w.ward as ward_code, w.name as ward_name,
           nd.price as room_price,
           a.admdate * COALESCE(nd.price,0) as revenue
    FROM an_stat a
    JOIN an_special_bed asb ON asb.an = a.an
    LEFT JOIN bedno bn2 ON bn2.bedno = asb.bedno
    LEFT JOIN nondrugitems nd ON nd.icode = bn2.room_charge_icode
    LEFT JOIN ward w ON w.ward = asb.ward
    WHERE a.dchdate IS NOT NULL AND a.admdate IS NOT NULL
  )
`;

// 3) สรุปรายได้ต่อเดือนของการใช้ห้องพิเศษ
// ถ้าผู้ใช้เลือกช่วงวันที่ (from/to) จะแจงเป็นรายวันตามวันที่ที่เลือกแทนการเหมารวมเป็นเดือน — ถ้าไม่เลือกวันที่เลย (ดูทั้งหมด) จะสรุปเป็นรายเดือนตามปกติ
router.get('/monthly-revenue', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('dchdate', from, to, params);
    where += wardClause('ward_code', ward, params);
    const groupedByDay = !!(from || to);
    const groupExpr = groupedByDay ? `TO_CHAR(dchdate, 'YYYY-MM-DD')` : `TO_CHAR(dchdate, 'YYYY-MM')`;
    const rows = await query(`
      ${AN_REVENUE_CTE}
      SELECT ${groupExpr} as month,
             COUNT(*) as bookings_count,
             SUM(days) as nights,
             SUM(revenue) as revenue
      FROM an_revenue
      WHERE 1=1 ${where}
      GROUP BY ${groupExpr}
      ORDER BY month
    `, params, cfg);
    res.json({ success: true, rows, groupedByDay });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// วันที่เข้า-ออกแต่ละห้องพิเศษจริง มาจากตาราง iptbedmove (ประวัติการย้ายเตียง) เพราะ iptadm.indate/outdate ว่างเปล่าทั้งตารางในเครื่องนี้
// แต่ละแถวใน iptbedmove คือ 1 เหตุการณ์ย้ายเข้าเตียง nbedno — "วันที่ออก" ของแต่ละช่วงคือเวลาย้ายครั้งถัดไปของ AN เดียวกัน (LEAD) หรือถ้าเป็นเตียงล่าสุด ใช้วันที่จำหน่าย (an_stat.dchdate) หรือเวลาปัจจุบันถ้ายังไม่จำหน่าย
const ROOM_STAY_CTE = `
  WITH moves AS (
    SELECT an, nbedno as bedno, nroomno as roomno, nward as ward,
           (movedate + movetime) as move_at,
           LEAD(movedate + movetime) OVER (PARTITION BY an ORDER BY movedate, movetime) as next_move_at
    FROM iptbedmove
    WHERE movedate IS NOT NULL AND nbedno IS NOT NULL AND nbedno <> ''
  ),
  room_stay AS (
    SELECT m.an, m.bedno, m.roomno, rn.name as room_name, w.ward as ward_code, w.name as ward_name,
           m.move_at as indate,
           COALESCE(m.next_move_at, a.dchdate::timestamp, NOW()) as outdate,
           nd.price as room_price,
           GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(m.next_move_at, a.dchdate::timestamp, NOW()) - m.move_at)) / 86400.0)) as nights
    FROM moves m
    JOIN bedno bn ON bn.bedno = m.bedno
    JOIN bedtype bt ON bt.bedtype = bn.bedtype
    LEFT JOIN nondrugitems nd ON nd.icode = bn.room_charge_icode
    LEFT JOIN an_stat a ON a.an = m.an
    LEFT JOIN ward w ON w.ward = m.ward
    LEFT JOIN roomno rn ON rn.roomno = m.roomno
    WHERE bt.hos_guid = 'Y'
  ),
  -- แตกแต่ละช่วงการเข้าพักออกเป็น "รายวัน" แล้วตัดวันซ้ำทิ้ง (DISTINCT an + เตียง + วันที่)
  -- เพราะ HIS มีการบันทึกย้ายเตียงซ้ำ/ย้ายไป-กลับในวันเดียวกัน ถ้านับตามช่วงเวลาจะได้วันนอนเกินจริง
  -- เช่น AN ที่ถูกบันทึกเข้าเตียงเดิม 3 ครั้งในวันเดียว จะกลายเป็น 3 วัน ทั้งที่อยู่จริงวันเดียว
  room_days AS (
    SELECT DISTINCT rs.an, rs.bedno, rs.roomno, rs.room_name, rs.ward_code, rs.ward_name,
           rs.room_price, d::date AS stay_date
    FROM room_stay rs,
         LATERAL generate_series(rs.indate::date, rs.outdate::date, interval '1 day') d
  )
`;

// 4) สรุปจำนวนห้องที่ใช้ และรายได้รวมต่อห้อง — group ตามห้อง (bedno) จากประวัติการย้ายเตียงจริง (iptbedmove)
// จำนวนวันนอน = จำนวนวันที่ผู้ป่วยอยู่ในเตียงพิเศษนั้นจริง นับแบบไม่ซ้ำวัน (ดู room_days)
// ช่วงวันที่ที่เลือกกรองที่ "วันที่อยู่ในห้อง" จึงนับเฉพาะวันที่ตกอยู่ในช่วงนั้น แม้การเข้าพักจะคร่อมช่วง
router.get('/rooms-revenue', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('stay_date', from, to, params);
    where += wardClause('ward_code', ward, params);
    const rows = await query(`
      ${ROOM_STAY_CTE}
      SELECT bedno as room_number, roomno, room_name,
             COUNT(DISTINCT an) as bookings_count,
             COUNT(*) as nights,
             SUM(COALESCE(room_price,0)) as revenue
      FROM room_days
      WHERE 1=1 ${where}
      GROUP BY bedno, roomno, room_name
      ORDER BY revenue DESC
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// รายได้จริงของห้องพิเศษ — จากตาราง opitemrece (รายการเรียกเก็บจริงของ HIS) กรอง icode = ราคาห้องของเตียงพิเศษ
// เตียงพิเศษหลายเตียงอาจใช้ room_charge_icode เดียวกัน (ราคาห้องเดียวกัน) จึงต้องหาว่า AN นั้นนอนเตียงไหนจริงจาก iptbedmove (ใช้เตียงล่าสุดถ้าย้ายหลายครั้ง) เพื่อไม่ให้รายได้ซ้ำซ้อนข้ามเตียง
// paidst กรองต่างกันตามรายงาน: '01'/'03' = ชำระเองเบิกได้/เบิกไม่ได้ (เงินสดจริงจากผู้ป่วย) ส่วน '02' = ลูกหนี้สิทธิ (ยอดที่เบิกได้จากสิทธิ/ประกัน ไม่ใช่เงินสดจากผู้ป่วย)
function buildPaidRevenueCte(paidstList) {
  const paidstSql = paidstList.map(p => `'${p}'`).join(',');
  return `
  WITH special_beds AS (
    SELECT bn.bedno, bn.room_charge_icode, bn.roomno
    FROM bedno bn
    JOIN bedtype bt ON bt.bedtype = bn.bedtype
    WHERE bt.hos_guid = 'Y' AND bn.room_charge_icode IS NOT NULL
  ),
  an_bed AS (
    SELECT DISTINCT ON (i.an) i.an, i.nbedno as bedno
    FROM iptbedmove i
    JOIN special_beds sb ON sb.bedno = i.nbedno
    ORDER BY i.an, (i.movedate + i.movetime) DESC
  ),
  paid_charges AS (
    SELECT ab.bedno, w.ward as ward_code, w.name as ward_name, o.sum_price, o.vstdate, o.vsttime, o.paidst,
           o.pttype, COALESCE(pt.name, 'ไม่ระบุสิทธิ') as pttype_name
    FROM opitemrece o
    JOIN an_bed ab ON ab.an = o.an
    JOIN special_beds sb ON sb.bedno = ab.bedno AND sb.room_charge_icode = o.icode
    LEFT JOIN roomno rn ON rn.roomno = sb.roomno
    LEFT JOIN ward w ON w.ward = rn.ward
    LEFT JOIN pttype pt ON pt.pttype = o.pttype
    WHERE o.paidst IN (${paidstSql})
  )
`;
}

// paidst 01/03 = จ่ายเงินสดจริงจากผู้ป่วย — ใช้กับรายงาน "รายได้จริงของห้องพิเศษ(ชำระเงิน)"
const PAID_REVENUE_CTE = buildPaidRevenueCte(['01', '03']);
// paidst 02 = ลูกหนี้สิทธิ (ยอดที่เบิกได้ตามสิทธิ/ประกัน) — ใช้กับรายงาน "จำนวนจ่ายห้องของแต่ละกลุ่มสิทธิ"
const RIGHTS_REVENUE_CTE = buildPaidRevenueCte(['02']);
// รวมทั้ง 3 รหัส (01/02/03) ไว้ในชุดเดียว แล้วแยกยอดด้วย FILTER ตอน query — ใช้กับรายงานที่ต้องโชว์ทั้งสองยอดคู่กัน เช่น "รายได้วันหยุด/วันธรรมดา"
const COMBINED_PAID_CTE = buildPaidRevenueCte(['01', '02', '03']);

// 5) สรุปรายได้จริงของห้องพิเศษ (ชำระเงิน) — นับตามเตียง
router.get('/total-revenue', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('vstdate', from, to, params);
    where += wardClause('ward_code', ward, params);
    const totalRows = await query(`
      ${PAID_REVENUE_CTE}
      SELECT COUNT(*) as bookings_count, SUM(sum_price) as revenue
      FROM paid_charges
      WHERE 1=1 ${where}
    `, params, cfg);
    const byBedRows = await query(`
      ${PAID_REVENUE_CTE}
      SELECT bedno as room_number, COUNT(*) as bookings_count, SUM(sum_price) as revenue
      FROM paid_charges
      WHERE 1=1 ${where}
      GROUP BY bedno
      ORDER BY revenue DESC
    `, params, cfg);
    res.json({ success: true, total: totalRows[0] || {}, byBed: byBedRows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6) สรุประยะเวลารอคอยการจองห้องพิเศษ — นับตั้งแต่ "เข้าคิว" (waiting_list.request_date) จนถึง "ได้ห้อง"
// เวลาได้ห้องเลือกจากแหล่งที่แม่นที่สุดที่มี ตามลำดับ (got_room_source):
//   his             = ครั้งแรกที่ถูกย้ายเข้าเตียงพิเศษจริง (iptbedmove) — จับคู่ด้วย AN ในคิว ถ้าคิวไม่มี AN (จองก่อน admit)
//                     ใช้ HN หา admission ของคนไข้คนนั้นที่ย้ายเข้าเตียงพิเศษหลังเวลาเข้าคิว
//   checkedin       = เวลากด "ยืนยันเข้าพัก" ในแอป
//   assigned        = เวลาจัดห้อง/บันทึกจองในแอป (waiting_list.assigned_at)
//   booking         = เวลาสร้างรายการจองในตาราง bookings ของคนไข้คนนั้นหลังเข้าคิว (ข้อมูลเก่าที่ยังไม่มี assigned_at)
//   admitted_common = ยังไม่มีหลักฐานได้ห้องพิเศษเลย แต่คนไข้ถูก Admit เป็นผู้ป่วยในแล้ว (มี AN, ipt.dchdate ยังว่าง)
//                     แปลว่ากำลังนอนเตียงสามัญรออยู่ — ต้องนับรวมเป็น "กำลังรอ" ไม่ใช่หายไปจากรายงาน
// เดิมนับเฉพาะคิวที่มี AN และมีประวัติย้ายเข้าเตียงพิเศษใน iptbedmove ทำให้คนไข้ที่จองแล้วได้ห้อง
// (จองก่อน admit จึงไม่มี AN / admit เข้าเตียงพิเศษตรง ๆ ไม่มีประวัติย้าย / ยังไม่ได้ย้ายเข้าเตียงใน HIS) หายจากรายงาน
const GOT_ROOM_STATUSES = `('reserved','assigned','checkedin')`;

// LATERAL ชุดนี้ใช้ร่วมกันทั้ง waiting-duration และ daily-booking-volume เพื่อหา "ได้ห้องหรือยัง" ของแต่ละแถวคิว (wl)
// แยก 2 LATERAL (ตาม AN / ตาม HN) แทนการใช้ OR ใน WHERE เดียว เพื่อให้ใช้ index ของ iptbedmove.an / ipt.hn ได้
const GOT_ROOM_JOINS_SQL = `
  LEFT JOIN LATERAL (
    SELECT i.an, (i.movedate + i.movetime) as move_at, i.nbedno as bedno, i.nroomno as roomno
    FROM iptbedmove i
    JOIN bedno bn ON bn.bedno = i.nbedno
    JOIN bedtype bt ON bt.bedtype = bn.bedtype
    WHERE i.an = TRIM(wl.an) AND bt.hos_guid = 'Y' AND i.movedate IS NOT NULL
    ORDER BY i.movedate, i.movetime
    LIMIT 1
  ) hm_an ON NULLIF(TRIM(wl.an), '') IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT i.an, (i.movedate + i.movetime) as move_at, i.nbedno as bedno, i.nroomno as roomno
    FROM ipt ip
    JOIN iptbedmove i ON i.an = ip.an
    JOIN bedno bn ON bn.bedno = i.nbedno
    JOIN bedtype bt ON bt.bedtype = bn.bedtype
    WHERE ip.hn = wl.hn AND bt.hos_guid = 'Y' AND i.movedate IS NOT NULL
      AND (i.movedate + i.movetime) >= wl.request_date
    ORDER BY i.movedate, i.movetime
    LIMIT 1
  ) hm_hn ON NULLIF(TRIM(wl.an), '') IS NULL
  CROSS JOIN LATERAL (
    SELECT COALESCE(hm_an.an, hm_hn.an) as an, COALESCE(hm_an.move_at, hm_hn.move_at) as move_at,
           COALESCE(hm_an.bedno, hm_hn.bedno) as bedno, COALESCE(hm_an.roomno, hm_hn.roomno) as roomno
  ) hm
  LEFT JOIN LATERAL (
    SELECT b.created_at, b.room_number
    FROM bookings b
    WHERE b.hn = wl.hn AND b.created_at >= wl.request_date AND COALESCE(b.status, '') <> 'cancelled'
    ORDER BY b.created_at
    LIMIT 1
  ) bk ON wl.status IN ${GOT_ROOM_STATUSES}
  -- คนไข้ที่ Admit แล้ว (มี AN, ยังไม่จำหน่าย) แต่ยังไม่มีหลักฐานได้ห้องพิเศษเลยจาก hm/bk ข้างบน — กำลังรออยู่ที่เตียงสามัญ
  LEFT JOIN LATERAL (
    SELECT i.an
    FROM ipt i
    WHERE i.dchdate IS NULL
      AND (i.an = NULLIF(TRIM(wl.an), '') OR (NULLIF(TRIM(wl.an), '') IS NULL AND i.hn = wl.hn AND i.regdate >= wl.request_date))
    ORDER BY i.regdate DESC
    LIMIT 1
  ) admit ON TRUE
`;

router.get('/waiting-duration', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await ensureTables(cfg);
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('wl.request_date', from, to, params);
    where += wardClause('w.ward', ward, params);
    const rows = await query(`
      SELECT wl.id, COALESCE(NULLIF(TRIM(wl.an), ''), hm.an, admit.an) as an, wl.hn, wl.patient_name, wl.ward, wl.roomtype_name,
             wl.status, wl.request_date, wl.check_in_date,
             COALESCE(hm.move_at, wl.checkedin_at, wl.assigned_at, bk.created_at) as got_room_at,
             CASE WHEN hm.move_at IS NOT NULL THEN 'his'
                  WHEN wl.checkedin_at IS NOT NULL THEN 'checkedin'
                  WHEN wl.assigned_at IS NOT NULL THEN 'assigned'
                  WHEN bk.created_at IS NOT NULL THEN 'booking'
                  WHEN admit.an IS NOT NULL THEN 'admitted_common'
             END as got_room_source,
             COALESCE(hm.bedno, bk.room_number) as room_number, w.name as room_ward_name,
             EXTRACT(EPOCH FROM (COALESCE(hm.move_at, wl.checkedin_at, wl.assigned_at, bk.created_at,
               CASE WHEN admit.an IS NOT NULL THEN NOW() END) - wl.request_date)) as wait_seconds
      FROM waiting_list wl
      ${GOT_ROOM_JOINS_SQL}
      LEFT JOIN bedno rb ON rb.bedno = COALESCE(hm.bedno, bk.room_number)
      LEFT JOIN roomno rn ON rn.roomno = COALESCE(hm.roomno, rb.roomno)
      LEFT JOIN ward w ON w.ward = rn.ward
      WHERE (hm.move_at IS NOT NULL OR wl.status IN ${GOT_ROOM_STATUSES} OR admit.an IS NOT NULL) ${where}
      ORDER BY wl.request_date DESC
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6b) สรุปยอดการจองรายวัน/เดือน — จำนวนคนไข้ที่เข้าคิวจอง เทียบกับจำนวนที่ได้ห้องพิเศษแล้ว vs ยังรออยู่ พร้อมอัตราได้ห้อง
// ใช้เงื่อนไข "ได้ห้องแล้วหรือยัง" ชุดเดียวกับรายงานระยะเวลารอคอย (GOT_ROOM_JOINS_SQL) เพื่อให้ตัวเลขสองรายงานตรงกัน
// group ตามวันที่ถ้าเลือกช่วงวันที่ (from/to) เหมือนรายงานรายได้รายเดือน ถ้าไม่เลือกช่วงจะสรุปเป็นรายเดือนแทน
router.get('/daily-booking-volume', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await ensureTables(cfg);
    const { from, to } = req.query;
    const params = [];
    const where = dateRangeClause('wl.request_date', from, to, params);
    const groupedByDay = !!(from || to);
    const groupExpr = groupedByDay ? `TO_CHAR(wl.request_date, 'YYYY-MM-DD')` : `TO_CHAR(wl.request_date, 'YYYY-MM')`;
    const rows = await query(`
      SELECT ${groupExpr} as period,
             COUNT(*) as requested_count,
             COUNT(*) FILTER (WHERE hm.move_at IS NOT NULL OR wl.status IN ${GOT_ROOM_STATUSES}) as got_room_count,
             COUNT(*) FILTER (WHERE hm.move_at IS NULL AND wl.status NOT IN ${GOT_ROOM_STATUSES}) as waiting_count
      FROM waiting_list wl
      ${GOT_ROOM_JOINS_SQL}
      WHERE 1=1 ${where}
      GROUP BY ${groupExpr}
      ORDER BY period
    `, params, cfg);
    res.json({ success: true, rows, groupedByDay });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6c) สรุปประเภทห้อง(ราคา)ที่มีการจองมากที่สุด เรียงจากมากไปน้อย — นับจากรายการจองจริงในตาราง bookings (ไม่ว่าสถานะปัจจุบันจะเป็นอะไร)
router.get('/roomtype-popularity', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    await ensureTables(cfg);
    const { from, to } = req.query;
    const params = [];
    const bkDateWhere = dateRangeClause('b.created_at', from, to, params);
    const rows = await query(`
      SELECT rt.id, rt.type_name, rt.price_per_day, rt.food_price_per_day,
             COUNT(b.id) as bookings_count
      FROM room_types rt
      LEFT JOIN bookings b ON b.room_type_id = rt.id ${bkDateWhere}
      GROUP BY rt.id, rt.type_name, rt.price_per_day, rt.food_price_per_day
      ORDER BY bookings_count DESC, rt.price_per_day DESC
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7) สรุปจำนวนจ่ายห้องของแต่ละกลุ่มสิทธิการรักษา — สิทธิไหนใช้ห้องพิเศษไปเท่าไหร่ และราคาที่จ่ายจริงตามสิทธินั้น (opitemrece.pttype ผูกกับผู้จ่ายจริง ไม่ใช่ an_stat.pttype ที่เป็นสิทธิหลักตอน admit)
router.get('/rights-summary', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('vstdate', from, to, params);
    where += wardClause('ward_code', ward, params);
    const rows = await query(`
      ${RIGHTS_REVENUE_CTE}
      SELECT pttype_name as rights_type,
             COUNT(*) as bookings_count, SUM(sum_price) as revenue
      FROM paid_charges
      WHERE 1=1 ${where}
      GROUP BY pttype_name
      ORDER BY revenue DESC
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8) สรุปรายได้วันหยุด/วันธรรมดา — สรุปแค่รายได้ แยกตามวันทั้ง 7 วัน (จันทร์-อาทิตย์) ไม่แยกตามเตียง
// แสดง 2 ยอดคู่กัน: "ราคาเบิกได้ตามสิทธิ" (paidst=02) และ "ราคาที่ต้องชำระ" (paidst 01,03)
router.get('/holiday-weekday-revenue', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('vstdate', from, to, params);
    where += wardClause('ward_code', ward, params);
    const rows = await query(`
      ${COMBINED_PAID_CTE}
      SELECT EXTRACT(ISODOW FROM vstdate)::int as dow,
             SUM(sum_price) FILTER (WHERE paidst = '02') as claimable_revenue,
             SUM(sum_price) FILTER (WHERE paidst IN ('01','03')) as payable_revenue
      FROM paid_charges
      WHERE 1=1 ${where}
      GROUP BY EXTRACT(ISODOW FROM vstdate)
      ORDER BY dow
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 9) สรุปรายได้ตามเวร เช้า(08:00-15:59) บ่าย(16:00-23:59) ดึก(00:00-07:59) — อิงเวลาที่เรียกเก็บจริง (opitemrece.vsttime)
// แสดง 2 ยอดคู่กัน: "ราคาเบิกได้ตามสิทธิ" (paidst=02) และ "ราคาที่ต้องชำระ" (paidst 01,03)
router.get('/shift-revenue', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    let where = dateRangeClause('vstdate', from, to, params);
    where += wardClause('ward_code', ward, params);
    // หมายเหตุ: ห้ามใส่ emoji ในค่า string ของ SQL — DB connection ใช้ client encoding WIN874 (ภาษาไทย) เข้ารหัส emoji (UTF8 4-byte) ไม่ได้ ทำให้ query error
    const shiftExpr = `CASE
        WHEN EXTRACT(HOUR FROM vsttime) >= 8 AND EXTRACT(HOUR FROM vsttime) < 16 THEN 'เช้า (08:00-15:59)'
        WHEN EXTRACT(HOUR FROM vsttime) >= 16 THEN 'บ่าย (16:00-23:59)'
        ELSE 'ดึก (00:00-07:59)'
      END`;
    const rows = await query(`
      ${COMBINED_PAID_CTE}
      SELECT ${shiftExpr} as shift,
             SUM(sum_price) FILTER (WHERE paidst = '02') as claimable_revenue,
             SUM(sum_price) FILTER (WHERE paidst IN ('01','03')) as payable_revenue
      FROM paid_charges
      WHERE 1=1 ${where}
      GROUP BY ${shiftExpr}
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 10) สรุปข้อมูลรวมตามเตียง — ทุกคอลัมน์มาจากรายการเรียกเก็บจริงใน opitemrece ล้วน ๆ (เฉพาะคืนที่มีรายการบิลจริงแล้วเท่านั้น
// ทั้งจำนวนคืนและราคา — คืนที่ยังไม่ถึงรอบออกบิลจะไม่ถูกนับเลยไม่ว่าคอลัมน์ไหน):
// "จำนวนคืนที่นอน" = SUM(qty) ของรายการค่าห้อง (1 รายการอาจครอบคลุมหลายคืนถ้าออกบิลเป็นรอบ ไม่ใช่ราย 1 คืนเสมอไป)
// "ราคาเต็ม" = ผลรวมทุกรายการที่ถูกออกบิลแล้ว (paidst 00/01/02/03/04 ทั้งหมด รวมที่ยังค้างชำระด้วย)
// claimable/payable/discount คือยอดย่อยของราคาเต็ม แยกตามสถานะจ่ายเงิน (paidst) จึงรวมกันแล้วอาจไม่เท่าราคาเต็มถ้ายังมีค้างชำระ (paidst=00) เหลืออยู่
// "ราคาส่วนลด" นับ 2 แหล่งรวมกัน แล้วหักออกจาก "ราคาที่ต้องชำระ":
//   1) opitemrece.discount — จำนวนเงินส่วนลดที่บันทึกไว้กับรายการเรียกเก็บ
//   2) pttype_items_price_inc.discount_percent — ส่วนลดเป็น % ตามสิทธิ คิดจาก inc_cover_price (ต่อคืน) x จำนวนคืน
router.get('/bed-full-summary', authCheck, async (req, res) => {
  const cfg = loadSettings();
  try {
    const { from, to, ward } = req.query;
    const params = [];
    const where = dateRangeClause('vstdate', from, to, params) + wardClause('ward_code', ward, params);
    const rows = await query(`
      WITH special_beds AS (
        SELECT bn.bedno, bn.room_charge_icode, bn.roomno, nd.price as rate_per_night
        FROM bedno bn
        JOIN bedtype bt ON bt.bedtype = bn.bedtype
        LEFT JOIN nondrugitems nd ON nd.icode = bn.room_charge_icode
        WHERE bt.hos_guid = 'Y' AND bn.room_charge_icode IS NOT NULL
      ),
      an_bed AS (
        SELECT DISTINCT ON (i.an) i.an, i.nbedno as bedno
        FROM iptbedmove i
        JOIN special_beds sb ON sb.bedno = i.nbedno
        ORDER BY i.an, (i.movedate + i.movetime) DESC
      ),
      paid_charges AS (
        SELECT ab.bedno, rn.name as room_name, sb.rate_per_night, w.ward as ward_code,
               o.sum_price, o.qty, o.vstdate, o.paidst,
               -- ส่วนลดที่ 1: จำนวนเงินส่วนลดที่บันทึกมาพร้อมรายการเรียกเก็บ
               COALESCE(o.discount, 0) AS cash_discount,
               -- ส่วนลดที่ 2: ส่วนลดเป็น % ตามสิทธิของผู้ป่วย (pttype_items_price_inc.discount_percent
               -- คิดจาก inc_cover_price) คูณจำนวนคืนของรายการนั้น เพราะ cover price เป็นราคาต่อคืน
               COALESCE(pct.discount_per_unit, 0) * COALESCE(o.qty, 1) AS pttype_discount
        FROM opitemrece o
        JOIN an_bed ab ON ab.an = o.an
        JOIN special_beds sb ON sb.bedno = ab.bedno AND sb.room_charge_icode = o.icode
        LEFT JOIN roomno rn ON rn.roomno = sb.roomno
        LEFT JOIN ward w ON w.ward = rn.ward
        LEFT JOIN LATERAL (
          SELECT MAX(inc.inc_cover_price * inc.discount_percent / 100.0) AS discount_per_unit
          FROM pttype_items_price pip
          JOIN pttype_items_price_inc inc ON inc.pttype_items_price_id = pip.pttype_items_price_id
          WHERE pip.items_table_code = o.icode
            AND pip.pttype = o.pttype
            AND inc.discount_percent > 0
            AND inc.inc_cover_price > 0
        ) pct ON TRUE
        WHERE o.paidst IN ('00','01','02','03','04')
      )
      SELECT bedno as room_number, MAX(room_name) as room_name, MAX(rate_per_night) as rate_per_night,
             SUM(qty) as nights,
             SUM(sum_price) as full_price,
             SUM(sum_price) FILTER (WHERE paidst = '02') as claimable_revenue,
             -- ราคาที่ต้องชำระ = ยอดที่ผู้ป่วยจ่ายเอง หักส่วนลดทั้งสองแบบออกแล้ว (ไม่ให้ติดลบ)
             GREATEST(
               COALESCE(SUM(sum_price) FILTER (WHERE paidst IN ('01','03')), 0)
               - COALESCE(SUM(cash_discount + pttype_discount), 0), 0
             ) as payable_revenue,
             -- ส่วนลดรวมทั้งสองแบบ (เงินส่วนลดในบิล + ส่วนลด % ตามสิทธิ)
             COALESCE(SUM(cash_discount + pttype_discount), 0) as discount_revenue,
             COALESCE(SUM(cash_discount), 0) as cash_discount,
             COALESCE(SUM(pttype_discount), 0) as pttype_discount
      FROM paid_charges
      WHERE 1=1 ${where}
      GROUP BY bedno
      ORDER BY room_number
    `, params, cfg);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
