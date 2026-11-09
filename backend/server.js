import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import si from 'systeminformation';
import {
  loadSession, requireAuth, requireAdmin, csrfProtect, loginLimit, clientIp, sessionFromHeader, rateLimit, safeEqual,
  startSession, endSession, checkPassword, DUMMY_HASH, isAdmin,
} from './auth.js';
import { users, sessions, audit, backupJobs, db, settings } from './db.js';
import { createContainerMonitor, roomFor } from './containers.js';
import { createBackups } from './backups.js';
import { createNetwork } from './network.js';
import { createMonitoring } from './monitoring.js';
import { createAllocator } from './resources.js';
import { createServers } from './servers.js';
import { createStacks } from './stacks.js';
import { createTerminal } from './terminal.js';
import { createApps } from './apps.js';
import { createContainerTools } from './containertools.js';
import { createDomains } from './domains.js';
import { createSshKeys } from './sshkeys.js';
import { createUsers } from './users.js';
import { HttpError } from './http.js';
import { createPm2 } from './pm2.js';
import { createDocker } from './docker.js';
import { createLoadBalancer } from './loadbalancer.js';
import { createReplicas } from './replicas.js';
import { createNodes } from './nodes.js';
import { createSshConsole } from './sshconsole.js';
import { createNetTests } from './nettests.js';
import { createFleetOps } from './fleetops.js';
import { createDatabases } from './databases.js';
import { createSecurity } from './security.js';
import { createTwoFactor, enforceTwoFactor, loginTickets, twoFactorOn, mustSetup } from './twofactor.js';
import { createMaster } from './master.js';

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
const BACKUP_DISK_CHECK_MS = 10 * 60_000;

// ---------- State (in memory) ----------
const history = [];
const apps = {};
let pendingReq = 0;
let topProcs = [];
let tick = 0;
let info = null;
let hostMem = 0;
let backupDisk = null;

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
    memTotal: mem.total,
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
  return { info, history, apps: appList(), processes: topProcs, uptime: si.time().uptime };
}

async function takeSample() {
  const [load, mem, disks, nets, temp, fsStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats('*'),
    si.cpuTemperature(),
    si.fsStats().catch(() => null),
  ]);

  const root = disks.find((d) => d.mount === '/') || disks[0] || { used: 0, size: 0 };
  let rx = 0;
  let tx = 0;
  for (const n of nets) {
    // Container veth pairs and the bridge would count container traffic twice
    if (n.iface === 'lo' || /^(veth|lxdbr|br-|docker|virbr)/.test(n.iface)) continue;
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
    load1: round(load.avgLoad),
    ioRead: fsStats?.rx_sec > 0 ? Math.round(fsStats.rx_sec) : 0,
    ioWrite: fsStats?.wx_sec > 0 ? Math.round(fsStats.wx_sec) : 0,
    req,
  };

  history.push(point);
  if (history.length > MAX_POINTS) history.shift();
  monitoring.recordHost(point);

  if (tick++ % PROCESS_EVERY === 0) {
    const procs = await si.processes();
    topProcs = procs.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 8)
      .map((p) => ({ pid: p.pid, name: p.name, user: p.user, cpu: round(p.cpu), mem: (p.memRss || 0) * 1024 }));
  }

  // Host stats are for admins only
  io.to('admin').emit('sample', { point, uptime: si.time().uptime, processes: topProcs, apps: appList() });
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
app.set('trust proxy', false);
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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '100kb' }));

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => { nodes.handleUpgrade(req, socket, head); });
const io = new Server(server, {
  maxHttpBufferSize: 256 * 1024,
  // Agent connections (/agent/v1/connect) are WebSocket upgrades too; Socket.IO must leave them alone
  destroyUpgrade: false,
  // Block other websites from opening a socket with the user's cookie
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    cb(null, !origin || origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`);
  },
});

// ---------- modules ----------
const monitoring = createMonitoring({ io });
const containers = createContainerMonitor({
  io, sampleMs: SAMPLE_MS, maxPoints: MAX_POINTS, hostCores: () => info?.cores || 1, hostMem: () => hostMem,
  onSample: (name, s) => monitoring.recordContainer(name, s),
  onUnexpectedStop: (name) => monitoring.raise('container_stopped', `ct:${name}`, 'critical', `${name} stopped without anyone asking the panel to stop it`),
  onRecovered: (name) => monitoring.clear('container_stopped', `ct:${name}`),
});
const allocator = createAllocator({ containers, hostCores: () => info?.cores || 1, hostMem: () => hostMem });
const backups = createBackups({
  io, containers,
  onJobFinished: (row) => {
    if (row.status === 'failed') monitoring.raise('backup_failed', 'backup', 'critical', `Backup ${row.id} failed: ${row.error || 'see its log'}`);
    else if (row.status === 'success') monitoring.clear('backup_failed', 'backup');
  },
});
const network = createNetwork({ io });
const terminal = createTerminal({ containers });
const stacks = createStacks({ containers, backupCoverage: (name) => backups.coverage(name) });
const servers = createServers({ io, containers, allocator, stacks });
const appsMod = createApps({ io, containers });
const containerTools = createContainerTools({ containers });
const domains = createDomains({ containers, monitoring });
const sshKeys = createSshKeys({ containers });
// VPS fleet: nodes + agents, SSH console, network diagnostics, PM2/Docker on every node
const nodes = createNodes({ io, monitoring });
const sshConsole = createSshConsole();
const netTests = createNetTests({ io, nodes, monitoring });
const fleetOps = createFleetOps({ nodes });
const databasesMod = createDatabases();
const securityMod = createSecurity();
const master = createMaster({ sshConsole, nodes });
// Disconnects a user's live sockets (all of them, or all but one session)
const kickUser = (userId, exceptHash = null) => (exceptHash ? io.in(`user:${userId}`).except(`sess:${exceptHash}`) : io.in(`user:${userId}`)).disconnectSockets(true);
const twoFactor = createTwoFactor({ kickUser });
const usersMod = createUsers({ io, containers, terminal: { closeForUser: (id, why) => { terminal.closeForUser(id, why); sshConsole.closeForUser(id, why); } } });
// Host infrastructure (the VPS itself): PM2, Docker, replicated apps behind Nginx
const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'panel.db'));
const pm2Mod = createPm2({ dataDir: DATA_DIR });
const dockerMod = createDocker();
const lb = createLoadBalancer();
const replicas = createReplicas({ io, pm2: pm2Mod, lb, monitoring });

// Backup disk: mounted, free space, SMART (through the root helper, cached)
async function checkBackupDisk() {
  try {
    const d = await backups.diskStatus(true);
    backupDisk = { at: Date.now(), ...d };
    if (!d.mounted) monitoring.raise('backup_disk', 'backup-disk', 'critical', `Backup disk is not mounted at ${d.mountpoint}`);
    else monitoring.clear('backup_disk', 'backup-disk');
    const freePct = d.total ? (d.free / d.total) * 100 : null;
    const limit = Number(settings.get('alert_backup_disk_free') ?? 15);
    if (freePct != null && freePct < limit) monitoring.raise('backup_disk_space', 'backup-disk', freePct < limit / 2 ? 'critical' : 'warning', `Backup disk has only ${freePct.toFixed(0)}% free`);
    else monitoring.clear('backup_disk_space', 'backup-disk');
    if (d.smart?.health === 'FAILED') monitoring.raise('backup_disk_smart', 'backup-disk', 'critical', 'Backup disk SMART health check FAILED. Replace the disk.');
    else monitoring.clear('backup_disk_smart', 'backup-disk');
  } catch (err) {
    backupDisk = { at: Date.now(), error: err.message };
  }
}

// Your other apps send request counts here (see panel-tracker.cjs).
// Machine-to-machine: protected by INGEST_TOKEN instead of a login session.
app.post('/api/ingest', (req, res) => {
  if (!INGEST_TOKEN) {
    return res.status(503).json({ error: 'Set INGEST_TOKEN in backend/.env to accept request counts' });
  }
  if (!safeEqual(req.get('x-panel-token') || '', INGEST_TOKEN)) {
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

// Health check for uptime monitors / deploy scripts (no secrets, no login)
// Agent enrollment is public (a one-time token proves the caller); agents send no cookies or Origin
app.use('/agent', rateLimit({ perMinute: 30, name: 'agent' }));
app.use(nodes.publicRouter);
// Agent download for the installer (open source file, no secrets)
const AGENT_DIR = path.join(__dirname, '..', 'agent');
app.get('/agent/v1/kapil-agent.js', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').sendFile(path.join(AGENT_DIR, 'kapil-agent.js'));
});
// Installer with the agent's checksum baked in, so the server refuses a tampered download
app.get('/agent/v1/install.sh', (_req, res) => {
  const agent = fs.readFileSync(path.join(AGENT_DIR, 'kapil-agent.js'));
  const sum = crypto.createHash('sha256').update(agent).digest('hex');
  res.set('Cache-Control', 'no-store');
  res.type('text/x-shellscript').send(fs.readFileSync(path.join(AGENT_DIR, 'install-agent.sh'), 'utf8').replace('__AGENT_SHA256__', sum));
});

app.get('/healthz', (_req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.set('Cache-Control', 'no-store');
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, lxd: !containers.error(), uptime: Math.round(process.uptime()) });
});

app.use(loadSession);
app.use(csrfProtect);
app.use('/api', rateLimit({ perMinute: 600 }));

const kick = (room) => io.in(room).disconnectSockets(true);

// ---------- login / logout (public) ----------
app.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  const wait = loginLimit.retryAfter(ip);
  const { username, password } = req.body ?? {};
  const name = typeof username === 'string' && username.length <= 64 ? username.trim().toLowerCase() : '';
  if (wait) {
    audit.log({ username: name || null, ip, action: 'login', result: 'failure', detail: 'rate limited' });
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many failed logins. Try again in ${Math.ceil(wait / 60)} minutes.` });
  }

  const user = name ? users.withHash(name) : null;
  const pw = typeof password === 'string' && password.length <= 200 ? password : '';
  const ok = await checkPassword(pw, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) {
    loginLimit.fail(ip);
    audit.log({ username: name || null, ip, action: 'login', result: 'failure', detail: user ? 'wrong password' : 'unknown user' });
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  if (user.status !== 'active') {
    audit.log({ username: user.username, ip, action: 'login', result: 'failure', detail: 'account suspended' });
    return res.status(403).json({ error: 'This account is suspended. Contact the administrator.' });
  }

  if (twoFactorOn(user.id)) {
    audit.log({ username: user.username, ip, action: 'login_password', result: 'success', detail: 'waiting for two-factor code' });
    return res.json({ twoFactor: true, ticket: loginTickets.issue(user.id, ip) });
  }
  return finishLogin(req, res, user, ip);
});

function finishLogin(req, res, user, ip, detail = null) {
  if (req.session) endSession(res, req.session.token_hash); // never reuse a session across logins
  startSession(res, user.id, { ip, userAgent: req.get('user-agent') });
  users.markLogin(user.id, ip);
  audit.log({ username: user.username, ip, action: 'login', result: 'success', detail });
  return res.json({ ok: true });
}

// Second login step: the 6-digit code (or a recovery code) for the ticket from /api/login
app.post('/api/login/2fa', (req, res) => {
  const ip = clientIp(req);
  const wait = loginLimit.retryAfter(ip);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many failed logins. Try again in ${Math.ceil(wait / 60)} minutes.` });
  }
  try {
    const { userId, method } = loginTickets.redeem(req.body?.ticket, req.body?.code, ip);
    const user = users.byId(userId);
    if (!user || user.status !== 'active') return res.status(403).json({ error: 'This account is suspended. Contact the administrator.' });
    return finishLogin(req, res, user, ip, method === 'recovery' ? 'two-factor (recovery code)' : 'two-factor');
  } catch (e) {
    const u = e.userId ? users.byId(e.userId) : null;
    audit.log({ username: u?.username || null, ip, action: 'login', result: 'failure', detail: `two-factor: ${e.message}` });
    return res.status(e.status || 400).json({ error: e.message });
  }
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
app.use(enforceTwoFactor);

// ---------- account ----------
app.get('/api/me', (req, res) => {
  const s = req.session;
  const u = users.byId(s.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    id: s.id, username: s.username, role: s.role, isAdmin: isAdmin(s), containers: s.containers, csrf: s.csrf,
    fullName: u?.full_name || null, email: u?.email || null, lastLoginAt: u?.last_login_at || null,
    twoFactor: twoFactorOn(s.id), mustSetup2fa: mustSetup(s),
    // kept for older frontends
    container: s.role === 'user' ? s.containers[0] || null : null,
  });
});

// ---------- host stats (admin) ----------
app.get('/api/snapshot', requireAdmin, (_req, res) => res.json(snapshot()));

app.get('/api/overview', (req, res) => {
  const s = req.session;
  res.set('Cache-Control', 'no-store');
  const mine = containers.all().filter((c) => c && (isAdmin(s) || s.containers.includes(c.name)));
  const base = {
    servers: { total: mine.length, running: mine.filter((c) => c.status === 'Running').length, stopped: mine.filter((c) => c.status !== 'Running').length },
    apps: isAdmin(s) ? db.prepare('SELECT COUNT(*) AS n FROM apps').get().n : db.prepare(`SELECT COUNT(*) AS n FROM apps WHERE container IN (SELECT container FROM user_containers WHERE user_id = ?)`).get(s.id).n,
    domains: isAdmin(s) ? db.prepare("SELECT COUNT(*) AS n FROM domains WHERE status = 'active'").get().n : db.prepare("SELECT COUNT(*) AS n FROM domains WHERE status = 'active' AND container IN (SELECT container FROM user_containers WHERE user_id = ?)").get(s.id).n,
  };
  if (!isAdmin(s)) return res.json(base);
  const activeSince = Date.now() - 15 * 60_000;
  const lastJob = backupJobs.recent(1)[0] || null;
  return res.json({
    ...base,
    host: { info, last: history.at(-1) || null, uptime: si.time().uptime },
    users: {
      total: users.list().length,
      active: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen_at > ? AND expires_at > ?').get(activeSince, Date.now()).n,
      suspended: db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'").get().n,
    },
    backup: { lastJob: lastJob && { id: lastJob.id, status: lastJob.status, finishedAt: lastJob.finished_at, size: lastJob.size, error: lastJob.error }, disk: backupDisk },
    alerts: monitoring.openAlerts(),
    pendingDomains: db.prepare("SELECT COUNT(*) AS n FROM domains WHERE status = 'pending'").get().n,
    lxdError: containers.error(),
    terminals: terminal.list().length,
    consoles: sshConsole.list().length,
    hostApps: replicas.counts(),
  });
});

// ---------- audit log (admin) ----------
app.get('/api/audit', requireAdmin, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const before = /^\d+$/.test(req.query.before || '') ? Number(req.query.before) : null;
  const filters = {
    username: typeof req.query.user === 'string' && req.query.user ? req.query.user.slice(0, 64) : null,
    action: typeof req.query.action === 'string' && req.query.action ? req.query.action.slice(0, 64) : null,
    q: typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null,
  };
  res.json({ entries: audit.recent(limit, before, filters) });
});

// ---------- modules ----------
app.use('/api', servers.router);
app.use('/api', stacks.router);
app.use('/api', usersMod.router);
app.use('/api', appsMod.router);
app.use('/api', containerTools.router);
app.use('/api', domains.router);
app.use('/api', sshKeys.router);
app.use('/api', monitoring.router);
app.use('/api/my-backups', backups.userRouter);
app.use('/api/backups', requireAdmin, backups.router);
app.use('/api/net', requireAdmin, network.router);
app.use('/api/pm2', pm2Mod.router);
app.use('/api/docker', dockerMod.router);
app.use('/api/infra', replicas.router);
app.use('/api', nodes.router);
app.use('/api', sshConsole.router);
app.use('/api', netTests.router);
app.use('/api', fleetOps.router);
app.use('/api', twoFactor.router);
app.use('/api', master.router);
app.use('/api/databases', databasesMod.router);
app.use('/api/security', securityMod.router);
app.get('/api/terminals', requireAdmin, (_req, res) => res.json({ terminals: terminal.list() }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler: known errors keep their status, anything else is logged and returned as 500
app.use((err, req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  const status = err instanceof HttpError || (err?.status >= 400 && err?.status < 600) ? err.status : 500;
  if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err);
  return res.status(status).json({ error: err?.message || 'Something went wrong' });
});

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
  const ip = (typeof socket.handshake.headers['cf-connecting-ip'] === 'string' && socket.handshake.headers['cf-connecting-ip'].slice(0, 64)) || socket.handshake.address;
  socket.join([`sess:${s.token_hash}`, `user:${s.id}`]);
  // An admin who still has to set up two-factor login gets no live data, terminals or consoles
  if (mustSetup(s)) return;
  if (isAdmin(s)) {
    socket.join('admin');
    socket.emit('init', snapshot());
    socket.emit('containers:init', containers.names().map(containers.view));
  } else {
    socket.join(s.containers.map(roomFor));
    socket.emit('containers:init', s.containers.filter(containers.exists).map(containers.view));
  }
  terminal.attach(socket, ip);
  sshConsole.attach(socket, ip);
});

// Drop live sockets whose session expired or was revoked
setInterval(async () => {
  for (const socket of await io.fetchSockets()) {
    if (!sessions.find(socket.data.session.token_hash)) socket.disconnect(true);
  }
}, 60_000).unref();

await loadInfo();
server.listen(PORT, HOST, () => {
  console.log(`Kapil Cloud panel running on http://${HOST}:${PORT}`);
  if (!INGEST_TOKEN) console.log('INGEST_TOKEN is empty: request counting is off until you set it in .env');
  if (!users.list().length) console.log('No users yet. Create the first admin with: node scripts/create-user.js');
});
loop();

// A staging copy next to the real panel must not run backup helpers, repair Cloudflare routes or health-check
// apps: the real panel already does. Reading LXD is different, because the server list, the "name is taken" check
// and every per-server page depend on it, and without the loop the list is empty after each restart.
const STAGING = process.env.STAGING_MODE === '1';
// Backup polling only reads the helper's job files (the systemd timer runs the backups), so staging
// does it too: otherwise its Backups page never sees runs finish and stays on "Starting…".
backups.start();
containers.start();
if (!STAGING) {
  monitoring.start();
  domains.start();
  replicas.start();
  nodes.start();
  netTests.start();
}
if (!STAGING && process.env.BACKUP_DISK_CHECK !== 'off') {
  const diskLoop = () => checkBackupDisk().finally(() => setTimeout(diskLoop, BACKUP_DISK_CHECK_MS).unref());
  setTimeout(diskLoop, 20_000).unref();
}

// Graceful stop for PM2 restarts: finish in-flight requests, then exit
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.log(`${sig}: shutting down`);
    io.close();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
