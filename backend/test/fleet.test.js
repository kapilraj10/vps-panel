// End-to-end tests for the VPS fleet: node registry, the REAL agent (agent/kapil-agent.js) as two nodes, heartbeats with
// measured facts, status/incidents/uptime, network diagnostics run by the agents, the server matrix, PM2/Docker through
// agents, and the SSH console against a real SSH server (ssh2) with host-key pinning and command audit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import ssh2 from 'ssh2';
import { io as ioClient } from 'socket.io-client';
import { startFakeLxd } from './fake-lxd.js';
import { startFakeDocker } from './fake-docker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(here, '..', '..', 'agent', 'kapil-agent.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-fleet-test-'));
const DB = path.join(tmp, 'panel.db');
const PORT = 5200 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
const PM2_STATE = path.join(tmp, 'pm2.json');
const node = process.execPath;
let lxd;
let docker;
let proc;
let logs = '';
const agents = {};
let sshServer;
let sshPort;
let panelPub;
const sshSeen = { commands: [] };

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, body) {
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-csrf-token': this.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  async login(u) {
    const r = await this.req('POST', '/api/login', { username: u, password: PW });
    if (r.status === 200) this.csrf = (await this.req('GET', '/api/me')).data.csrf;
    return r;
  }
  get = (u) => this.req('GET', u);
  post = (u, b = {}) => this.req('POST', u, b);
  put = (u, b = {}) => this.req('PUT', u, b);
  del = (u, b = {}) => this.req('DELETE', u, b);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting\n${logs.slice(-1500)}`);
    await sleep(200);
  }
}
const sup = new Client();
const ops = new Client();
const user = new Client();
const setting = (k, v) => { const d = new Database(DB); d.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, 0, 'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v)); d.close(); };
const nodeById = async (id) => (await sup.get(`/api/nodes/${id}`)).data;

// ---------- a real SSH server (ssh2) ----------
function startSsh(port, hostKey, allowedPub) {
  return new Promise((resolve) => {
    const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => {
        const ok = ctx.method === 'publickey' && ctx.username === 'kapil' && allowedPub
          && ctx.key.algo === allowedPub.type && Buffer.compare(ctx.key.data, allowedPub.getPublicSSH()) === 0
          && (!ctx.signature || allowedPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true);
        return ok ? ctx.accept() : ctx.reject(['publickey']);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acc, _rej, info) => { const s = acc(); sshSeen.commands.push(info.command); s.write('Linux test-node 6.8.0 x86_64\nUbuntu 24.04 LTS\n up 3 days\n'); s.exit(0); s.end(); });
          session.on('pty', (acc) => acc());
          session.on('window-change', (acc) => acc?.());
          session.on('shell', (acc) => {
            const s = acc();
            s.write('welcome to test-node\r\n$ ');
            let line = '';
            s.on('data', (d) => {
              for (const ch of d.toString()) {
                if (ch === '\r') {
                  s.write('\r\n');
                  if (line.startsWith('sudo')) s.write('[sudo] password for kapil: ');
                  else if (line === 'exit') { s.exit(0); s.end(); return; } else s.write(`ran: ${line}\r\n$ `);
                  line = '';
                } else { line += ch; s.write(ch); }
              }
            });
          });
        });
      });
      client.on('error', () => {});
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function startAgent(name, cfgFile, env = {}) {
  const p = spawn(node, [AGENT, 'run', '--config', cfgFile], { env: { ...process.env, PM2_BIN: `${node} ${path.join(here, 'fake-pm2.js')}`, FAKE_PM2_STATE: PM2_STATE, DOCKER_SOCKET: path.join(tmp, 'docker.sock'), ...env } });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.stderr.on('data', (d) => { p.out += d; });
  agents[name] = p;
  return p;
}
const enroll = (token, cfgFile) => execFileSync(node, [AGENT, 'enroll', '--master', BASE, '--token', token, '--config', cfgFile], { encoding: 'utf8' });

before(async () => {
  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL)`);
  const h = bcrypt.hashSync(PW, 4);
  for (const [u, role] of [['kapil', 'admin'], ['ops', 'user'], ['dev', 'user']]) d.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, 1)').run(u, h, role);
  d.close();
  fs.writeFileSync(PM2_STATE, JSON.stringify({ next: 1, procs: [{ name: 'gyann-api', pm_id: 0, pid: 0, status: 'stopped', env: { PORT: '0' }, restarts: 0 }] }));
  lxd = await startFakeLxd(path.join(tmp, 'lxd.sock'), { instances: {} });
  docker = await startFakeDocker(path.join(tmp, 'docker.sock'));
  docker.containers.set('c'.repeat(64), { id: 'c'.repeat(64), name: 'postgres', image: 'postgres:16', env: [], labels: {}, hostConfig: {}, state: 'exited', created: Date.now(), restarts: 0 });
  proc = spawn(node, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: path.join(tmp, 'lxd.sock'), SESSION_SECRET: 'z'.repeat(64),
      COOKIE_SECURE: 'false', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '',
      DOCKER_SOCKET: path.join(tmp, 'nodocker.sock'), NODE_METRIC_BUCKET_MS: '2000', NODE_PROBE_MS: '1000',
    },
  });
  proc.stdout.on('data', (x) => { logs += x; });
  proc.stderr.on('data', (x) => { logs += x; });
  await until(() => logs.includes('running on'));
  const d2 = new Database(DB);
  d2.prepare("UPDATE users SET role = 'admin' WHERE username = 'ops'").run();
  d2.close();
  setting('node_heartbeat_seconds', 1);
  setting('node_offline_seconds', 4);
  setting('net_matrix_minutes', 0);
  for (const [c, u] of [[sup, 'kapil'], [ops, 'ops'], [user, 'dev']]) assert.equal((await c.login(u)).status, 200);
  const pub = ssh2.utils.parseKey((await sup.get('/api/ssh/public-key')).data.publicKey);
  sshPort = 26000 + Math.floor(Math.random() * 3000); // outside the host test's replica port range
  panelPub = pub;
  sshServer = await startSsh(sshPort, ssh2.utils.generateKeyPairSync('ed25519').private, pub);
});

after(async () => {
  for (const a of Object.values(agents)) a.kill();
  try { execFileSync(node, [path.join(here, 'fake-pm2.js'), 'killall'], { env: { ...process.env, FAKE_PM2_STATE: PM2_STATE } }); } catch { /* ignore */ }
  sshServer?.close();
  proc?.kill('SIGTERM');
  await sleep(300);
  await docker?.close();
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let main;
let tulsi;
test('registry: only admins see servers, only a super admin adds; validation; first server is primary', async () => {
  assert.equal((await user.get('/api/nodes')).status, 403);
  assert.equal((await user.get('/api/me')).status, 200, 'user routes still work');
  assert.equal((await user.get('/api/nope')).status, 404, 'unknown routes are 404, not swallowed by an admin guard');
  assert.equal((await ops.post('/api/nodes', { name: 'x' })).status, 403);
  assert.equal((await sup.post('/api/nodes', { name: 'Bad', publicIp: 'not an ip;rm' })).status, 400);
  assert.equal((await sup.post('/api/nodes', { name: 'Bad', sshUser: 'Root$' })).status, 400);
  let r = await sup.post('/api/nodes', { name: 'Kathmandu Main', provider: 'Own hardware', location: 'Kathmandu', publicIp: '127.0.0.1', sshPort, sshUser: 'kapil', netZone: 'ktm' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  main = r.data.node;
  assert.equal(main.is_primary, 1);
  assert.equal(main.agent_key_hash, undefined, 'secrets never sent');
  r = await sup.post('/api/nodes', { name: 'Tulsi Super', provider: 'Tulsi DC', location: 'Tulsipur', publicIp: '127.0.0.1', sshPort: 1, sshUser: 'kapil' });
  tulsi = r.data.node;
  assert.equal(tulsi.is_primary, 0);
  assert.equal((await sup.post('/api/nodes', { name: 'tulsi super' })).status, 409, 'names are unique (case-insensitive)');
});

test('installer is public and carries the SHA-256 of the agent it downloads', async () => {
  const sh = await (await fetch(`${BASE}/agent/v1/install.sh`)).text();
  const js = Buffer.from(await (await fetch(`${BASE}/agent/v1/kapil-agent.js`)).arrayBuffer());
  const sum = (await import('node:crypto')).createHash('sha256').update(js).digest('hex');
  assert.ok(sh.includes(`AGENT_SHA256="${sum}"`));
  assert.equal(js.equals(fs.readFileSync(AGENT)), true);
  assert.equal((await fetch(`${BASE}/agent/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"nope"}' })).status, 401);
});

test('status comes from real checks: SSH port answering = no_agent, closed port = unreachable (never "online" from the record)', async () => {
  await until(async () => (await nodeById(main.id)).node.status === 'no_agent');
  await until(async () => (await nodeById(tulsi.id)).node.status === 'unreachable');
  assert.equal((await nodeById(main.id)).node.agentConnected, false);
});

test('enrollment: one-time token; the agent connects, sends measured facts, node goes online', async () => {
  assert.equal((await ops.post(`/api/nodes/${main.id}/enroll-token`)).status, 403);
  const t1 = (await sup.post(`/api/nodes/${main.id}/enroll-token`)).data.token;
  const t2 = (await sup.post(`/api/nodes/${tulsi.id}/enroll-token`)).data.token;
  assert.match(enroll(t1, path.join(tmp, 'main.json')), /Enrolled as node/);
  assert.throws(() => enroll(t1, path.join(tmp, 'again.json')), /wrong or expired/, 'token is single-use');
  enroll(t2, path.join(tmp, 'tulsi.json'));
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'main.json'), 'utf8'));
  assert.equal(fs.statSync(path.join(tmp, 'main.json')).mode & 0o777, 0o600);
  assert.equal(cfg.manage.pm2, false, 'management is off by default');
  fs.writeFileSync(path.join(tmp, 'main.json'), JSON.stringify({ ...cfg, manage: { pm2: true, docker: true } }));
  startAgent('main', path.join(tmp, 'main.json'));
  startAgent('tulsi', path.join(tmp, 'tulsi.json'));
  await until(async () => (await nodeById(main.id)).node.status === 'online');
  await until(async () => (await nodeById(tulsi.id)).node.status === 'online');
  const d = await until(async () => { const x = await nodeById(main.id); return x.facts?.cpu?.usage != null ? x : null; });
  assert.equal(d.facts.cpu.cores, os.cpus().length);
  assert.equal(d.facts.memory.total > 0 && Math.abs(d.facts.memory.total - os.totalmem()) < 64 * 1024 * 1024, true);
  assert.equal(d.facts.system.hostname, os.hostname());
  assert.ok(d.facts.disks.some((x) => x.mount === '/'));
  assert.ok(d.facts.network.listening.some((l) => l.port === PORT), 'the panel port shows as listening');
  assert.equal(d.facts.cpu.perCore.length, os.cpus().length);
  assert.equal(d.node.cores, os.cpus().length);
  assert.equal(d.node.agent_version, '1.0.0');
});

test('an agent with a wrong key is refused and audited', async () => {
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ master: BASE, nodeId: JSON.parse(fs.readFileSync(path.join(tmp, 'main.json'), 'utf8')).nodeId, key: 'wrong' }));
  const p = startAgent('bad', bad);
  await until(() => p.out.includes('refused'));
  p.kill();
  const a = (await sup.get('/api/audit?action=agent_connect')).data.entries;
  assert.ok(a.some((e) => e.result === 'failure'));
  assert.equal((await nodeById(main.id)).node.status, 'online', 'the real agent stays connected');
});

test('metric history is stored per bucket and readable per range', async () => {
  const pts = await until(async () => { const r = (await sup.get(`/api/nodes/${main.id}/metrics?range=1h`)).data.points; return r.length >= 2 ? r : null; });
  assert.ok(pts.every((p) => p.cpu >= 0 && p.cpu <= 100 && p.mem_total > 0));
  const cmp = (await ops.get(`/api/fleet/compare?ids=${main.id},${tulsi.id}&range=1h`)).data;
  assert.equal(cmp.nodes.length, 2);
  assert.ok(cmp.nodes[0].history.length >= 1);
  assert.ok(cmp.nodes[0].live.memTotal > 0);
});

test('agent stops: agent_disconnected while SSH answers, offline when nothing answers; incidents + alerts; recovery closes them', async () => {
  agents.main.kill();
  await until(async () => (await nodeById(main.id)).node.status === 'agent_disconnected');
  let alerts = (await sup.get('/api/alerts?open=1')).data.alerts;
  assert.ok(alerts.some((a) => a.kind === 'node_agent' && a.target === `node:${main.id}`));
  await new Promise((r) => sshServer.close(r));
  await until(async () => (await nodeById(main.id)).node.status === 'offline');
  alerts = (await sup.get('/api/alerts?open=1')).data.alerts;
  assert.ok(alerts.some((a) => a.kind === 'node_offline' && a.level === 'critical'));
  const inc = (await sup.get(`/api/nodes/${main.id}/incidents`)).data.incidents;
  assert.deepEqual(inc.map((i) => i.kind).slice(0, 2), ['offline', 'agent_disconnected']);
  sshServer = await startSsh(sshPort, ssh2.utils.generateKeyPairSync('ed25519').private, panelPub); // NB: new host key
  startAgent('main', path.join(tmp, 'main.json'));
  await until(async () => (await nodeById(main.id)).node.status === 'online');
  const n = (await nodeById(main.id)).node;
  assert.equal(n.openIncident, null);
  assert.ok(n.uptime24h < 100 && n.uptime24h > 0, `uptime ${n.uptime24h}`);
  await until(async () => !(await sup.get('/api/alerts?open=1')).data.alerts.some((a) => a.target === `node:${main.id}` && ['node_offline', 'node_agent'].includes(a.kind)));
  const all = (await ops.get('/api/fleet/incidents')).data.incidents;
  assert.ok(all.every((i) => i.ended_at || i.node_id !== main.id));
});

test('maintenance and agent disconnect/connect from the panel', async () => {
  await sup.post(`/api/nodes/${tulsi.id}/maintenance`, { on: true });
  assert.equal((await nodeById(tulsi.id)).node.status, 'maintenance');
  await sup.post(`/api/nodes/${tulsi.id}/maintenance`, { on: false });
  assert.equal((await sup.post(`/api/nodes/${tulsi.id}/agent/disconnect`)).status, 200);
  await until(async () => !(await nodeById(tulsi.id)).node.agentConnected);
  await until(() => agents.tulsi.out.includes('disconnected by an admin'));
  assert.equal((await sup.post(`/api/nodes/${tulsi.id}/agent/connect`)).status, 200);
  await until(async () => (await nodeById(tulsi.id)).node.agentConnected, 40000);
  const t = await sup.post(`/api/nodes/${tulsi.id}/agent/test`);
  assert.equal(t.status, 200);
  assert.equal(t.data.hostname, os.hostname());
});

test('network diagnostics run on the agent: ping, tcp, http, traceroute, dns; unregistered targets refused', async () => {
  let r = await ops.post('/api/nettests', { kind: 'ping', sourceId: main.id, targetNodeId: tulsi.id, count: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.test.status, 'success');
  assert.equal(r.data.test.result.received, 3);
  assert.ok(r.data.test.result.avg >= 0);
  assert.equal((await ops.post('/api/nettests', { kind: 'ping', sourceId: main.id, target: '8.8.8.8' })).status, 400, 'not authorized');
  assert.equal((await ops.post('/api/nettests', { kind: 'ping', sourceId: main.id, target: '1.1.1.1; reboot' })).status, 400);
  assert.equal((await ops.post('/api/net-targets', { host: '127.0.0.2' })).status, 403, 'only super admin authorizes targets');
  assert.equal((await sup.post('/api/net-targets', { host: '127.0.0.2', note: 'loopback alias' })).status, 201);
  r = await ops.post('/api/nettests', { kind: 'ping', sourceId: tulsi.id, target: '127.0.0.2', count: 2 });
  assert.equal(r.data.test.status, 'success');
  r = await ops.post('/api/nettests', { kind: 'tcp', sourceId: main.id, targetNodeId: tulsi.id, port: PORT });
  assert.equal(r.data.test.result.open, true);
  r = await ops.post('/api/nettests', { kind: 'tcp', sourceId: main.id, targetNodeId: tulsi.id, port: sshPort });
  assert.match(r.data.test.result.banner, /^SSH-2\.0/, 'SSH banner read');
  r = await ops.post('/api/nettests', { kind: 'http', sourceId: main.id, url: `http://127.0.0.1:${PORT}/healthz` });
  assert.equal(r.data.test.result.status, 200);
  assert.equal((await ops.post('/api/nettests', { kind: 'http', sourceId: main.id, url: 'https://example.com/' })).status, 400);
  r = await ops.post('/api/nettests', { kind: 'traceroute', sourceId: main.id, targetNodeId: tulsi.id, maxHops: 3 });
  assert.equal(r.status, 202);
  const tr = await until(async () => { const x = (await ops.get(`/api/nettests/${r.data.test.id}`)).data.test; return x.status !== 'running' ? x : null; }, 30000);
  assert.equal(tr.status, 'success', tr.error);
  assert.ok(tr.result.hops.length >= 1);
  r = await ops.post('/api/nettests', { kind: 'dns', sourceId: main.id, name: 'localhost', type: 'A' });
  assert.equal(r.data.test.status, 'success');
  assert.ok(r.data.test.result.ms >= 0);
  const list = (await ops.get('/api/nettests')).data.tests;
  assert.ok(list.length >= 6 && list[0].source_name);
});

test('server-to-server matrix: every connected node pings every other node and results are stored', async () => {
  assert.equal((await ops.post('/api/net-matrix/run')).status, 403);
  assert.equal((await sup.post('/api/net-matrix/run')).status, 202);
  const m = await until(async () => { const x = (await ops.get('/api/net-matrix')).data; return !x.running && x.latest.length >= 2 ? x : null; }, 30000);
  const pairs = m.latest.map((t) => `${t.source_id}->${t.target_id}`).sort();
  assert.deepEqual(pairs, [`${main.id}->${tulsi.id}`, `${tulsi.id}->${main.id}`].sort());
  assert.ok(m.latest.every((t) => t.status === 'success' && t.latency >= 0 && t.loss === 0));
  assert.equal(m.stats.length, 2);
  const h = (await ops.get(`/api/net-matrix/history?source=${main.id}&target=${tulsi.id}`)).data.points;
  assert.equal(h.length, 1);
});

test('PM2 and Docker on every node through agents; management only where the node allows it', async () => {
  const fleet = await until(async () => { const x = (await ops.get('/api/fleet/pm2')).data; return x.nodes.every((n) => n.processes.length) ? x : null; });
  assert.equal(fleet.nodes.find((n) => n.id === main.id).processes[0].name, 'gyann-api');
  let r = await sup.post(`/api/nodes/${tulsi.id}/pm2/0/restart`);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /not enabled on this node/);
  assert.equal((await ops.post(`/api/nodes/${main.id}/pm2/0/restart`)).status, 403);
  r = await sup.post(`/api/nodes/${main.id}/pm2/0/restart`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(JSON.parse(fs.readFileSync(PM2_STATE, 'utf8')).procs[0].restarts, 1);
  assert.equal((await sup.post(`/api/nodes/${main.id}/pm2/0/delete`, { confirm: 'x' })).status, 400);
  const live = (await ops.get(`/api/nodes/${main.id}/pm2`)).data;
  assert.equal(live.processes[0].status, 'online');
  assert.equal(live.processes[0].outLog, undefined, 'log paths stay on the node');
  const dk = (await ops.get(`/api/nodes/${main.id}/docker`)).data;
  assert.equal(dk.containers[0].name, 'postgres');
  assert.equal((await sup.post(`/api/nodes/${main.id}/docker/postgres/start`)).status, 200);
  assert.equal([...docker.containers.values()][0].state, 'running');
  assert.equal((await sup.post(`/api/nodes/${tulsi.id}/docker/postgres/stop`)).status, 502);
  assert.match((await ops.get(`/api/nodes/${main.id}/docker/postgres/logs`)).data.logs, /hello from postgres/);
});

// ---------- SSH console ----------
function sock(c) {
  const s = ioClient(BASE, { extraHeaders: { cookie: c.cookie }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
}
const emit = (s, ev, msg) => new Promise((r) => s.emit(ev, msg, r));

test('SSH: test pins the host key; console needs a pinned key, super admin; a changed host key is refused', async () => {
  let s = await sock(sup);
  // the host key changed when the server restarted earlier, but nothing was pinned yet: console refuses until tested
  let r = await emit(s, 'ssh:open', { nodeId: main.id, cols: 80, rows: 24 });
  assert.match(r.error, /Test SSH/);
  r = await sup.post(`/api/nodes/${main.id}/ssh/test`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pinnedNow, true);
  assert.match(r.data.hostKey, /^SHA256:/);
  assert.match(r.data.output, /Ubuntu 24\.04/);
  assert.equal((await sup.post(`/api/nodes/${tulsi.id}/ssh/test`)).status, 502, 'closed port');
  const o = await sock(ops);
  r = await emit(o, 'ssh:open', { nodeId: main.id });
  assert.match(r.error, /super admin/);
  o.close();
  // new host key on the same address -> refused
  await new Promise((res) => sshServer.close(res));
  sshServer = await startSsh(sshPort, ssh2.utils.generateKeyPairSync('ed25519').private, panelPub);
  r = await emit(s, 'ssh:open', { nodeId: main.id });
  assert.match(r.error, /Host key of Kathmandu Main changed/);
  assert.equal((await sup.post(`/api/nodes/${main.id}/ssh/forget-host-key`, { confirm: 'Kathmandu Main' })).status, 200);
  const re = await sup.post(`/api/nodes/${main.id}/ssh/test`);
  assert.equal(re.data.pinnedNow, true, JSON.stringify(re));
  s.close();
});

test('SSH console: live I/O, commands audited but not passwords, survives a browser reconnect', async () => {
  let s = await sock(sup);
  let out = '';
  const onData = (m) => { out += Buffer.from(m.data).toString(); };
  s.on('ssh:data', onData);
  const r = await emit(s, 'ssh:open', { nodeId: main.id, cols: 100, rows: 30 });
  assert.ok(r.id, JSON.stringify(r));
  await until(() => out.includes('welcome to test-node'));
  s.emit('ssh:input', { id: r.id, data: 'uptime\r' });
  await until(() => out.includes('ran: uptime'));
  s.emit('ssh:input', { id: r.id, data: 'sudo ls /root\r' });
  await until(() => out.includes('password for kapil'));
  s.emit('ssh:input', { id: r.id, data: 'hunter2-secret\r' });
  s.emit('ssh:resize', { id: r.id, cols: 120, rows: 40 });
  await sleep(300);
  // browser drops; console is kept for a while and can be re-attached with the replayed output
  s.close();
  await sleep(300);
  s = await sock(sup);
  out = '';
  s.on('ssh:data', (m) => { out += Buffer.from(m.data).toString(); });
  const again = await emit(s, 'ssh:attach', { id: r.id });
  assert.equal(again.id, r.id);
  await until(() => out.includes('ran: uptime'));
  const other = await sock(ops);
  assert.match((await emit(other, 'ssh:attach', { id: r.id })).error, /gone/, 'other users cannot attach');
  other.close();
  s.emit('ssh:input', { id: r.id, data: 'exit\r' });
  await sleep(500);
  const sess = (await sup.get('/api/terminal-sessions')).data.sessions.find((x) => x.id === r.id);
  assert.equal(sess.node_name, 'Kathmandu Main');
  assert.ok(sess.ended_at);
  const cmds = (await sup.get(`/api/terminal-sessions/${r.id}/commands`)).data.commands.map((c) => c.line);
  assert.deepEqual(cmds, ['uptime', 'sudo ls /root', 'exit']);
  assert.equal(JSON.stringify(cmds).includes('hunter2'), false, 'password typed after a prompt is not stored');
  assert.equal((await ops.get(`/api/terminal-sessions/${r.id}/commands`)).status, 403);
  s.close();
});

test('webhook URL is stored but never shown again; deleting a server needs its name and leaves the server alone', async () => {
  assert.equal((await sup.put('/api/settings', { notify_webhook_url: 'http://insecure' })).status, 400);
  assert.equal((await sup.put('/api/settings', { notify_webhook_url: 'https://hooks.example.com/T0/B0/secret' })).status, 200);
  const st = (await ops.get('/api/settings')).data.settings;
  assert.equal(st.notify_webhook_url.includes('secret'), false);
  await sup.put('/api/settings', { notify_webhook_url: '' });
  assert.equal((await sup.del(`/api/nodes/${tulsi.id}`, { confirm: 'tulsi' })).status, 400);
  assert.equal((await sup.del(`/api/nodes/${tulsi.id}`, { confirm: 'Tulsi Super' })).status, 200);
  await until(() => agents.tulsi.out.includes('refused'));
  assert.equal((await sup.get('/api/nodes')).data.nodes.length, 1);
});
