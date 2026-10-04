import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import si from 'systeminformation';
import {
  loadSession, requireAuth, requireAdmin, csrfProtect, loginLimit, clientIp, sessionFromHeader,
  startSession, endSession, hashPassword, checkPassword, DUMMY_HASH,
} from './auth.js';
import { users, sessions, audit, USERNAME_RE, CONTAINER_RE, MIN_PASSWORD } from './db.js';
import { createContainerMonitor, roomFor } from './containers.js';

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
let hostMem = 0;

const round = (n) => Math.round((Number(n) || 0) * 10) / 10;
const toInt = (n) => Math.max(0, Math.floor(Number(n) || 0));

async function loadInfo() {
  const [os, cpu, mem] = await Promise.all([si.osInfo(), si.cpu(), si.mem()]);
  hostMem = mem.total;
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

  // Host stats are for admins only
  io.to('admin').emit('sample', {
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
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.json({ limit: '50kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  // Block other websites from opening a socket with the user's cookie
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    cb(null, !origin || origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`);
  },
});

const containers = createContainerMonitor({
  io, sampleMs: SAMPLE_MS, maxPoints: MAX_POINTS, hostCores: () => info?.cores || 1, hostMem: () => hostMem,
});

// Your other apps send request counts here (see panel-tracker.js).
// Machine-to-machine: protected by INGEST_TOKEN instead of a login session.
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

app.use(loadSession);
app.use(csrfProtect);

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const passwordProblem = (pw) => {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (Buffer.byteLength(pw) > 72) return 'Password must be at most 72 bytes';
  return null;
};
const kick = (room) => io.in(room).disconnectSockets(true);

// ---------- login / logout (public) ----------
app.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  const wait = loginLimit.retryAfter(ip);
  const { username, password } = req.body ?? {};
  const name = isStr(username, 64) ? username.trim().toLowerCase() : '';
  if (wait) {
    audit.log({ username: name || null, ip, action: 'login', result: 'failure', detail: 'rate limited' });
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many failed logins. Try again in ${Math.ceil(wait / 60)} minutes.` });
  }

  const user = name ? users.withHash(name) : null;
  const pw = isStr(password, 200) ? password : '';
  const ok = await checkPassword(pw, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) {
    loginLimit.fail(ip);
    audit.log({ username: name || null, ip, action: 'login', result: 'failure', detail: user ? 'wrong password' : 'unknown user' });
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  if (req.session) endSession(res, req.session.token_hash); // never reuse a session across logins
  startSession(res, user.id);
  audit.log({ username: user.username, ip, action: 'login', result: 'success' });
  return res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.session) {
    endSession(res, req.session.token_hash);
    kick(`sess:${req.session.token_hash}`);
    audit.log({ username: req.session.username, ip: clientIp(req), action: 'logout', result: 'success' });
  }
  res.json({ ok: true });
});

// Built React app: the login page and its assets are public, everything else needs a session
const dist = path.join(__dirname, '..', 'frontend', 'dist');
const sendPage = (file) => (_req, res) => res.sendFile(path.join(dist, file), (err) => {
  if (err) res.status(404).send('Frontend is not built yet. Run: cd frontend && npm run build');
});
app.get('/login', (req, res, next) => (req.session ? res.redirect(302, '/') : sendPage('login.html')(req, res, next)));
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));

app.use(requireAuth);

// ---------- account ----------
app.get('/api/me', (req, res) => {
  const s = req.session;
  res.set('Cache-Control', 'no-store');
  res.json({ username: s.username, role: s.role, container: s.role === 'user' ? s.container_name : null, csrf: s.csrf });
});

app.post('/api/password', async (req, res) => {
  const { current, next } = req.body ?? {};
  const s = req.session;
  if (!isStr(current, 200) || !(await checkPassword(current, users.hashById(s.id)))) {
    audit.log({ username: s.username, ip: clientIp(req), action: 'password_change', result: 'failure', detail: 'wrong current password' });
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  users.setPassword(s.id, await hashPassword(next));
  sessions.removeForUser(s.id, s.token_hash); // log out other devices
  audit.log({ username: s.username, ip: clientIp(req), action: 'password_change', result: 'success' });
  res.json({ ok: true });
});

// ---------- host stats (admin) ----------
app.get('/api/snapshot', requireAdmin, (_req, res) => res.json(snapshot()));

// ---------- containers ----------
// Resolves which container a request may touch. For role "user" the container always comes
// from their DB record; asking for any other name is 403, whether or not it exists.
function allowedContainer(req, res) {
  const asked = req.params.name;
  const s = req.session;
  let name;
  if (s.role === 'admin') {
    name = asked;
  } else {
    if (!s.container_name || asked !== s.container_name) {
      res.status(403).json({ error: 'You can only access your own container' });
      return null;
    }
    name = s.container_name;
  }
  if (!CONTAINER_RE.test(name) || !containers.exists(name)) {
    res.status(404).json({ error: containers.error() ? `LXD is not reachable: ${containers.error()}` : 'No such container' });
    return null;
  }
  return name;
}

app.get('/api/containers', (req, res) => {
  const s = req.session;
  const names = s.role === 'admin' ? containers.names() : containers.names().filter((n) => n === s.container_name);
  res.json({ containers: names.map(containers.view), error: containers.error() });
});

app.get('/api/containers/:name', (req, res) => {
  const name = allowedContainer(req, res);
  if (name) res.json(containers.view(name));
});

const ACTIONS = new Set(['start', 'stop', 'restart']);
app.post('/api/containers/:name/action', (req, res) => {
  const name = allowedContainer(req, res);
  if (!name) return;
  const action = req.body?.action;
  const s = req.session;
  const ip = clientIp(req);
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'action must be start, stop or restart' });
  if (containers.busy(name)) return res.status(409).json({ error: 'Another action is still running on this container' });

  audit.log({ username: s.username, ip, action, target: name, result: 'requested' });
  const job = containers.run(name, action, s.username, (done) => {
    audit.log({ username: s.username, ip, action, target: name, result: done.status, detail: done.message || null });
  });
  res.status(202).json(job);
});

// ---------- user management (admin) ----------
app.get('/api/users', requireAdmin, (_req, res) => res.json({ users: users.list(), containers: containers.names() }));

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, role, container } = req.body ?? {};
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'Username: 2-32 lowercase letters, digits, _ or -, starting with a letter' });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });
  if (role === 'user' && (typeof container !== 'string' || !CONTAINER_RE.test(container) || !containers.exists(container))) {
    return res.status(400).json({ error: 'Pick a container that exists in LXD' });
  }
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (users.withHash(name)) return res.status(409).json({ error: 'That username is taken' });

  users.create({ username: name, passwordHash: await hashPassword(password), role, container });
  audit.log({ username: req.session.username, ip: clientIp(req), action: 'user_create', target: name, result: 'success', detail: role === 'user' ? `container ${container}` : 'admin' });
  res.status(201).json({ ok: true });
});

function targetUser(req, res) {
  const target = /^\d+$/.test(req.params.id) ? users.byId(Number(req.params.id)) : null;
  if (!target) res.status(404).json({ error: 'No such user' });
  return target;
}

app.post('/api/users/:id/password', requireAdmin, async (req, res) => {
  const target = targetUser(req, res);
  if (!target) return;
  const problem = passwordProblem(req.body?.password);
  if (problem) return res.status(400).json({ error: problem });
  users.setPassword(target.id, await hashPassword(req.body.password));
  sessions.removeForUser(target.id, target.id === req.session.id ? req.session.token_hash : '');
  if (target.id !== req.session.id) kick(`user:${target.id}`);
  audit.log({ username: req.session.username, ip: clientIp(req), action: 'user_password_reset', target: target.username, result: 'success' });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const target = targetUser(req, res);
  if (!target) return;
  if (target.id === req.session.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  if (target.role === 'admin' && users.adminCount() <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  users.remove(target.id); // sessions go with it (ON DELETE CASCADE)
  kick(`user:${target.id}`);
  audit.log({ username: req.session.username, ip: clientIp(req), action: 'user_delete', target: target.username, result: 'success' });
  res.json({ ok: true });
});

// ---------- audit log (admin) ----------
app.get('/api/audit', requireAdmin, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const before = /^\d+$/.test(req.query.before || '') ? Number(req.query.before) : null;
  res.json({ entries: audit.recent(limit, before) });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Logged-in pages
app.use(express.static(dist, { index: false }));
app.get('*', sendPage('index.html'));

// ---------- live socket ----------
io.use((socket, next) => {
  const s = sessionFromHeader(socket.handshake.headers.cookie);
  if (!s) return next(new Error('unauthorized'));
  socket.data.session = s;
  return next();
});

io.on('connection', (socket) => {
  const s = socket.data.session;
  socket.join([`sess:${s.token_hash}`, `user:${s.id}`]);
  if (s.role === 'admin') {
    socket.join('admin');
    socket.emit('init', snapshot());
    socket.emit('containers:init', containers.names().map(containers.view));
  } else if (s.container_name) {
    socket.join(roomFor(s.container_name));
    socket.emit('containers:init', containers.exists(s.container_name) ? [containers.view(s.container_name)] : []);
  }
});

// Drop live sockets whose session expired or was revoked
setInterval(async () => {
  for (const socket of await io.fetchSockets()) {
    if (!sessions.find(socket.data.session.token_hash)) socket.disconnect(true);
  }
}, 60_000).unref();

await loadInfo();
server.listen(PORT, HOST, () => {
  console.log(`VPS panel running on http://${HOST}:${PORT}`);
  if (!INGEST_TOKEN) console.log('INGEST_TOKEN is empty: request counting is off until you set it in .env');
  if (!users.list().length) console.log('No users yet. Create the first admin with: node scripts/create-user.js');
});
loop();
containers.start();
