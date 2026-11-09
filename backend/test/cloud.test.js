// End-to-end tests: real panel process + fake LXD (test/fake-lxd.js) + a database in the OLD (pre-Kapil Cloud)
// schema, so the migration path that production will take is exercised too. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { io as ioClient } from 'socket.io-client';
import { startFakeLxd } from './fake-lxd.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-cloud-test-'));
const SOCK = path.join(tmp, 'lxd.sock');
const DB = path.join(tmp, 'panel.db');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
const GiB = 1024 ** 3;
let lxd;
let proc;
let logs = '';

function seedOldSchema() {
  const d = new Database(DB);
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT, ip TEXT, action TEXT NOT NULL, target TEXT, result TEXT NOT NULL, detail TEXT);
  `);
  const h = bcrypt.hashSync(PW, 4);
  const ins = d.prepare('INSERT INTO users (username, password_hash, role, container_name, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('kapil', h, 'admin', null, 1);
  ins.run('animesh', h, 'user', 'animesh', 2);
  ins.run('sachin', h, 'user', 'sachin', 3);
  d.prepare("INSERT INTO sessions VALUES ('oldsession', 1, 'csrf', 1, 9999999999999)").run();
  d.close();
}

class Client {
  constructor(ip = null) { this.cookie = ''; this.csrf = ''; this.ip = ip; }
  async req(method, url, body) {
    const r = await fetch(BASE + url, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-csrf-token': this.csrf, ...(this.ip ? { 'cf-connecting-ip': this.ip } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }
  async login(username, password = PW) {
    const r = await this.req('POST', '/api/login', { username, password });
    if (r.status === 200) this.csrf = (await this.req('GET', '/api/me')).data.csrf;
    return r;
  }
  get = (u) => this.req('GET', u);
  post = (u, b = {}) => this.req('POST', u, b);
  put = (u, b = {}) => this.req('PUT', u, b);
  del = (u, b = {}) => this.req('DELETE', u, b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}
const waitJob = (c, name) => until(async () => {
  const r = await c.get(`/api/containers/${name}`);
  return r.status === 200 && !r.data.action ? r.data : null;
});

const admin = new Client();
const animesh = new Client();
const sachin = new Client();

before(async () => {
  seedOldSchema();
  lxd = await startFakeLxd(SOCK, {
    instances: {
      animesh: { cpu: 4, memory: '4GiB', disk: '100GiB', ip: '10.10.10.20' },
      sachin: { cpu: 1, memory: '1GiB', disk: '20GiB' },
    },
  });
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: SOCK, SESSION_SECRET: 'x'.repeat(64),
      COOKIE_SECURE: 'false', SAMPLE_MS: '500', BACKUP_HELPER: '/nonexistent/panel-backup', BACKUP_STATE_DIR: path.join(tmp, 'state'),
      BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '', CF_API_TOKEN: '', INGEST_TOKEN: 'ingest-token-123',
    },
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  await until(() => logs.includes('running on'), 15000).catch((e) => { throw new Error(`${e.message}\n${logs}`); });
  assert.equal((await admin.login('kapil')).status, 200);
  assert.equal((await animesh.login('animesh')).status, 200);
  assert.equal((await sachin.login('sachin')).status, 200);
  await until(async () => (await admin.get('/api/containers')).data.containers?.length === 2);
});

after(async () => {
  proc?.kill('SIGTERM');
  await sleep(300);
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- migration ----------
test('migration keeps users: old admin becomes super_admin, container mapping preserved, DB copied first', async () => {
  const me = (await admin.get('/api/me')).data;
  assert.equal(me.role, 'super_admin');
  assert.equal(me.isAdmin, true);
  const a = (await animesh.get('/api/me')).data;
  assert.equal(a.role, 'user');
  assert.deepEqual(a.containers, ['animesh']);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('panel.db.pre-migration-')), 'pre-migration copy exists');
  assert.match(logs, /Applied migration 1/);
});

test('existing containers are adopted as protected', async () => {
  const r = await admin.get('/api/containers/animesh');
  assert.equal(r.data.meta.protected, true);
  assert.equal(r.data.meta.origin, 'existing');
});

// ---------- auth & CSRF ----------
test('unauthenticated API calls get 401, pages redirect to /login', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/containers')).status, 401);
  const r = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(r.status, 302);
});

test('state-changing requests without the CSRF token are refused', async () => {
  const c = new Client();
  c.cookie = admin.cookie;
  assert.equal((await c.post('/api/containers/animesh/action', { action: 'restart' })).status, 403);
});

test('cross-site Origin is refused', async () => {
  const r = await fetch(`${BASE}/api/containers/animesh/action`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf, origin: 'https://evil.example' },
    body: JSON.stringify({ action: 'restart' }),
  });
  assert.equal(r.status, 403);
});

test('wrong password is 401 and login is rate limited after 5 failures', async () => {
  const c = new Client('203.0.113.9'); // its own IP, so the lockout does not affect the other tests
  for (let i = 0; i < 5; i += 1) assert.equal((await c.login('kapil', 'wrong-password-x')).status, 401);
  assert.equal((await c.login('kapil', 'wrong-password-x')).status, 429);
  assert.equal((await c.login('kapil')).status, 429, 'even the right password waits out the lockout');
  assert.equal((await new Client('203.0.113.10').login('kapil')).status, 200, 'other IPs are not affected');
});

test('malformed JSON gets 400, not 500', async () => {
  const r = await fetch(`${BASE}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: '{bad' });
  assert.equal(r.status, 400);
});

// ---------- isolation ----------
test('a user sees only their own servers', async () => {
  const r = await animesh.get('/api/containers');
  assert.deepEqual(r.data.containers.map((c) => c.name), ['animesh']);
  assert.equal((await animesh.get('/api/containers/sachin')).status, 403);
  assert.equal((await animesh.get('/api/containers/does-not-exist')).status, 403);
  assert.equal((await animesh.post('/api/containers/sachin/action', { action: 'stop' })).status, 403);
  assert.equal((await animesh.get('/api/containers/sachin/snapshots')).status, 403);
  assert.equal((await animesh.get('/api/containers/sachin/logs')).status, 403);
  assert.equal((await animesh.get('/api/metrics?scope=ct:sachin')).status, 403);
  assert.equal((await animesh.get('/api/metrics?scope=host')).status, 403);
});

test('users cannot reach admin APIs', async () => {
  for (const [m, u] of [['GET', '/api/users'], ['GET', '/api/allocation'], ['GET', '/api/audit'], ['GET', '/api/backups'], ['GET', '/api/net/state'],
    ['GET', '/api/snapshot'], ['POST', '/api/containers'], ['PUT', '/api/settings'], ['GET', '/api/networks'], ['GET', '/api/services']]) {
    const r = await animesh.req(m, u, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${m} ${u} should be 403, got ${r.status}`);
  }
});

test('users cannot freeze, resize, rebuild or delete even their own server', async () => {
  assert.equal((await animesh.post('/api/containers/animesh/action', { action: 'freeze' })).status, 400);
  assert.equal((await animesh.put('/api/containers/animesh/resources', { cpu: 1, memoryMiB: 512, diskGiB: 100 })).status, 403);
  assert.equal((await animesh.post('/api/containers/animesh/rebuild', { image: 'ubuntu-24.04', confirm: 'animesh' })).status, 403);
  assert.equal((await animesh.del('/api/containers/animesh', { confirm: 'animesh' })).status, 403);
});

test('owner can restart own server; result is audited', async () => {
  const r = await animesh.post('/api/containers/animesh/action', { action: 'restart' });
  assert.equal(r.status, 202);
  await waitJob(animesh, 'animesh');
  const audit = (await admin.get('/api/audit?q=server_restart')).data.entries;
  assert.ok(audit.some((e) => e.username === 'animesh' && e.result === 'success'));
});

// ---------- snapshots ----------
test('owner snapshots and restores own server with a safety snapshot', async () => {
  assert.equal((await animesh.post('/api/containers/animesh/snapshots', { name: 'before-upgrade' })).status, 202);
  await waitJob(animesh, 'animesh');
  assert.equal((await animesh.post('/api/containers/animesh/snapshots/before-upgrade/restore', { confirm: 'nope' })).status, 400);
  assert.equal((await animesh.post('/api/containers/animesh/snapshots/before-upgrade/restore', { confirm: 'before-upgrade' })).status, 202);
  const d = await waitJob(animesh, 'animesh');
  assert.ok(d.snapshots.some((s) => s.name.startsWith('before-restore-')), 'safety snapshot taken');
  assert.equal(d.status, 'Running');
});

test('snapshot quota is enforced for users', async () => {
  await admin.put(`/api/users/${(await admin.get('/api/users')).data.users.find((u) => u.username === 'sachin').id}`, { quotas: { maxSnapshots: 1 } });
  assert.equal((await sachin.post('/api/containers/sachin/snapshots', { name: 's1' })).status, 202);
  await waitJob(sachin, 'sachin');
  assert.equal((await sachin.post('/api/containers/sachin/snapshots', { name: 's2' })).status, 403);
});

// ---------- allocation ----------
test('allocation refuses a server that would oversubscribe CPU', async () => {
  // animesh (4) + sachin (1) are already promised; with overcommit 1 the capacity is the host's core count
  const sum = (await admin.get('/api/allocation')).data;
  assert.equal(sum.cpu.allocated, 5);
  const cpu = Math.max(1, sum.cpu.capacity - sum.cpu.allocated + 1); // always one more than fits
  assert.ok(sum.cpu.allocated + cpu > sum.cpu.capacity);
  const r = await admin.post('/api/containers', { name: 'web1', image: 'ubuntu-24.04', cpu, memoryMiB: 512, diskGiB: 10 });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Not enough CPU|more than the host/);
  assert.ok(!lxd.calls.some((c) => c.method === 'POST' && c.path === '/1.0/instances'), 'nothing was sent to LXD');
});

test('admin creates a server for a user once it fits; owner sees it', async () => {
  const sachinId = (await admin.get('/api/users')).data.users.find((u) => u.username === 'sachin').id;
  await admin.put(`/api/users/${sachinId}`, { quotas: { maxSnapshots: 5 } });
  await admin.put('/api/settings', { cpu_overcommit: 8, memory_overcommit: 1 });
  let r = await admin.post('/api/containers', { name: 'web1', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 256, diskGiB: 10, ownerId: sachinId });
  if (r.status === 409 && r.data.needsConfirm) {
    r = await admin.post('/api/containers', { name: 'web1', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 256, diskGiB: 10, ownerId: sachinId, acceptWarnings: true });
  }
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await until(async () => (await sachin.get('/api/containers')).data.containers.some((c) => c.name === 'web1' && c.status === 'Running'));
  const call = lxd.calls.find((c) => c.method === 'POST' && c.path === '/1.0/instances' && c.body.name === 'web1');
  assert.equal(call.body.config['limits.cpu'], '1');
  assert.equal(call.body.config['security.privileged'], 'false');
  assert.equal(call.body.devices.root.size, '10GiB');
});

test('user quota blocks provisioning beyond max servers', async () => {
  const sachinId = (await admin.get('/api/users')).data.users.find((u) => u.username === 'sachin').id;
  await admin.put(`/api/users/${sachinId}`, { quotas: { maxContainers: 2 } });
  const r = await admin.post('/api/allocation/check', { cpu: 1, memoryMiB: 256, diskGiB: 5, ownerId: sachinId });
  assert.equal(r.data.ok, false);
  assert.ok(r.data.errors.some((e) => /at most 2 server/.test(e)));
});

test('memory allocation leaves the host reserve', async () => {
  const sum = (await admin.get('/api/allocation')).data;
  const r = await admin.post('/api/allocation/check', { cpu: 1, memoryMiB: Math.ceil(sum.host.memory / 1048576), diskGiB: 1 });
  assert.equal(r.data.ok, false);
});

// ---------- protection & destructive ops ----------
test('protected existing server cannot be deleted or rebuilt', async () => {
  assert.equal((await admin.del('/api/containers/animesh', { confirm: 'animesh', stopFirst: true })).status, 403);
  assert.equal((await admin.post('/api/containers/animesh/rebuild', { image: 'ubuntu-24.04', confirm: 'animesh' })).status, 403);
  assert.ok(lxd.instances.has('animesh'));
});

test('delete needs typed confirmation and a stopped server (or stopFirst)', async () => {
  assert.equal((await admin.del('/api/containers/web1', { confirm: 'wrong' })).status, 400);
  assert.equal((await admin.del('/api/containers/web1', { confirm: 'web1' })).status, 409);
});

test('resize refuses disk shrink; valid resize updates LXD config', async () => {
  assert.equal((await admin.put('/api/containers/web1/resources', { cpu: 1, memoryMiB: 256, diskGiB: 5 })).status, 400);
  let r = await admin.put('/api/containers/web1/resources', { cpu: 2, memoryMiB: 512, diskGiB: 20, ingressMbit: 100 });
  if (r.data.needsConfirm) r = await admin.put('/api/containers/web1/resources', { cpu: 2, memoryMiB: 512, diskGiB: 20, ingressMbit: 100, acceptWarnings: true });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await waitJob(admin, 'web1');
  const i = lxd.instances.get('web1');
  assert.equal(i.config['limits.cpu'], '2');
  assert.equal(i.config['limits.memory'], '512MiB');
  assert.equal(i.devices.root.size, '20GiB');
  assert.equal(i.devices.eth0['limits.ingress'], '100Mbit');
});

test('fixed IP must be inside the bridge subnet and unused', async () => {
  assert.equal((await admin.put('/api/containers/web1/ip', { ip: '192.168.1.5' })).status, 400);
  assert.equal((await admin.put('/api/containers/web1/ip', { ip: '10.10.10.20' })).status, 409);
  assert.equal((await admin.put('/api/containers/web1/ip', { ip: '10.10.10.77' })).status, 202);
  await waitJob(admin, 'web1');
  assert.equal(lxd.instances.get('web1').devices.eth0['ipv4.address'], '10.10.10.77');
});

test('clone drops the fixed IP and stays stopped', async () => {
  const r = await admin.post('/api/containers/web1/clone', { newName: 'web1-copy' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await until(() => lxd.instances.has('web1-copy') && lxd.calls.some((c) => c.method === 'PUT' && c.path === '/1.0/instances/web1-copy'));
  await waitJob(admin, 'web1-copy');
  const c = lxd.instances.get('web1-copy');
  assert.equal(c.status, 'Stopped');
  assert.equal(c.devices.eth0['ipv4.address'], undefined);
});

test('a plain admin cannot delete servers; super admin can (stopFirst)', async () => {
  const r = await admin.post('/api/users', { username: 'ops', password: PW, role: 'admin' });
  assert.equal(r.status, 201);
  const ops = new Client();
  await ops.login('ops');
  assert.equal((await ops.del('/api/containers/web1-copy', { confirm: 'web1-copy' })).status, 403);
  assert.equal((await ops.post('/api/users', { username: 'boss', password: PW, role: 'super_admin' })).status, 403);
  assert.equal((await admin.del('/api/containers/web1-copy', { confirm: 'web1-copy' })).status, 202);
  await until(() => !lxd.instances.has('web1-copy'));
});

// ---------- ready stack / replicas ----------
const TUNNEL_TOKEN = Buffer.from(JSON.stringify({ a: 'f'.repeat(32), t: '11111111-2222-3333-4444-555555555555', s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' })).toString('base64');

test('ready stack: only a super admin may ask for it; bad tunnel tokens are refused', async () => {
  const ops = new Client();
  await ops.login('ops');
  const body = { name: 'rs', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 256, diskGiB: 5, acceptWarnings: true, stack: { components: ['pm2'] } };
  assert.equal((await ops.post('/api/containers', body)).status, 403);
  assert.equal((await ops.post('/api/containers/sachin/stack', { components: ['pm2'], confirm: 'sachin' })).status, 403);
  assert.equal((await sachin.post('/api/containers/sachin/stack', { components: ['pm2'], confirm: 'sachin' })).status, 403);
  const bad = await admin.post('/api/containers', { ...body, stack: { components: ['pm2'], tunnelToken: 'not-a-token' } });
  assert.equal(bad.status, 400);
  assert.equal((await admin.post('/api/containers', { ...body, stack: { components: ['ftp'] } })).status, 400);
  assert.equal((await admin.post('/api/containers', { ...body, count: 2, ip: '10.10.10.77' })).status, 400);
  assert.ok(!lxd.instances.has('rs') && !lxd.instances.has('rs-1'));
});

test('super admin creates 2 replicas with PM2 + Docker + tunnel: nesting, RAM limit, stack, snapshot', async () => {
  const r = await admin.post('/api/containers', {
    name: 'rep', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 512, diskGiB: 5, count: 2, acceptWarnings: true,
    stack: { components: ['pm2', 'docker'], tunnelToken: TUNNEL_TOKEN },
  });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.deepEqual(r.data.names, ['rep-1', 'rep-2']);
  for (const n of r.data.names) {
    const done = await until(async () => {
      const s = (await admin.get(`/api/containers/${n}/stack`)).data.stack;
      return s && s.status !== 'running' ? s : null;
    });
    assert.equal(done.status, 'ready', JSON.stringify(done));
    assert.deepEqual(done.components, ['pm2', 'docker', 'cloudflared']);
    assert.equal(done.versions.pm2, '6.0.0', JSON.stringify(done));
    assert.equal(done.versions.docker, '27.0.0');
    assert.equal(done.tunnelId, '11111111-2222-3333-4444-555555555555');
    assert.match(done.snapshot, /^stack-ready-/);
    const i = lxd.instances.get(n);
    assert.equal(i.config['security.nesting'], 'true');
    assert.equal(i.config['security.privileged'], 'false');
    assert.equal(i.config['limits.memory'], '512MiB');
    assert.equal(i.config['user.kapilcloud.replica-of'], 'rep');
    assert.ok(i.snapshots.some((s) => s.name === done.snapshot));
    const exec = lxd.calls.find((x) => x.path === `/1.0/instances/${n}/exec` && x.body.environment.WANT_DOCKER);
    assert.equal(exec.body.environment.WANT_DOCKER, '1');
    assert.equal(exec.body.environment.CF_TUNNEL_TOKEN, TUNNEL_TOKEN, 'token reaches the container as env only');
  }
  const raw = new Database(DB, { readonly: true });
  const leaks = raw.prepare("SELECT COUNT(*) AS n FROM audit WHERE detail LIKE '%' || ? || '%'").get(TUNNEL_TOKEN.slice(10, 40)).n
    + raw.prepare("SELECT COUNT(*) AS n FROM container_meta WHERE stack LIKE '%' || ? || '%'").get(TUNNEL_TOKEN.slice(10, 40)).n;
  raw.close();
  assert.equal(leaks, 0, 'tunnel token is never stored');
});

test('stack on an existing server: typed confirm, Docker turns on nesting with a safety snapshot first', async () => {
  assert.equal((await admin.post('/api/containers/sachin/stack', { components: ['docker'] })).status, 400);
  const before = lxd.calls.length;
  const r = await admin.post('/api/containers/sachin/stack', { components: ['docker'], confirm: 'sachin' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const done = await until(async () => {
    const s = (await admin.get('/api/containers/sachin/stack')).data.stack;
    return s && s.status !== 'running' ? s : null;
  });
  assert.equal(done.status, 'ready');
  const i = lxd.instances.get('sachin');
  assert.equal(i.config['security.nesting'], 'true');
  assert.equal(i.config['security.syscalls.intercept.mknod'], 'true');
  assert.ok(i.snapshots.some((s) => s.name.startsWith('before-stack-')));
  const after = lxd.calls.slice(before);
  const putIdx = after.findIndex((c) => c.method === 'PUT' && c.path === '/1.0/instances/sachin');
  const restartIdx = after.findIndex((c) => c.path === '/1.0/instances/sachin/state' && c.body?.action === 'restart');
  assert.ok(putIdx >= 0 && restartIdx > putIdx, 'config change, then restart');
  const own = await sachin.get('/api/containers/sachin/stack');
  assert.equal(own.status, 200);
  assert.equal(own.data.stack.log, undefined, 'owners see the state, not the install log');
  assert.equal((await animesh.get('/api/containers/sachin/stack')).status, 403);
});

// ---------- users ----------
test('suspending a user ends their sessions and blocks login', async () => {
  const id = (await admin.get('/api/users')).data.users.find((u) => u.username === 'ops').id;
  const ops = new Client();
  await ops.login('ops');
  assert.equal((await admin.post(`/api/users/${id}/suspend`)).status, 200);
  assert.equal((await ops.get('/api/me')).status, 401);
  assert.equal((await new Client().login('ops')).status, 403);
  assert.equal((await admin.post(`/api/users/${id}/activate`)).status, 200);
  assert.equal((await new Client().login('ops')).status, 200);
});

test('the last super admin cannot be demoted, suspended or deleted, and nobody can delete themselves', async () => {
  const kapil = (await admin.get('/api/users')).data.users.find((u) => u.username === 'kapil');
  assert.equal((await admin.put(`/api/users/${kapil.id}`, { role: 'user' })).status, 400);
  assert.equal((await admin.post(`/api/users/${kapil.id}/suspend`)).status, 400);
  assert.equal((await admin.del(`/api/users/${kapil.id}`, { confirm: 'kapil' })).status, 400);
});

test('deleting a user keeps their servers', async () => {
  const r = await admin.post('/api/users', { username: 'temp', password: PW, role: 'user', containers: ['web1'] });
  assert.equal(r.status, 201);
  const d = await admin.del(`/api/users/${r.data.user.id}`, { confirm: 'temp' });
  assert.equal(d.status, 200);
  assert.ok(lxd.instances.has('web1'));
});

test('user can see and revoke own sessions', async () => {
  const second = new Client();
  await second.login('animesh');
  const list = (await animesh.get('/api/me/sessions')).data.sessions;
  assert.ok(list.length >= 2);
  const other = list.find((s) => !s.current);
  assert.equal((await animesh.del(`/api/me/sessions/${other.id}`)).status, 200);
  assert.equal((await second.get('/api/me')).status, 401);
});

// ---------- SSH keys ----------
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@laptop';
test('SSH keys are validated and synced without removing existing keys', async () => {
  assert.equal((await animesh.post('/api/ssh-keys', { name: 'bad', publicKey: 'ssh-ed25519 notbase64!!' })).status, 400);
  assert.equal((await animesh.post('/api/ssh-keys', { name: 'laptop', publicKey: ED })).status, 201);
  assert.equal((await animesh.post('/api/ssh-keys', { name: 'again', publicKey: ED })).status, 409);
  lxd.files.set('animesh:/root/.ssh', { type: 'directory', uid: 0, gid: 0 });
  lxd.files.set('animesh:/root/.ssh/authorized_keys', { content: Buffer.from('ssh-rsa EXISTINGKEY old@host\n'), uid: 0, gid: 0, type: 'file' });
  assert.equal((await animesh.post('/api/ssh-keys/sync', { container: 'sachin' })).status, 403);
  const r = await animesh.post('/api/ssh-keys/sync', { container: 'animesh', login: 'root' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const text = lxd.files.get('animesh:/root/.ssh/authorized_keys').content.toString();
  assert.match(text, /EXISTINGKEY old@host/);
  assert.match(text, /BEGIN KAPIL CLOUD MANAGED KEYS[\s\S]*AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl[\s\S]*END KAPIL CLOUD/);
  // second sync replaces the block instead of appending another
  await animesh.post('/api/ssh-keys/sync', { container: 'animesh', login: 'root' });
  assert.equal(lxd.files.get('animesh:/root/.ssh/authorized_keys').content.toString().match(/BEGIN KAPIL/g).length, 1);
});

// ---------- apps ----------
test('apps: validation, isolation, encrypted env, deploy through exec', async () => {
  assert.equal((await animesh.post('/api/apps', { container: 'sachin', name: 'web', type: 'node', repoUrl: 'https://github.com/x/y' })).status, 403);
  assert.equal((await animesh.post('/api/apps', { container: 'animesh', name: 'web', type: 'node', repoUrl: 'http://github.com/x/y' })).status, 400);
  assert.equal((await animesh.post('/api/apps', { container: 'animesh', name: 'web', type: 'node', repoUrl: 'https://u:p@github.com/x/y' })).status, 400);
  const c = await animesh.post('/api/apps', { container: 'animesh', name: 'web', type: 'node', repoUrl: 'https://github.com/x/y', env: 'SECRET=hunter2\nPORT_X=1' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.app.id;
  const raw = new Database(DB, { readonly: true }).prepare('SELECT env_enc FROM apps WHERE id = ?').get(id).env_enc;
  assert.ok(!raw.includes('hunter2'), 'env is encrypted at rest');
  assert.equal((await animesh.get(`/api/apps/${id}/env`)).data.env.SECRET, '********');
  assert.equal((await sachin.get(`/api/apps/${id}`)).status, 403);
  assert.equal((await sachin.post(`/api/apps/${id}/deploy`)).status, 403);
  assert.equal((await animesh.post(`/api/apps/${id}/deploy`)).status, 202);
  const dep = await until(async () => {
    const d = (await animesh.get(`/api/apps/${id}`)).data.deployments[0];
    return d && d.status !== 'running' ? d : null;
  });
  assert.equal(dep.status, 'success');
  assert.equal(dep.commit_sha, 'a'.repeat(40));
  const exec = lxd.calls.find((x) => x.path === '/1.0/instances/animesh/exec' && x.body.environment.APP_NAME === 'web');
  assert.deepEqual(exec.body.command.slice(0, 2), ['bash', '-c'], 'fixed script, values via environment');
  assert.equal(exec.body.environment.REPO, 'https://github.com/x/y');
  assert.equal((await sachin.get('/api/apps')).data.apps.length, 0);
});

// ---------- domains ----------
test('domains: user request is pending, only admins approve; no Cloudflare config = manual route', async () => {
  const r = await animesh.post('/api/domains', { hostname: 'blog.gyannportal.com', container: 'animesh', port: 3000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.domain.status, 'pending');
  assert.equal(r.data.domain.target, undefined, 'users never see the internal target');
  assert.equal((await animesh.post('/api/domains', { hostname: 'panel.gyannportal.com', container: 'animesh', port: 3000 })).status, 400);
  assert.equal((await sachin.post('/api/domains', { hostname: 'x.gyannportal.com', container: 'animesh', port: 3000 })).status, 403);
  assert.equal((await animesh.post(`/api/domains/${r.data.domain.id}/approve`)).status, 403);
  const a = await admin.post(`/api/domains/${r.data.domain.id}/approve`);
  assert.equal(a.data.domain.status, 'manual');
  assert.equal(a.data.domain.target, 'http://10.10.10.20:3000');
});

// ---------- terminal ----------
function socketFor(c) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { transports: ['websocket'], extraHeaders: { cookie: c.cookie }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emitAck = (s, ev, msg) => new Promise((r) => s.emit(ev, msg, r));

test('terminal: only own container, data flows, open/close audited', async () => {
  const s = await socketFor(animesh);
  try {
    assert.match((await emitAck(s, 'term:open', { container: 'sachin' })).error, /own servers/);
    const r = await emitAck(s, 'term:open', { container: 'animesh', cols: 100, rows: 30 });
    assert.ok(r.id, JSON.stringify(r));
    let out = '';
    s.on('term:data', ({ data }) => { out += Buffer.from(data).toString(); });
    s.emit('term:input', { id: r.id, data: 'whoami\n' });
    await until(() => out.includes('echo:whoami'));
    const exited = new Promise((res) => s.once('term:exit', res));
    s.emit('term:close', { id: r.id });
    await exited;
  } finally {
    s.close();
  }
  const exec = lxd.calls.filter((x) => x.path === '/1.0/instances/animesh/exec' && x.body.interactive);
  assert.equal(exec.length, 1);
  const a = (await admin.get('/api/audit?q=terminal')).data.entries;
  assert.ok(a.some((e) => e.action === 'terminal_open' && e.result === 'success'));
  assert.ok(a.some((e) => e.action === 'terminal_open' && e.result === 'success' && e.username === 'animesh'));
  assert.ok(a.some((e) => e.action === 'terminal_close'));
});

test('terminal stays open past an expired LXD wait, and its first output is not lost', async () => {
  const s = await socketFor(animesh);
  const got = [];
  s.on('term:data', (m) => got.push(Buffer.from(m.data).toString()));
  let exited = null;
  s.on('term:exit', (m) => { exited = m; });
  const r = await emitAck(s, 'term:open', { container: 'animesh', cols: 80, rows: 24 });
  assert.ok(r.id, JSON.stringify(r));
  await sleep(4500);
  assert.equal(exited, null);
  assert.ok(got.join('').includes('fake-shell$'));
  s.emit('term:close', { id: r.id });
  await sleep(100);
  s.close();
});

test('typing exit in the terminal ends the session', async () => {
  const s = await socketFor(animesh);
  const exited = new Promise((r) => s.on('term:exit', r));
  const r = await emitAck(s, 'term:open', { container: 'animesh', cols: 80, rows: 24 });
  assert.ok(r.id, JSON.stringify(r));
  s.emit('term:input', { id: r.id, data: 'exit\n' });
  const m = await Promise.race([exited, sleep(4000).then(() => null)]);
  assert.equal(m?.reason, 'shell exited');
  s.close();
});

test('create asks LXD: a name the cached list has not seen is refused, and its owner is kept', async () => {
  await admin.put('/api/settings', { cpu_overcommit: 8, memory_overcommit: 2 });
  const made = await admin.post('/api/users', { username: 'ghostowner', password: PW, role: 'user' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const ownerId = (await admin.get('/api/users')).data.users.find((u) => u.username === 'ghostowner').id;
  lxd.addInstance('ghost');
  const direct = new Database(DB);
  direct.prepare('INSERT INTO user_containers (user_id, container, assigned_at) VALUES (?, ?, ?)').run(ownerId, 'ghost', Date.now());
  direct.close();
  const r = await admin.post('/api/containers', { name: 'ghost', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 256, diskGiB: 10, ownerId, acceptWarnings: true });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /already exists/);
  await sleep(300);
  const check = new Database(DB, { readonly: true });
  assert.ok(check.prepare('SELECT 1 FROM user_containers WHERE user_id = ? AND container = ?').get(ownerId, 'ghost'), 'owner kept');
  check.close();
});

test('a leftover panel record for a deleted server does not block its name', async () => {
  const direct = new Database(DB);
  direct.prepare("INSERT INTO container_meta (name, protected, origin, created_at) VALUES ('orphan', 0, 'panel', ?)").run(Date.now());
  direct.close();
  const r = await admin.post('/api/containers', { name: 'orphan', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 256, diskGiB: 10, acceptWarnings: true });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await until(async () => (await admin.get('/api/containers/orphan')).data?.status === 'Running');
});

test('container tools: owner manages own server, never another', async () => {
  const owner = animesh;
  const access = await owner.get('/api/servers/animesh/access');
  assert.equal(access.status, 200, JSON.stringify(access.data));
  assert.deepEqual(access.data.accounts.map((a) => a.name), ['root', 'deploy']);
  assert.equal(access.data.accounts[0].status, 'locked');
  assert.equal(access.data.ssh.passwordLogin, false);

  const gen = await owner.post('/api/servers/animesh/access/password', { account: 'root', generate: true });
  assert.equal(gen.status, 200, JSON.stringify(gen.data));
  assert.ok(gen.data.password.length >= 20);
  const call = lxd.calls.filter((x) => x.body?.environment?.TOOL_OP === 'set-password').at(-1);
  assert.equal(call.body.environment.NEW_PASSWORD, gen.data.password);
  assert.ok(!call.body.command.join(' ').includes(gen.data.password), 'password must not be on the command line');

  assert.equal((await owner.post('/api/servers/animesh/access/password', { account: 'root', password: 'short' })).status, 400);
  assert.equal((await owner.post('/api/servers/animesh/access/password', { account: 'x; rm -rf /', generate: true })).status, 400);
  const none = await owner.post('/api/servers/animesh/access/password', { account: 'missing', generate: true });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /no account named/);
  assert.match((await owner.post('/api/servers/animesh/access/password', { account: 'daemon', generate: true })).data.error, /system account/);

  const created = await owner.post('/api/servers/animesh/access/password', { account: 'dev', password: 'a-long-enough-pass-1', create: true, sudo: true });
  assert.equal(created.data.created, true);
  assert.equal(created.data.password, undefined);

  assert.equal((await owner.put('/api/servers/animesh/access/ssh', { passwordLogin: true, rootLogin: true })).status, 200);
  const ssh = lxd.calls.filter((x) => x.body?.environment?.TOOL_OP === 'ssh-password').at(-1);
  assert.equal(ssh.body.environment.ENABLE, '1');
  assert.equal(ssh.body.environment.ROOT_LOGIN, '1');

  const pm2 = await owner.get('/api/servers/animesh/tools/pm2');
  assert.deepEqual(pm2.data.processes.map((p) => [p.name, p.instances, p.cpu, p.mode]), [['web', 2, 5, 'cluster']]);
  assert.equal((await owner.post('/api/servers/animesh/tools/pm2/web/restart', {})).status, 200);
  assert.equal((await owner.post('/api/servers/animesh/tools/pm2/web/scale', { instances: 3 })).status, 200);
  assert.equal((await owner.post('/api/servers/animesh/tools/pm2/web/format', {})).status, 400);

  const docker = await owner.get('/api/servers/animesh/tools/docker');
  assert.equal(docker.data.state, 'ready');
  assert.equal(docker.data.containers.find((c) => c.name === 'kc-db-shop').database, 'shop');
  assert.equal((await owner.post('/api/servers/animesh/tools/docker', { image: 'nginx:alpine', name: 'web2', ports: '8080:80; rm', env: '' })).status, 400);

  const dbs = await owner.get('/api/servers/animesh/tools/databases');
  assert.deepEqual(dbs.data.databases.map((d) => [d.name, d.engine, d.port]), [['shop', 'postgres', 5432]]);
  const cred = await owner.get('/api/servers/animesh/tools/databases/shop/credentials');
  assert.equal(cred.data.url, 'postgresql://app:s3cret@127.0.0.1:5433/shop');
  const made = await owner.post('/api/servers/animesh/tools/databases', { name: 'blog', engine: 'postgres', version: '17' });
  assert.equal(made.status, 202, JSON.stringify(made.data));
  await until(async () => (await owner.get('/api/servers/animesh/tools/databases')).data.task?.status === 'success');

  const audit = (await admin.get('/api/audit?q=server_password_change')).data.entries;
  assert.ok(audit.some((e) => e.target === 'animesh/root' && e.result === 'success'));
  assert.ok(!JSON.stringify(audit).includes(gen.data.password), 'password must never reach the audit log');
});

test('container tools: other users get 403', async () => {
  for (const u of ['/api/servers/animesh/access', '/api/servers/animesh/tools/pm2', '/api/servers/animesh/tools/docker', '/api/servers/animesh/tools/databases']) {
    assert.equal((await sachin.get(u)).status, 403, u);
  }
  assert.equal((await sachin.post('/api/servers/animesh/access/password', { account: 'root', generate: true })).status, 403);
});

test('terminal refused on privileged containers for users', async () => {
  lxd.addInstance('priv', { cpu: 1, memory: '256MiB', privileged: true });
  const sachinId = (await admin.get('/api/users')).data.users.find((u) => u.username === 'sachin').id;
  await until(async () => (await admin.get('/api/containers')).data.containers.some((c) => c.name === 'priv'));
  await admin.put(`/api/users/${sachinId}`, { containers: ['sachin', 'web1', 'priv'] });
  const s = await socketFor(sachin);
  try {
    assert.match((await emitAck(s, 'term:open', { container: 'priv' })).error, /privileged/);
  } finally { s.close(); }
});

// ---------- ingest ----------
test('ingest token is checked', async () => {
  const bad = await fetch(`${BASE}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-panel-token': 'nope' }, body: '{}' });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${BASE}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-panel-token': 'ingest-token-123' }, body: JSON.stringify({ app: 'x', count: 3 }) });
  assert.equal(ok.status, 200);
});

test('health check answers without login', async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).lxd, true);
});
