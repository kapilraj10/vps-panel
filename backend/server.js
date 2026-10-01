import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import si from 'systeminformation';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config (.env) ----------
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1'; // only reachable locally + via Cloudflare Tunnel
const SAMPLE_MS = Number(process.env.SAMPLE_MS) || 5000;
const HISTORY_MINUTES = Number(process.env.HISTORY_MINUTES) || 60;
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const MAX_POINTS = Math.ceil((HISTORY_MINUTES * 60_000) / SAMPLE_MS);
const PROCESS_EVERY = 3; // process list is heavier, read it every 3rd sample
const MAX_APPS = 50;

// ---------- State (in memory) ----------
const history = [];
const apps = {};
let pendingReq = 0;
let topProcs = [];
let tick = 0;
let info = null;

const round = (n) => Math.round((Number(n) || 0) * 10) / 10;
const toInt = (n) => Math.max(0, Math.floor(Number(n) || 0));

async function loadInfo() {
  const [os, cpu] = await Promise.all([si.osInfo(), si.cpu()]);
  info = {
    hostname: os.hostname,
    distro: `${os.distro} ${os.release}`,
    kernel: os.kernel,
    cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cores: cpu.cores,
    sampleMs: SAMPLE_MS,
  };
}

function appList() {
  const now = Date.now();
  return Object.entries(apps)
    .map(([name, a]) => {
      a.window = a.window.filter((w) => now - w.t < 60_000);
      return {
        name,
        rpm: a.window.reduce((s, w) => s + w.c, 0),
        count: a.count,
        errors: a.errors,
        avgMs: a.count ? round(a.totalMs / a.count) : 0,
        lastSeen: a.lastSeen,
      };
    })
    .sort((x, y) => y.rpm - x.rpm || y.count - x.count);
}

function snapshot() {
  return {
    info,
    history,
    apps: appList(),
    processes: topProcs,
    uptime: si.time().uptime,
  };
}

async function takeSample() {
  const [load, mem, disks, nets, temp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats('*'),
    si.cpuTemperature(),
  ]);

  const root = disks.find((d) => d.mount === '/') || disks[0] || { used: 0, size: 0 };
  let rx = 0;
  let tx = 0;
  for (const n of nets) {
    if (n.iface === 'lo') continue;
    rx += n.rx_sec > 0 ? n.rx_sec : 0;
    tx += n.tx_sec > 0 ? n.tx_sec : 0;
  }

  const req = pendingReq;
  pendingReq = 0;

  const point = {
    t: Date.now(),
    cpu: round(load.currentLoad),
    ramUsed: mem.active,
    ramTotal: mem.total,
    diskUsed: root.used,
    diskTotal: root.size,
    rx: Math.round(rx),
    tx: Math.round(tx),
    temp: temp.main > 0 ? round(temp.main) : null,
    req,
  };

  history.push(point);
  if (history.length > MAX_POINTS) history.shift();

  if (tick++ % PROCESS_EVERY === 0) {
    const procs = await si.processes();
    topProcs = procs.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 6)
      .map((p) => ({
        pid: p.pid,
        name: p.name,
        user: p.user,
        cpu: round(p.cpu),
        mem: (p.memRss || 0) * 1024, // memRss is in KB
      }));
  }

  io.emit('sample', {
    point,
    uptime: si.time().uptime,
    processes: topProcs,
    apps: appList(),
  });
}

async function loop() {
  try {
    await takeSample();
  } catch (err) {
    console.error('Sample failed:', err.message);
  }
  setTimeout(loop, SAMPLE_MS);
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

const server = http.createServer(app);
const io = new Server(server);

// Your other apps send request counts here (see panel-tracker.js)
app.post('/api/ingest', (req, res) => {
  if (!INGEST_TOKEN) {
    return res.status(503).json({ error: 'Set INGEST_TOKEN in backend/.env to accept request counts' });
  }
  if (req.get('x-panel-token') !== INGEST_TOKEN) {
    return res.status(401).json({ error: 'Wrong panel token' });
  }

  const { app: name, count, errors, totalMs } = req.body ?? {};
  if (typeof name !== 'string' || !/^[\w.-]{1,40}$/.test(name)) {
    return res.status(400).json({ error: 'app must be 1-40 letters, numbers, dot, dash or underscore' });
  }
  if (!apps[name] && Object.keys(apps).length >= MAX_APPS) {
    return res.status(429).json({ error: `Panel tracks at most ${MAX_APPS} apps` });
  }

  const c = toInt(count);
  const a = (apps[name] ??= { count: 0, errors: 0, totalMs: 0, lastSeen: 0, window: [] });
  a.count += c;
  a.errors += toInt(errors);
  a.totalMs += Math.max(0, Number(totalMs) || 0);
  a.lastSeen = Date.now();
  a.window.push({ t: Date.now(), c });
  pendingReq += c;

  res.json({ ok: true });
});

app.get('/api/snapshot', (_req, res) => res.json(snapshot()));

// Serve the built React app
const dist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend is not built yet. Run: cd frontend && npm run build');
  });
});

io.on('connection', (socket) => socket.emit('init', snapshot()));

await loadInfo();
server.listen(PORT, HOST, () => {
  console.log(`VPS panel running on http://${HOST}:${PORT}`);
  if (!INGEST_TOKEN) console.log('INGEST_TOKEN is empty: request counting is off until you set it in .env');
});
loop();
