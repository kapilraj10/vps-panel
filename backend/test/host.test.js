// End-to-end tests for host infrastructure: PM2 manager, Docker manager, replicated apps behind the Nginx load balancer.
// Real panel process + fake pm2 CLI + fake Docker API + fake nginx -t/reload. Replicas are real HTTP servers (fake-app.js),
// so health checks, failover and rollbacks run against live processes. Nothing touches the real PM2/Docker/Nginx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { startFakeLxd } from './fake-lxd.js';
import { startFakeDocker } from './fake-docker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-host-test-'));
const DB = path.join(tmp, 'panel.db');
const PORT = 4800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
const R0 = 21000 + Math.floor(Math.random() * 300) * 10; // replica port range for this run
const CONF = path.join(tmp, 'nginx', 'conf');
const LOGS = path.join(tmp, 'nginx', 'log');
const FLAGS = path.join(tmp, 'flags');
const APPS = path.join(tmp, 'apps');
const PM2_STATE = path.join(tmp, 'pm2', 'state.json');
const node = process.execPath;
let lxd;
let docker;
let proc;
let logs = '';

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, body) {
    const r = await fetch(BASE + url, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-csrf-token': this.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  async login(username) {
    const r = await this.req('POST', '/api/login', { username, password: PW });
    if (r.status === 200) this.csrf = (await this.req('GET', '/api/me')).data.csrf;
    return r;
  }
  get = (u) => this.req('GET', u);
  post = (u, b = {}) => this.req('POST', u, b);
  put = (u, b = {}) => this.req('PUT', u, b);
  del = (u, b = {}) => this.req('DELETE', u, b);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting\n${logs.slice(-2000)}`);
    await sleep(150);
  }
}
const sup = new Client();
const ops = new Client();
const user = new Client();
const conf = (name) => fs.readFileSync(path.join(CONF, `app-${name}.conf`), 'utf8');
const opDone = (id) => until(async () => {
  const r = await sup.get(`/api/infra/apps/${id}`);
  return r.data.app && !r.data.app.busy && r.data.app.op_status !== 'running' ? r.data : null;
}, 30000);
const get = (port, p = '/') => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.status).catch(() => 0);

before(async () => {
  for (const d of [CONF, LOGS, FLAGS, APPS, path.dirname(PM2_STATE), path.join(APPS, 'web')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(APPS, 'web', 'server.js'), '// app code lives here');
  // The panel's own PM2 entry (the server gets pm_id=900 like PM2 sets it)
  fs.writeFileSync(PM2_STATE, JSON.stringify({ next: 0, procs: [{ name: 'vps-panel', pm_id: 900, pid: 0, status: 'online', env: {}, restarts: 0 }] }));
  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL)`);
  const h = bcrypt.hashSync(PW, 4);
  for (const [u, role] of [['kapil', 'admin'], ['ops', 'user'], ['dev', 'user']]) d.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, 1)').run(u, h, role);
  d.close();
  lxd = await startFakeLxd(path.join(tmp, 'lxd.sock'), { instances: {} });
  docker = await startFakeDocker(path.join(tmp, 'docker.sock'), { flags: FLAGS });
  proc = spawn(node, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: path.join(tmp, 'lxd.sock'), SESSION_SECRET: 'y'.repeat(64),
      COOKIE_SECURE: 'false', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '',
      PM2_BIN: `${node} ${path.join(here, 'fake-pm2.js')}`, FAKE_PM2_STATE: PM2_STATE, FAKE_FLAGS: FLAGS,
      DOCKER_SOCKET: path.join(tmp, 'docker.sock'),
      NGINX_TEST: `${node} ${path.join(here, 'fake-nginx.js')} test`, NGINX_RELOAD: `${node} ${path.join(here, 'fake-nginx.js')} reload`,
      NGINX_VERSION_CMD: `${node} ${path.join(here, 'fake-nginx.js')} version`,
      LB_CONF_DIR: CONF, LB_LOG_DIR: LOGS, LB_STATUS_PORT: String(R0 + 9), LB_PORTS: `${R0 + 100}-${R0 + 120}`, REPLICA_PORTS: `${R0}-${R0 + 8}`,
      HEALTH_INTERVAL_MS: '300', HEALTH_WAIT_MS: '6000', HOST_APP_ROOTS: APPS, pm_id: '900',
    },
  });
  proc.stdout.on('data', (x) => { logs += x; });
  proc.stderr.on('data', (x) => { logs += x; });
  await until(() => logs.includes('running on'));
  // ops = plain admin (promoted directly in the DB; roles are read from the DB on every request)
  const d2 = new Database(DB);
  d2.prepare("UPDATE users SET role = 'admin' WHERE username = 'ops'").run();
  d2.close();
  for (const [c, u] of [[sup, 'kapil'], [ops, 'ops'], [user, 'dev']]) assert.equal((await c.login(u)).status, 200);
});

after(async () => {
  try { execFileSync(node, [path.join(here, 'fake-pm2.js'), 'killall'], { env: { ...process.env, FAKE_PM2_STATE: PM2_STATE } }); } catch { /* ignore */ }
  proc?.kill('SIGTERM');
  await sleep(300);
  await docker?.close();
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- authorization ----------
test('host infrastructure: users get 403, plain admins read only, super admin changes', async () => {
  for (const u of ['/api/pm2/processes', '/api/docker/containers', '/api/infra/apps', '/api/infra/lb/status']) {
    assert.equal((await user.get(u)).status, 403, u);
    assert.equal((await ops.get(u)).status, 200, u);
  }
  assert.equal((await ops.post('/api/pm2/save')).status, 403);
  assert.equal((await ops.post('/api/docker/containers', { name: 'x', image: 'nginx:alpine' })).status, 403);
  assert.equal((await ops.post('/api/infra/apps', { name: 'abc', runtime: 'pm2' })).status, 403);
  // a non-admin still reaches ordinary user routes (the admin-only routers must not swallow them)
  assert.equal((await user.get('/api/me')).status, 200);
  assert.equal((await user.get('/api/ssh-keys')).status !== 403, true);
});

test('CSRF token is required for host changes', async () => {
  const c = new Client();
  await c.login('kapil');
  c.csrf = 'wrong';
  assert.equal((await c.post('/api/pm2/save')).status, 403);
});

// ---------- PM2 ----------
test('PM2: create only inside HOST_APP_ROOTS, list, restart, logs, delete with confirmation', async () => {
  assert.equal((await sup.post('/api/pm2/processes', { name: 'evil', cwd: '/etc', script: 'x.js' })).status, 400);
  assert.equal((await sup.post('/api/pm2/processes', { name: 'evil', cwd: '/tmp', script: 'x.js' })).status, 400);
  assert.equal((await sup.post('/api/pm2/processes', { name: 'evil', cwd: path.join(APPS, 'web'), script: '../../x.js' })).status, 400);
  assert.equal((await sup.post('/api/pm2/processes', { name: 'kc-x', cwd: path.join(APPS, 'web'), script: 'server.js' })).status, 400, 'kc- is reserved');
  const r = await sup.post('/api/pm2/processes', { name: 'api', cwd: path.join(APPS, 'web'), script: 'server.js', port: R0 + 50, env: 'A=1\nSECRET=x' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const list = (await ops.get('/api/pm2/processes')).data.processes;
  const p = list.find((x) => x.name === 'api');
  assert.equal(p.status, 'online');
  assert.equal(p.port, R0 + 50);
  assert.equal(p.outLog, undefined, 'log paths are not sent');
  await until(async () => (await get(R0 + 50)) === 200);
  assert.equal((await sup.post(`/api/pm2/processes/${p.id}/restart`)).status, 200);
  assert.equal((await ops.get('/api/pm2/processes')).data.processes.find((x) => x.name === 'api').restarts, 1);
  const lg = await ops.get(`/api/pm2/processes/${p.id}/logs?lines=50`);
  assert.equal(lg.status, 200);
  assert.match(lg.data.out, /fake app on/);
  assert.equal((await sup.post(`/api/pm2/processes/${p.id}/scale`, { instances: 3 })).status, 400, 'fork mode cannot scale');
  assert.equal((await sup.post(`/api/pm2/processes/${p.id}/explode`)).status, 404);
  assert.equal((await sup.del(`/api/pm2/processes/${p.id}`, { confirm: 'nope' })).status, 400);
  assert.equal((await sup.del(`/api/pm2/processes/${p.id}`, { confirm: 'api' })).status, 200);
  assert.equal((await sup.post('/api/pm2/save')).status, 200);
  assert.ok(JSON.parse(fs.readFileSync(PM2_STATE, 'utf8')).saved);
  // the panel cannot stop or delete itself
  const self = (await ops.get('/api/pm2/processes')).data.processes.find((x) => x.name === 'vps-panel');
  assert.equal(self.self, true);
  assert.equal((await sup.post('/api/pm2/processes/900/stop')).status, 400);
  assert.equal((await sup.del('/api/pm2/processes/900', { confirm: 'vps-panel' })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(PM2_STATE, 'utf8')).procs.find((x) => x.name === 'vps-panel').status, 'online');
});

// ---------- Docker ----------
test('Docker: info, safe create (127.0.0.1 ports, no bind mounts, not privileged), logs, stop/start, remove with confirm', async () => {
  const info = await ops.get('/api/docker/info');
  assert.equal(info.status, 200);
  assert.equal(info.data.version, '27.0.0-fake');
  assert.equal((await sup.post('/api/docker/containers', { name: 'bad', image: 'nginx:alpine', volumes: [{ source: '/', target: '/host' }] })).status, 400, 'host bind mount refused');
  assert.equal((await sup.post('/api/docker/containers', { name: 'bad', image: 'nginx:alpine; rm -rf /' })).status, 400);
  const r = await sup.post('/api/docker/containers', { name: 'web', image: 'nginx:alpine', ports: [{ host: R0 + 60, container: 80 }], volumes: [{ source: 'dbdata', target: '/data' }], env: 'TOKEN=tok-s3cr3t', memoryMb: 256 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const create = docker.calls.find((c) => c.path === '/containers/create' && c.query.name === 'web');
  assert.equal(create.body.HostConfig.Privileged, false);
  assert.deepEqual(create.body.HostConfig.PortBindings['80/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(R0 + 60) }]);
  assert.deepEqual(create.body.HostConfig.Binds, ['dbdata:/data']);
  assert.equal(create.body.HostConfig.Memory, 256 * 1024 * 1024);
  const list = (await ops.get('/api/docker/containers')).data.containers;
  const c = list.find((x) => x.name === 'web');
  assert.equal(c.state, 'running');
  assert.equal(c.ports[0].ip, '127.0.0.1');
  const insp = (await ops.get(`/api/docker/containers/${c.id}`)).data.container;
  assert.deepEqual(insp.envKeys, ['TOKEN'], 'only env names are shown');
  assert.equal(JSON.stringify(insp).includes('tok-s3cr3t'), false, 'env values never sent');
  assert.match((await ops.get(`/api/docker/containers/${c.id}/logs`)).data.logs, /hello from web/);
  assert.ok((await ops.get('/api/docker/stats')).data.stats[c.id].memory > 0);
  assert.equal((await sup.post(`/api/docker/containers/${c.id}/stop`)).status, 200);
  assert.equal((await sup.post(`/api/docker/containers/${c.id}/start`)).status, 200);
  assert.equal((await sup.del(`/api/docker/containers/${c.id}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await sup.del(`/api/docker/containers/${c.id}`, { confirm: 'web', force: true })).status, 200);
  assert.equal((await sup.post('/api/docker/images/pull', { image: 'acme/missing:1' })).status, 502);
  assert.equal((await sup.post('/api/docker/images/pull', { image: 'redis:7' })).status, 200);
  assert.ok((await ops.get('/api/docker/images')).data.images.some((i) => i.tags.includes('redis:7')));
  assert.equal((await sup.post('/api/docker/volumes', { name: 'cache' })).status, 201);
  assert.equal((await sup.del('/api/docker/volumes/cache', { confirm: 'x' })).status, 400);
  assert.equal((await sup.del('/api/docker/volumes/cache', { confirm: 'cache' })).status, 200);
  assert.equal((await sup.del(`/api/docker/networks/bridge`, { confirm: 'bridge' })).status, 400, 'built-in network protected');
});

// ---------- replicas + load balancer (PM2) ----------
let pmApp;
test('replicas (PM2): primary + 2 replicas on real ports, Nginx upstream written and validated', async () => {
  assert.equal((await sup.post('/api/infra/apps', { name: 'pos', runtime: 'pm2', cwd: '/etc', script: 'server.js' })).status, 400);
  const r = await sup.post('/api/infra/apps', {
    name: 'pos', runtime: 'pm2', cwd: path.join(APPS, 'web'), script: 'server.js', replicas: 3, basePort: R0, healthPath: '/health',
    env: 'DATABASE_URL=postgres://pos:secret@localhost/pos', serverName: 'pos.example.com', maxMemoryMb: 256,
  });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  pmApp = r.data.app;
  assert.equal(JSON.stringify(r.data).includes('secret'), false);
  const d = await opDone(pmApp.id);
  assert.equal(d.app.op_status, 'success', d.app.op_message);
  assert.deepEqual(d.replicas.map((x) => x.port), [R0, R0 + 1, R0 + 2]);
  assert.ok(d.replicas.every((x) => x.health === 'healthy' && x.runtime.status === 'online'));
  for (const x of d.replicas) assert.equal(await get(x.port), 200);
  const c = conf('pos');
  for (const x of d.replicas) assert.match(c, new RegExp(`server 127\\.0\\.0\\.1:${x.port} weight=1 max_fails=2 fail_timeout=10s;`));
  assert.match(c, new RegExp(`listen 127\\.0\\.0\\.1:${pmApp.lb_port};`));
  assert.match(c, /server_name pos\.example\.com;/);
  assert.ok(fs.existsSync(path.join(CONF, '00-kapil-common.conf')));
  assert.ok(fs.readFileSync(path.join(CONF, '..', 'reloads.log'), 'utf8').trim().split('\n').length >= 1);
  // PM2 process gets its own PORT and the app env
  const st = JSON.parse(fs.readFileSync(PM2_STATE, 'utf8'));
  const p1 = st.procs.find((p) => p.name === 'pos-1' || p.name === 'kc-pos-1');
  assert.equal(p1.env.PORT, String(R0 + 1));
  assert.equal(p1.env.DATABASE_URL, 'postgres://pos:secret@localhost/pos', 'all replicas share one database URL');
  // env values are never sent back
  const env = await sup.get(`/api/infra/apps/${pmApp.id}/env`);
  assert.deepEqual(env.data.env, { DATABASE_URL: '********' });
  assert.equal((await ops.get(`/api/infra/apps/${pmApp.id}/env`)).status, 403);
  // managed processes cannot be deleted from the PM2 page
  const kc = (await sup.get('/api/pm2/processes')).data.processes.find((p) => p.name === 'kc-pos-0');
  assert.equal(kc.managed, true);
  assert.equal((await sup.del(`/api/pm2/processes/${kc.id}`, { confirm: 'kc-pos-0' })).status, 400);
});

test('port conflicts are refused: a port in use on the host, or used by another app', async () => {
  const blocker = net.createServer().listen(R0 + 5, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const a = await sup.post('/api/infra/apps', { name: 'clash', runtime: 'pm2', cwd: path.join(APPS, 'web'), script: 'server.js', replicas: 1, basePort: R0 + 5 });
  assert.equal(a.status, 409);
  assert.match(a.data.error, /in use/);
  blocker.close();
  const b = await sup.post('/api/infra/apps', { name: 'clash', runtime: 'pm2', cwd: path.join(APPS, 'web'), script: 'server.js', replicas: 1, basePort: R0 + 1 });
  assert.equal(b.status, 409);
});

test('traffic switching: 50/25/25 weights, standby, disable; at least one must stay', async () => {
  const id = pmApp.id;
  let r = await sup.put(`/api/infra/apps/${id}/traffic`, { replicas: [{ idx: 0, weight: 50 }, { idx: 1, weight: 25 }, { idx: 2, weight: 25 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let c = conf('pos');
  assert.match(c, new RegExp(`127\\.0\\.0\\.1:${R0} weight=50 `));
  assert.match(c, new RegExp(`127\\.0\\.0\\.1:${R0 + 1} weight=25 `));
  r = await sup.put(`/api/infra/apps/${id}/traffic`, { replicas: [{ idx: 2, weight: 0 }, { idx: 1, enabled: false }] });
  assert.equal(r.status, 200);
  c = conf('pos');
  assert.match(c, new RegExp(`127\\.0\\.0\\.1:${R0 + 2} weight=1 max_fails=2 fail_timeout=10s backup;`), 'weight 0 = hot standby');
  assert.match(c, new RegExp(`127\\.0\\.0\\.1:${R0 + 1} .* down;`));
  r = await sup.put(`/api/infra/apps/${id}/traffic`, { replicas: [{ idx: 0, enabled: false }, { idx: 2, weight: 0 }] });
  assert.equal(r.status, 400, 'no active instance left');
  assert.equal((await ops.put(`/api/infra/apps/${id}/traffic`, { replicas: [{ idx: 0, weight: 1 }] })).status, 403);
  const ev = (await ops.get(`/api/infra/apps/${id}`)).data.events;
  assert.ok(ev.some((e) => e.kind === 'traffic' && /primary=100% r1=off r2=standby/.test(e.message)), JSON.stringify(ev.slice(0, 3)));
  r = await sup.put(`/api/infra/apps/${id}/traffic`, { replicas: [0, 1, 2].map((idx) => ({ idx, weight: 1, enabled: true })) });
  assert.equal(r.status, 200);
});

test('nginx -t failure: nothing changes (file and DB); reload failure: previous file restored', async () => {
  const id = pmApp.id;
  const before1 = conf('pos');
  fs.writeFileSync(path.join(CONF, '..', 'nginx-fail-test'), '');
  let r = await sup.put(`/api/infra/apps/${id}/traffic`, { replicas: [{ idx: 0, weight: 90 }] });
  fs.rmSync(path.join(CONF, '..', 'nginx-fail-test'));
  assert.equal(r.status, 422);
  assert.match(r.data.error, /rejected/);
  assert.equal(conf('pos'), before1);
  assert.equal((await sup.get(`/api/infra/apps/${id}`)).data.replicas[0].weight, 1, 'DB rolled back');
  fs.writeFileSync(path.join(CONF, '..', 'nginx-fail-reload'), '');
  r = await sup.put(`/api/infra/apps/${id}/traffic`, { replicas: [{ idx: 0, weight: 90 }] });
  fs.rmSync(path.join(CONF, '..', 'nginx-fail-reload'));
  assert.equal(r.status, 502);
  assert.match(r.data.error, /restored/);
  assert.equal(conf('pos'), before1);
  assert.equal((await sup.get(`/api/infra/apps/${id}`)).data.replicas[0].weight, 1);
});

test('health checks: unhealthy replica is taken out automatically (failover + alert) and comes back', async () => {
  const id = pmApp.id;
  fs.writeFileSync(path.join(FLAGS, `down-${R0 + 1}`), '');
  await until(() => new RegExp(`127\\.0\\.0\\.1:${R0 + 1} .* down;`).test(conf('pos')));
  const d = (await ops.get(`/api/infra/apps/${id}`)).data;
  assert.equal(d.replicas[1].health, 'unhealthy');
  assert.equal(d.replicas[1].lbState, 'down');
  assert.ok(d.events.some((e) => e.kind === 'health' && /unhealthy/.test(e.message)));
  const alerts = (await sup.get('/api/alerts?open=1')).data.alerts;
  assert.ok(alerts.some((a) => a.kind === 'replica_down' && a.target === 'app:pos:1'));
  fs.rmSync(path.join(FLAGS, `down-${R0 + 1}`));
  await until(() => !new RegExp(`127\\.0\\.0\\.1:${R0 + 1} .* down;`).test(conf('pos')));
  await until(async () => !(await sup.get('/api/alerts?open=1')).data.alerts.some((a) => a.target === 'app:pos:1'));
});

test('all replicas unhealthy: they stay in the upstream (no empty pool) and a critical app_down alert is raised', async () => {
  for (const p of [R0, R0 + 1, R0 + 2]) fs.writeFileSync(path.join(FLAGS, `down-${p}`), '');
  await until(async () => (await sup.get('/api/alerts?open=1')).data.alerts.some((a) => a.kind === 'app_down' && a.level === 'critical'));
  await sleep(800);
  assert.equal(/ down;/.test(conf('pos')), false);
  for (const p of [R0, R0 + 1, R0 + 2]) fs.rmSync(path.join(FLAGS, `down-${p}`));
  await until(async () => (await ops.get(`/api/infra/apps/${pmApp.id}`)).data.replicas.every((r) => r.health === 'healthy'));
});

test('replica stop/start, add, remove; rolling restart; concurrent change refused', async () => {
  const id = pmApp.id;
  let r = await sup.post(`/api/infra/apps/${id}/replicas/2/stop`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.replica.desired, 'stopped');
  assert.match(conf('pos'), new RegExp(`127\\.0\\.0\\.1:${R0 + 2} .* down;`));
  assert.equal(await get(R0 + 2), 0, 'process really stopped');
  r = await sup.post(`/api/infra/apps/${id}/replicas/2/start`);
  assert.equal(r.status, 200);
  assert.equal(await get(R0 + 2), 200);
  r = await sup.post(`/api/infra/apps/${id}/replicas`, { weight: 2 });
  assert.equal(r.status, 202);
  assert.equal(r.data.idx, 3);
  assert.equal(r.data.port, R0 + 3);
  await opDone(id);
  assert.match(conf('pos'), new RegExp(`127\\.0\\.0\\.1:${R0 + 3} weight=2 `));
  // rolling restart; a second change while it runs is refused
  r = await sup.post(`/api/infra/apps/${id}/rolling`);
  assert.equal(r.status, 202);
  assert.equal((await sup.post(`/api/infra/apps/${id}/rolling`)).status, 409);
  const d = await opDone(id);
  assert.equal(d.app.op_status, 'success', d.app.op_message);
  assert.ok(d.replicas.every((x) => x.runtime.restarts >= 1));
  assert.equal((await sup.del(`/api/infra/apps/${id}/replicas/3`, { confirm: 'replica 2' })).status, 400);
  assert.equal((await sup.del(`/api/infra/apps/${id}/replicas/3`, { confirm: 'replica 3' })).status, 200);
  assert.equal(conf('pos').includes(`:${R0 + 3} `), false);
  assert.equal(await get(R0 + 3), 0);
});

test('traffic numbers come from the Nginx access log: rps, status codes, share per replica, latency', async () => {
  const id = pmApp.id;
  await sup.get(`/api/infra/apps/${id}/traffic`); // starts following the log from now
  const now = Date.now() / 1000;
  const lines = [];
  for (let i = 0; i < 30; i += 1) lines.push(`${(now - 1).toFixed(3)} ${i < 27 ? 200 : 502} 0.0${(i % 9) + 1} "127.0.0.1:${R0 + (i % 3)}"`);
  lines.push(`${now.toFixed(3)} 200 0.010 "127.0.0.1:${R0 + 1}, 127.0.0.1:${R0}"`); // retried: counts for the last upstream
  fs.appendFileSync(path.join(LOGS, 'pos.access.log'), `${lines.join('\n')}\n`);
  const t = (await ops.get(`/api/infra/apps/${id}/traffic`)).data;
  assert.equal(t.last5m.requests, 31);
  assert.equal(t.last5m.codes.s5xx, 3);
  assert.equal(t.last5m.byPort[String(R0)], 11);
  assert.ok(t.series.length >= 1 && t.series.at(-1).rps > 0);
  assert.ok(t.last5m.avgMs > 0);
});

// ---------- replicas (Docker) with rolling update + automatic rollback ----------
test('replicas (Docker): rolling update to a broken image is rolled back; a good image rolls through', async () => {
  const r = await sup.post('/api/infra/apps', { name: 'shop', runtime: 'docker', image: 'acme/shop:1', containerPort: 3000, replicas: 2, healthPath: '/health', maxMemoryMb: 512, cpus: 0.5 });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const id = r.data.app.id;
  let d = await opDone(id);
  assert.equal(d.app.op_status, 'success', d.app.op_message);
  const made = docker.calls.filter((c) => c.path === '/containers/create' && c.query.name?.startsWith('kc-shop-'));
  assert.equal(made.length, 2);
  assert.equal(made[0].body.Labels['kapil.cloud.app'], 'shop');
  assert.equal(made[0].body.HostConfig.PortBindings['3000/tcp'][0].HostIp, '127.0.0.1');
  assert.equal(made[0].body.HostConfig.NanoCpus, 5e8);
  assert.ok(made[0].body.Env.includes('PORT=3000'));
  // replicas cannot be removed from the Docker page
  const kc = (await sup.get('/api/docker/containers')).data.containers.find((c) => c.name === 'kc-shop-0');
  assert.equal((await sup.del(`/api/docker/containers/${kc.id}`, { confirm: 'kc-shop-0', force: true })).status, 400);

  assert.equal((await sup.post(`/api/infra/apps/${id}/rolling`, { image: 'acme/shop:broken' })).status, 202);
  d = await opDone(id);
  assert.equal(d.app.op_status, 'failed');
  assert.match(d.app.op_message, /rolled back to acme\/shop:1/);
  assert.equal(d.app.version, 'acme/shop:1');
  assert.ok(d.replicas.every((x) => x.version === 'acme/shop:1' && x.runtime.image === 'acme/shop:1'), JSON.stringify(d.replicas.map((x) => x.runtime)));
  assert.ok(d.replicas.every((x) => x.health === 'healthy'));
  assert.equal(/ down;/.test(conf('shop')), false, 'drained replica is back in the pool');

  assert.equal((await sup.post(`/api/infra/apps/${id}/rolling`, { image: 'acme/shop:2' })).status, 202);
  d = await opDone(id);
  assert.equal(d.app.op_status, 'success', d.app.op_message);
  assert.equal(d.app.version, 'acme/shop:2');
  assert.ok(d.replicas.every((x) => x.runtime.image === 'acme/shop:2'));
  assert.equal((await sup.post(`/api/infra/apps/${pmApp.id}/rolling`, { image: 'x:1' })).status, 400, 'images are for Docker apps only');
});

test('overview counts host apps; deleting an app needs confirmation and removes processes + Nginx file', async () => {
  const o = (await sup.get('/api/overview')).data;
  assert.equal(o.hostApps.apps, 2);
  assert.ok(o.hostApps.replicas >= 5);
  assert.equal((await sup.del(`/api/infra/apps/${pmApp.id}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await sup.del(`/api/infra/apps/${pmApp.id}`, { confirm: 'pos' })).status, 200);
  assert.equal(fs.existsSync(path.join(CONF, 'app-pos.conf')), false);
  assert.equal(JSON.parse(fs.readFileSync(PM2_STATE, 'utf8')).procs.some((p) => p.name.startsWith('kc-pos-')), false);
  assert.equal(await get(R0), 0);
  const audit = (await sup.get('/api/audit?action=hostapp_delete')).data.entries;
  assert.equal(audit[0].target, 'pos');
});
