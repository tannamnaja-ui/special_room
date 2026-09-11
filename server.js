const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { loadSettings, query } = require('./config/db');
const authRouter = require('./routes/auth');
const roomsRouter = require('./routes/rooms');
const bookingsRouter = require('./routes/bookings');
const waitlistRouter = require('./routes/waitlist');
const reportsRouter = require('./routes/reports');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// เมื่อ bundle ด้วย pkg: ใช้ public folder ข้าง ๆ exe ถ้ามี (แก้ไขหน้าเว็บได้โดยไม่ต้อง build ใหม่)
// ถ้าไม่มีโฟลเดอร์นั้น ให้ถอยไปใช้ชุดที่ pkg ฝังมาใน exe แทน — ไม่งั้นหน้าเว็บทุกหน้าจะ 404
// (เช่น Cannot GET /settings.html) เมื่อเครื่องปลายทางมีแต่ไฟล์ exe อย่างเดียว
// เมื่อ run ด้วย node ปกติ ใช้ __dirname
const isPackaged = typeof process.pkg !== 'undefined';
const snapshotPublic = path.join(__dirname, 'public');
let publicDir = snapshotPublic;
if (isPackaged) {
  const externalPublic = path.join(path.dirname(process.execPath), 'public');
  publicDir = fs.existsSync(path.join(externalPublic, 'index.html')) ? externalPublic : snapshotPublic;
}
console.log('Serving web files from:', publicDir);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'hospital-room-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// Share io with routes
app.use((req, res, next) => { req.io = io; next(); });

// ต้องเช็ค login ก่อนเสมอ (ทั้ง '/' และ '/index.html') — ต้องอยู่ก่อน express.static
app.get(['/', '/index.html'], (req, res) => {
  if (!loadSettings()) return res.redirect('/settings.html');
  if (!req.session.user) return res.redirect('/login.html');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(express.static(publicDir));

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/waitlist', waitlistRouter);
app.use('/api/reports', reportsRouter);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

async function runMigrations() {
  const cfg = loadSettings();
  if (!cfg) return;
  try {
    if (cfg.db_type === 'postgresql') {
      await query(`ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS check_in_date VARCHAR(50)`, [], cfg);
    } else {
      const cols = await query(`SHOW COLUMNS FROM waiting_list LIKE 'check_in_date'`, [], cfg);
      if (!cols || cols.length === 0)
        await query(`ALTER TABLE waiting_list ADD COLUMN check_in_date VARCHAR(50)`, [], cfg);
    }
  } catch {}

  // คอลัมน์เวลาที่ได้ห้อง/เข้าพัก — ใช้คำนวณรายงานระยะเวลารอคอย
  for (const col of ['assigned_at', 'checkedin_at']) {
    try {
      if (cfg.db_type === 'postgresql') {
        await query(`ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS ${col} TIMESTAMP`, [], cfg);
      } else {
        const cols = await query(`SHOW COLUMNS FROM waiting_list LIKE '${col}'`, [], cfg);
        if (!cols || cols.length === 0)
          await query(`ALTER TABLE waiting_list ADD COLUMN ${col} TIMESTAMP NULL`, [], cfg);
      }
    } catch {}
  }
}

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`Hospital Room System running at http://localhost:${PORT}`);
  runMigrations();
});
