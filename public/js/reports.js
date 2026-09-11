/* =========================================================
   สรุปรายงานการใช้ห้อง
   (คัดลอกมาจากโปรเจกต์ specal room ward — แยกเป็นไฟล์ของตัวเอง)
   ========================================================= */

/* ===== helper ที่รายงานต้องใช้ ===== */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('หมดเวลาเชื่อมต่อ (เกิน 20 วินาที) — ตรวจสอบว่าเครื่องนี้เชื่อมต่อฐานข้อมูลได้หรือไม่ ที่หน้า ตั้งค่าการเชื่อมต่อ');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function formatDuration(startStr, endStr) {
  const start = new Date(startStr);
  if (isNaN(start)) return '-';
  const end = endStr ? new Date(endStr) : new Date();
  if (isNaN(end)) return '-';
  let ms = end - start;
  if (ms < 0) ms = 0;
  const totalHours = Math.floor(ms / (1000 * 60 * 60));
  const days  = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const parts = [];
  if (days > 0)  parts.push(`${days} วัน`);
  parts.push(`${hours} ชั่วโมง`);
  return parts.join(' ') + (endStr ? '' : ' (ยังดำเนินอยู่)');
}

/* ===== รายงานสรุปการใช้ห้อง (สรุปรายงานการใช้ห้อง) ===== */
let currentReportKey = null;
let reportWardsLoaded = false;

async function loadReportWards() {
  if (reportWardsLoaded) return;
  const sel = document.getElementById('reportWardFilter');
  if (!sel) return;
  try {
    const res  = await fetchWithTimeout('/api/bookings/his-wards');
    const data = await res.json();
    if (!data.success) return;
    (data.wards || []).filter(w => w.ward && w.name).forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.ward; opt.textContent = w.name;
      sel.appendChild(opt);
    });
    reportWardsLoaded = true;
  } catch (e) {}
}

// รายได้ทุกรายงานคำนวณแบบประมาณการ = ราคาห้อง (room_types.price_per_day ตอนจอง) x จำนวนคืนที่พักจริง
// (ระบบนี้เป็นระบบจอง/คิว ไม่มีตารางใบเสร็จ/การเงินจริงจาก HIS จึงต้องอิงข้อมูลการจองที่มีอยู่)
const REPORTS_CONFIG = {
  'repair-duration': {
    icon: '🔧', title: 'สรุประยะเวลาการส่งซ่อม',
    desc: 'ระยะเวลาที่แต่ละเตียงถูกส่งซ่อม (จากประวัติที่บันทึกในหน้าจัดการเตียง)',
    endpoint: '/api/reports/repair-duration', render: renderDurationReport
  },
  'isolation-duration': {
    icon: '🦠', title: 'สรุประยะเวลาการใช้ห้องพิเศษเป็นห้องแยกโรค',
    desc: 'ระยะเวลาที่แต่ละเตียงถูกใช้เป็นห้องแยกโรค (จากประวัติที่บันทึกในหน้าจัดการเตียง)',
    endpoint: '/api/reports/isolation-duration', render: renderDurationReport
  },
  'monthly-revenue': {
    icon: '📅', title: 'สรุปรายได้ต่อเดือนของการใช้ห้องพิเศษ(ราคาเต็ม)',
    desc: 'รายได้ประมาณการ (ราคาห้อง x คืนที่พักจริง) แยกตามเดือน',
    endpoint: '/api/reports/monthly-revenue', render: renderMonthlyRevenueReport
  },
  'rooms-revenue': {
    icon: '🏠', title: 'สรุปจำนวนห้องที่ใช้ และรายได้รวมต่อห้อง',
    desc: 'จำนวนครั้งที่ใช้ จำนวนวันนอนทั้งหมด และรายได้รวมของแต่ละห้อง (จากประวัติการย้ายเตียงจริง)',
    endpoint: '/api/reports/rooms-revenue',
    render: renderRoomsRevenueReport
  },
  'total-revenue': {
    icon: '💰', title: 'สรุปรายได้จริงของห้องพิเศษ(ชำระเงิน)',
    desc: 'รายได้ที่เก็บได้จริง (ชำระเงินแล้ว) จากรายการเรียกเก็บจริงของ HIS แยกตามเตียง',
    endpoint: '/api/reports/total-revenue', render: renderTotalRevenueReport,
    note: 'นับเฉพาะรายการที่ paidst = "ชำระเองเบิกได้" หรือ "ชำระเองเบิกไม่ได้" (จ่ายเงินจริงแล้ว) ไม่รวมค้างชำระ/ลูกหนี้สิทธิ/ส่วนลด'
  },
  'waiting-duration': {
    icon: '⏳', title: 'สรุประยะเวลารอคอยการจองห้องพิเศษ',
    desc: 'นับราย AN ตั้งแต่เข้าคิวจอง จนได้เข้าห้องพิเศษจริง',
    endpoint: '/api/reports/waiting-duration', render: renderWaitingDurationReport,
    note: 'นับได้เฉพาะรายการที่มี AN กรอกไว้ในคิวรอ และ AN นั้นเคยถูกย้ายเข้าห้องพิเศษจริงแล้ว (จากประวัติการย้ายเตียง)'
  },
  'rights-summary': {
    icon: '🪪', title: 'สรุปจำนวนจ่ายห้องของแต่ละกลุ่มสิทธิ',
    desc: 'สิทธิไหนใช้ห้องพิเศษไปเท่าไหร่ และราคาที่จ่ายจริงตามสิทธินั้น',
    endpoint: '/api/reports/rights-summary', render: renderRightsSummaryReport
  },
  'holiday-weekday-revenue': {
    icon: '🗓️', title: 'สรุปรายได้วันหยุด/วันธรรมดา',
    desc: 'สรุปรายได้แยกตามวันทั้ง 7 วัน พร้อมราคาเบิกได้ตามสิทธิ และราคาที่ต้องชำระ',
    endpoint: '/api/reports/holiday-weekday-revenue', render: renderHolidayWeekdayReport
  },
  'shift-revenue': {
    icon: '🕐', title: 'สรุปรายได้ตามเวร เช้า บ่าย ดึก',
    desc: 'แยกตามเวร พร้อมราคาเบิกได้ตามสิทธิ และราคาที่ต้องชำระ',
    endpoint: '/api/reports/shift-revenue', render: renderShiftRevenueReport,
    note: 'แบ่งเวรจากเวลาที่เรียกเก็บจริง: เช้า 08:00-15:59, บ่าย 16:00-23:59, ดึก 00:00-07:59'
  }
};

function renderReportCards() {
  const grid = document.getElementById('reportCardsGrid');
  if (!grid) return;
  grid.innerHTML = Object.entries(REPORTS_CONFIG).map(([key, r]) => `
    <div class="report-card" onclick="openReport('${key}')">
      <div class="report-card-icon">${r.icon}</div>
      <div class="report-card-title">${r.title}</div>
      <div class="report-card-desc">${r.desc}</div>
    </div>
  `).join('');
}

function showReportsHub() {
  document.getElementById('reportsHub').style.display = '';
  document.getElementById('reportsDetail').style.display = 'none';
  currentReportKey = null;
}

async function openReport(key) {
  const cfg = REPORTS_CONFIG[key];
  if (!cfg) return;
  currentReportKey = key;
  document.getElementById('reportsHub').style.display = 'none';
  document.getElementById('reportsDetail').style.display = '';
  document.getElementById('reportDetailTitle').textContent = `${cfg.icon} ${cfg.title}`;
  const noteEl = document.getElementById('reportDetailNote');
  if (cfg.note) { noteEl.textContent = 'ℹ️ ' + cfg.note; noteEl.style.display = ''; }
  else { noteEl.style.display = 'none'; }
  document.getElementById('reportWardFilter').value = '';
  const today = todayDateInputValue();
  document.getElementById('reportFromDate').value = today;
  document.getElementById('reportToDate').value = today;
  await loadReportWards();
  loadCurrentReport();
}

function todayDateInputValue() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadCurrentReport() {
  const cfg = REPORTS_CONFIG[currentReportKey];
  const content = document.getElementById('reportDetailContent');
  if (!cfg || !content) return;
  content.innerHTML = `<div class="empty-state"><div class="spinner" style="margin:0 auto"></div><p style="margin-top:12px">กำลังโหลด...</p></div>`;
  try {
    const ward = document.getElementById('reportWardFilter').value;
    const from = document.getElementById('reportFromDate').value;
    const to   = document.getElementById('reportToDate').value;
    const params = new URLSearchParams();
    if (ward) params.set('ward', ward);
    if (from) params.set('from', from);
    if (to)   params.set('to', to);
    const qs = params.toString();
    const res  = await fetchWithTimeout(cfg.endpoint + (qs ? '?' + qs : ''));
    const data = await res.json();
    if (!data.success) { content.innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`; return; }
    content.innerHTML = cfg.render(data);
  } catch (e) {
    content.innerHTML = `<div class="alert alert-error">❌ ไม่สามารถโหลดข้อมูลได้</div>`;
  }
}

function fmtBaht(v) {
  return (+v || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' บาท';
}

const reportTh = s => `<th style="padding:10px 12px;text-align:left;border-bottom:1px solid #E0E0E0;white-space:nowrap">${s}</th>`;

// รายงานเชิงรายการ + ระยะเวลา (ใช้กับ repair-duration / isolation-duration)
function renderDurationReport(data) {
  const rows = data.rows || [];
  if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  const fmtDT = v => v ? new Date(v).toLocaleString('th-TH', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '-';
  let totalMs = 0;
  const bodyRows = rows.map((h, i) => {
    const start = new Date(h.start_date);
    const end = h.end_date ? new Date(h.end_date) : new Date();
    if (!isNaN(start) && !isNaN(end)) totalMs += Math.max(0, end - start);
    return `<tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px;font-weight:700;color:var(--primary)">${escHtml(h.bedno||'-')}</td>
      <td style="padding:8px 10px">${escHtml(h.room_name||'-')} ${h.ward_name ? '/ ' + escHtml(h.ward_name) : ''}</td>
      <td style="padding:8px 10px;white-space:nowrap">${fmtDT(h.start_date)}</td>
      <td style="padding:8px 10px;white-space:nowrap">${h.end_date ? fmtDT(h.end_date) : '<span style="color:#F57F17;font-weight:600">ยังไม่เสร็จ</span>'}</td>
      <td style="padding:8px 10px;white-space:nowrap;font-weight:600">${formatDuration(h.start_date, h.end_date)}</td>
    </tr>`;
  }).join('');
  const totalHours = Math.floor(totalMs / (1000*60*60));
  const totalDays  = Math.floor(totalHours / 24);
  return `
    <div style="margin-bottom:14px;font-size:13px;color:#546E7A">พบ <b>${rows.length}</b> ครั้ง รวมระยะเวลาทั้งหมด <b>${totalDays} วัน ${totalHours % 24} ชั่วโมง</b></div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('เตียง')}${reportTh('ห้อง / Ward')}${reportTh('วันที่-เวลาเริ่ม')}${reportTh('วันที่-เวลาเสร็จ')}${reportTh('ระยะเวลา')}
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    </div>`;
}

// รายงานเชิงกลุ่ม + จำนวนครั้ง/คืน/รายได้ (ใช้กับ monthly-revenue, rooms-revenue, rights-summary, holiday-weekday-revenue, shift-revenue)
// opts เอาไว้ override ข้อความหัวคอลัมน์ nights/revenue เฉพาะรายงานที่ต้องการ (ไม่กระทบรายงานอื่นที่ใช้ default)
function renderGroupRevenueReport(groupKey, groupLabel, opts = {}) {
  const nightsLabel  = opts.nightsLabel  || 'คืนรวม';
  const revenueLabel = opts.revenueLabel || 'รายได้ประมาณการ';
  return function(data) {
    const rows = data.rows || [];
    if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก (อาจยังไม่มีการบันทึกเช็คอิน/เช็คเอาท์จริงในระบบ)</p></div>`;
    let totalNights = 0, totalRevenue = 0;
    const bodyRows = rows.map((r, i) => {
      totalNights += (+r.nights || 0);
      totalRevenue += (+r.revenue || 0);
      return `<tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
        <td style="padding:8px 10px;font-weight:600">${escHtml(r[groupKey] ?? '-')}</td>
        <td style="padding:8px 10px;text-align:right">${(+r.nights||0).toLocaleString('th-TH')}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700;color:#2E7D32">${fmtBaht(r.revenue)}</td>
      </tr>`;
    }).join('');
    return `
      <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
          ${reportTh(groupLabel)}<th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">${nightsLabel}</th><th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">${revenueLabel}</th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr style="background:#F5F7FA;font-weight:700">
          <td style="padding:8px 10px">รวมทั้งหมด</td>
          <td style="padding:8px 10px;text-align:right">${totalNights.toLocaleString('th-TH')}</td>
          <td style="padding:8px 10px;text-align:right;color:#2E7D32">${fmtBaht(totalRevenue)}</td>
        </tr></tfoot>
      </table>
      </div>`;
  };
}

// สรุปจำนวนห้องที่ใช้ และรายได้รวมต่อห้อง — โชว์ชื่อ/เลขห้อง (roomno) นำหน้าเลขเตียง (bedno) เพราะ 1 ห้องอาจมีหลายเตียง
function renderRoomsRevenueReport(data) {
  const rows = data.rows || [];
  if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  let totalNights = 0, totalRevenue = 0;
  const bodyRows = rows.map((r, i) => {
    totalNights += (+r.nights || 0);
    totalRevenue += (+r.revenue || 0);
    return `<tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px">${escHtml(r.room_name || r.roomno || '-')}</td>
      <td style="padding:8px 10px;font-weight:600">${escHtml(r.room_number||'-')}</td>
      <td style="padding:8px 10px;text-align:right">${(+r.nights||0).toLocaleString('th-TH')}</td>
      <td style="padding:8px 10px;text-align:right;font-weight:700;color:#2E7D32">${fmtBaht(r.revenue)}</td>
    </tr>`;
  }).join('');
  return `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('ห้อง')}${reportTh('เตียง')}<th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">จำนวนวันนอนทั้งหมด</th><th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">รายได้</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr style="background:#F5F7FA;font-weight:700">
        <td style="padding:8px 10px" colspan="2">รวมทั้งหมด</td>
        <td style="padding:8px 10px;text-align:right">${totalNights.toLocaleString('th-TH')}</td>
        <td style="padding:8px 10px;text-align:right;color:#2E7D32">${fmtBaht(totalRevenue)}</td>
      </tr></tfoot>
    </table>
    </div>`;
}

// สรุปรายได้ต่อเดือน — ถ้าเลือกช่วงวันที่ (from/to) backend จะแจงเป็นรายวันแทน ให้เปลี่ยนหัวคอลัมน์ตามจริง
function renderMonthlyRevenueReport(data) {
  const label = data.groupedByDay ? 'วันที่' : 'เดือน';
  return renderGroupRevenueReport('month', label)(data);
}

function renderTotalRevenueReport(data) {
  const total = data.total || {};
  const byBed = data.byBed || [];
  const summaryCards = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px">
      <div class="stat-card" style="border-left-color:#2E7D32">
        <div class="stat-icon">💰</div>
        <div><div class="stat-number" style="color:#2E7D32;font-size:20px">${fmtBaht(total.revenue)}</div><div class="stat-label">รายได้จริงที่เก็บได้ (ชำระเงินแล้ว)</div></div>
      </div>
      <div class="stat-card" style="border-left-color:#1565C0">
        <div class="stat-icon">🧾</div>
        <div><div class="stat-number" style="color:#1565C0">${(+total.bookings_count||0).toLocaleString('th-TH')}</div><div class="stat-label">จำนวนรายการเรียกเก็บที่ชำระแล้ว</div></div>
      </div>
    </div>`;
  if (byBed.length === 0) return summaryCards + `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  const bodyRows = byBed.map((r, i) => `
    <tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px;font-weight:600;color:var(--primary)">${escHtml(r.room_number||'-')}</td>
      <td style="padding:8px 10px;text-align:right">${(+r.bookings_count||0).toLocaleString('th-TH')}</td>
      <td style="padding:8px 10px;text-align:right;font-weight:700;color:#2E7D32">${fmtBaht(r.revenue)}</td>
    </tr>`).join('');
  return summaryCards + `
    <div style="font-size:13px;font-weight:700;color:#546E7A;margin-bottom:8px">แยกตามเตียง</div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('เตียง')}<th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">จำนวนรายการ</th><th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">รายได้</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    </div>`;
}

// สรุปจำนวนจ่ายห้องของแต่ละกลุ่มสิทธิ — ชื่อสิทธิ, จำนวนรวมตามสิทธิ (จำนวนรายการที่จ่าย), ราคาที่จ่ายจริงตามสิทธินั้น
function renderRightsSummaryReport(data) {
  const rows = data.rows || [];
  if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  let totalCount = 0, totalRevenue = 0;
  const bodyRows = rows.map((r, i) => {
    totalCount += (+r.bookings_count || 0);
    totalRevenue += (+r.revenue || 0);
    return `<tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px;font-weight:600">${escHtml(r.rights_type||'-')}</td>
      <td style="padding:8px 10px;text-align:right">${(+r.bookings_count||0).toLocaleString('th-TH')}</td>
      <td style="padding:8px 10px;text-align:right;font-weight:700;color:#2E7D32">${fmtBaht(r.revenue)}</td>
    </tr>`;
  }).join('');
  return `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('สิทธิการรักษา')}<th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">จำนวนรวมตามสิทธิ</th><th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">ราคาที่ใช้ได้ตามสิทธิ</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr style="background:#F5F7FA;font-weight:700">
        <td style="padding:8px 10px">รวมทั้งหมด</td>
        <td style="padding:8px 10px;text-align:right">${totalCount.toLocaleString('th-TH')}</td>
        <td style="padding:8px 10px;text-align:right;color:#2E7D32">${fmtBaht(totalRevenue)}</td>
      </tr></tfoot>
    </table>
    </div>`;
}

// สรุปรายได้วันหยุด/วันธรรมดา — สรุปแค่รายได้ แยกตามวันทั้ง 7 วัน (จันทร์-อาทิตย์) ไม่แยกตามเตียง พร้อมราคาเบิกได้ตามสิทธิ (paidst=02) และราคาที่ต้องชำระ (paidst 01,03)
function renderHolidayWeekdayReport(data) {
  const rows = data.rows || [];
  if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  const dowNames = { 1: 'จันทร์', 2: 'อังคาร', 3: 'พุธ', 4: 'พฤหัสบดี', 5: 'ศุกร์', 6: 'เสาร์', 7: 'อาทิตย์' };
  const sorted = [...rows].sort((a, b) => a.dow - b.dow);
  let totalClaimable = 0, totalPayable = 0;
  const bodyRows = sorted.map((r, i) => {
    totalClaimable += (+r.claimable_revenue || 0);
    totalPayable += (+r.payable_revenue || 0);
    const isWeekend = r.dow === 6 || r.dow === 7;
    return `<tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px;font-weight:600${isWeekend ? ';color:#C62828' : ''}">${dowNames[r.dow] || '-'}</td>
      <td style="padding:8px 10px;text-align:right">${fmtBaht(r.claimable_revenue)}</td>
      <td style="padding:8px 10px;text-align:right;font-weight:700;color:#2E7D32">${fmtBaht(r.payable_revenue)}</td>
    </tr>`;
  }).join('');
  return `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('วัน')}<th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">ราคาเบิกได้ตามสิทธิ</th><th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">ราคาที่ต้องชำระ</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr style="background:#F5F7FA;font-weight:700">
        <td style="padding:8px 10px">รวมทั้งหมด</td>
        <td style="padding:8px 10px;text-align:right">${fmtBaht(totalClaimable)}</td>
        <td style="padding:8px 10px;text-align:right;color:#2E7D32">${fmtBaht(totalPayable)}</td>
      </tr></tfoot>
    </table>
    </div>`;
}

// สรุปรายได้ตามเวร เช้า/บ่าย/ดึก พร้อมราคาเบิกได้ตามสิทธิ (paidst=02) และราคาที่ต้องชำระ (paidst 01,03)
function renderShiftRevenueReport(data) {
  const rows = data.rows || [];
  if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  let totalClaimable = 0, totalPayable = 0;
  const bodyRows = rows.map((r, i) => {
    totalClaimable += (+r.claimable_revenue || 0);
    totalPayable += (+r.payable_revenue || 0);
    return `<tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px;font-weight:600">${escHtml(r.shift||'-')}</td>
      <td style="padding:8px 10px;text-align:right">${fmtBaht(r.claimable_revenue)}</td>
      <td style="padding:8px 10px;text-align:right;font-weight:700;color:#2E7D32">${fmtBaht(r.payable_revenue)}</td>
    </tr>`;
  }).join('');
  return `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('เวร')}<th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">ราคาเบิกได้ตามสิทธิ</th><th style="padding:10px 12px;text-align:right;border-bottom:1px solid #E0E0E0">ราคาที่ต้องชำระ</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr style="background:#F5F7FA;font-weight:700">
        <td style="padding:8px 10px">รวมทั้งหมด</td>
        <td style="padding:8px 10px;text-align:right">${fmtBaht(totalClaimable)}</td>
        <td style="padding:8px 10px;text-align:right;color:#2E7D32">${fmtBaht(totalPayable)}</td>
      </tr></tfoot>
    </table>
    </div>`;
}

function renderWaitingDurationReport(data) {
  const rows = data.rows || [];
  if (rows.length === 0) return `<div class="empty-state"><div class="empty-icon">📋</div><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>`;
  const fmtDT = v => v ? new Date(v).toLocaleString('th-TH', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '-';
  const bodyRows = rows.map((r, i) => `
    <tr style="background:${i%2===0?'#fff':'#FAFAFA'};border-bottom:1px solid #F0F0F0">
      <td style="padding:8px 10px;font-weight:600;color:var(--primary)">${escHtml(r.an||'-')}</td>
      <td style="padding:8px 10px">${escHtml(r.hn||'-')}</td>
      <td style="padding:8px 10px">${escHtml(r.patient_name||'-')}</td>
      <td style="padding:8px 10px">${escHtml(r.room_number||'-')} ${r.room_ward_name ? '/ ' + escHtml(r.room_ward_name) : ''}</td>
      <td style="padding:8px 10px;white-space:nowrap">${fmtDT(r.request_date)}</td>
      <td style="padding:8px 10px;white-space:nowrap">${fmtDT(r.got_room_at)}</td>
      <td style="padding:8px 10px;white-space:nowrap;font-weight:600">${formatDuration(r.request_date, r.got_room_at)}</td>
    </tr>`).join('');
  return `
    <div style="margin-bottom:14px;font-size:13px;color:#546E7A">พบ <b>${rows.length}</b> AN</div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F5F7FA;color:#546E7A;font-size:12px;font-weight:700">
        ${reportTh('AN')}${reportTh('HN')}${reportTh('ชื่อ-สกุล')}${reportTh('ห้องที่ได้ / Ward')}${reportTh('วันที่เข้าคิว')}${reportTh('วันที่ได้เข้าห้อง')}${reportTh('ระยะเวลารอ')}
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    </div>`;
}

function tableToCSVRows(table) {
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [...tr.children].map(td => {
      let text = td.textContent.replace(/\s+/g, ' ').trim();
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        text = '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    });
    rows.push(cells.join(','));
  });
  return rows;
}

function exportCurrentReportCSV() {
  const cfg = REPORTS_CONFIG[currentReportKey];
  const content = document.getElementById('reportDetailContent');
  const tables = content ? content.querySelectorAll('table') : [];
  if (!cfg || tables.length === 0) { toast('ไม่มีข้อมูลสำหรับส่งออก', 'warning'); return; }
  let csvLines = [];
  tables.forEach(table => { csvLines = csvLines.concat(tableToCSVRows(table)); csvLines.push(''); });
  const csv = csvLines.join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  a.href = url;
  a.download = `${currentReportKey}_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('ส่งออก CSV เรียบร้อย', 'success');
}

function printCurrentReport() {
  const cfg = REPORTS_CONFIG[currentReportKey];
  const content = document.getElementById('reportDetailContent');
  if (!cfg || !content || !content.innerHTML.trim()) { toast('ไม่มีข้อมูลสำหรับพิมพ์', 'warning'); return; }

  const wardSel  = document.getElementById('reportWardFilter');
  const wardText = wardSel && wardSel.value ? wardSel.options[wardSel.selectedIndex].textContent : 'ทุก Ward';
  const from = document.getElementById('reportFromDate').value;
  const to   = document.getElementById('reportToDate').value;
  const fmtTH = v => v ? new Date(v + 'T00:00:00').toLocaleDateString('th-TH', { day:'numeric', month:'long', year:'numeric' }) : '';
  const filterParts = [`Ward: <b>${escHtml(wardText)}</b>`];
  if (from) filterParts.push(`ตั้งแต่: <b>${fmtTH(from)}</b>`);
  if (to)   filterParts.push(`ถึง: <b>${fmtTH(to)}</b>`);
  const printedAt = new Date().toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' });

  const html = `<!DOCTYPE html><html lang="th"><head>
  <meta charset="UTF-8">
  <title>${escHtml(cfg.title)}</title>
  <style>
    @page { size: A4 portrait; margin: 15mm 12mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Angsana New', 'AngsanaUPC', serif; font-size: 16px; color: #222; margin: 0; }
    .report-title { font-size: 22px; font-weight: 700; text-align: center; margin-bottom: 4px; }
    .meta-right   { text-align: right; font-size: 14px; color: #777; margin-bottom: 10px; }
    .filter-bar   { font-size: 15px; color: #444; margin-bottom: 12px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 16px; margin-top: 10px; }
    th { padding: 6px 8px; text-align: left; font-weight: 700; border: 1px solid #000; }
    td { padding: 5px 8px; border: 1px solid #000; vertical-align: top; }
    .stat-card { display: inline-flex; align-items: center; gap: 10px; border: 1px solid #000; border-radius: 4px; padding: 10px 16px; margin: 0 10px 10px 0; }
    .stat-icon { font-size: 22px; }
    .stat-number { font-size: 18px; font-weight: 700; }
    .stat-label { font-size: 13px; color: #444; }
    .empty-state { text-align: center; color: #444; padding: 20px; }
    /* ไม่พิมพ์ด้วยสี — บังคับพื้นหลังของทุกแถว/เซลล์ (รวมที่มี inline style ติดมาจากหน้าเว็บ) ให้เป็นสีขาวล้วน */
    table, thead, tbody, tfoot, tr, th, td { background: #fff !important; }
  </style>
  </head><body>
  <div class="report-title">${escHtml(cfg.title)}</div>
  <div class="meta-right">พิมพ์เมื่อ: ${printedAt}</div>
  <div class="filter-bar">${filterParts.join(' &nbsp;|&nbsp; ')}</div>
  ${content.innerHTML}
  </body></html>`;

  const w = window.open('', '_blank', 'width=1100,height=750');
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 400);
}

