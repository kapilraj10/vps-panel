// Port forwarding for apps: the LXD proxy device port<PORT> (host 127.0.0.1 -> container 127.0.0.1), the health check
// from the host, conflicts, cleanup and the one-time repair script. The fake LXD opens a real listener on the host for
// every proxy device, so the health check really connects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { startFakeLxd } from './fake-lxd.js';
import { checkPort, checkContainer, deviceName, wantedDevice } from '../portforward.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfwd-test-'));
const DB = path.join(tmp, 'panel.db');
const SOCK = path.join(tmp, 'lxd.sock');
const PORT = 5000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
// App ports: a random block high up, so nothing on the test machine is likely to hold them
const P0 = 40000 + Math.floor(Math.random() * 200) * 10;
const [P1, P2, P3, P4, P5] = [P0 + 1, P0 + 2, P0 + 3, P0 + 4, P0 + 5];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENV = { DB_PATH: DB, LXD_SOCKET: SOCK, SESSION_SECRET: 'x'.repeat(64), HEALTH_TRIES: '2', HEALTH_DELAY_MS: '100' };
let lxd;
let proc;
let logs = '';
let cookie = '';
let csrf = '';

async function req(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}
async function deploy(id) {
  assert.equal((await req('POST', `/api/apps/${id}/deploy`)).status, 202);
  const d = await until(async () => { const x = (await req('GET', `/api/apps/${id}`)).data.deployments[0]; return x && x.status !== 'running' ? x : null; });
  const dep = (await req('GET', `/api/apps/${id}/deployments/${d.id}`)).data.deployment;
  if (process.env.SHOW_LOGS) console.log(`--- deploy ${id}: ${dep.status}\n${dep.log}`);
  return dep;
}
const devices = (name) => lxd.instances.get(name).devices;
const newApp = (container, name, port) => req('POST', '/api/apps', { container, name, type: 'node', repoUrl: 'https://github.com/x/y', ...(port ? { port } : {}) });

before(async () => {
  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT, ip TEXT, action TEXT NOT NULL, target TEXT, result TEXT NOT NULL, detail TEXT);`);
  d.prepare('INSERT INTO users (username, password_hash, role, container_name, created_at) VALUES (?, ?, ?, ?, ?)').run('kapil', bcrypt.hashSync(PW, 4), 'admin', null, 1);
  d.close();
  lxd = await startFakeLxd(SOCK, { instances: { web1: {}, web2: {}, downbox: {} } });
  lxd.instances.get('downbox').config['user.fake.app-down'] = 'true';
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, ...ENV, PORT: String(PORT), HOST: '127.0.0.1', COOKIE_SECURE: 'false', GIT_CHECK: 'off', SAMPLE_MS: '300',
      BACKUP_HELPER: '/nonexistent/panel-backup', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '', CF_API_TOKEN: '',
    },
  });
  proc.stdout.on('data', (b) => { logs += b; });
  proc.stderr.on('data', (b) => { logs += b; });
  for (let i = 0; i < 150 && !logs.includes('running on'); i += 1) await sleep(100);
  assert.ok(logs.includes('running on'), logs);
  assert.equal((await req('POST', '/api/login', { username: 'kapil', password: PW })).status, 200);
  csrf = (await req('GET', '/api/me')).data.csrf;
  await until(async () => (await req('GET', '/api/containers')).data.containers?.length === 3);
});

after(async () => {
  proc?.kill('SIGTERM');
  await sleep(300);
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('validation: ports 1024-65535 only, container names a-z 0-9 dash', () => {
  for (const bad of [80, 1023, 65536, 3000.5, '3000; rm -rf /', -1, null]) assert.throws(() => checkPort(bad), /1024 to 65535/, String(bad));
  assert.equal(checkPort(4023), 4023);
  assert.equal(checkPort('4023'), 4023);
  for (const bad of ['Apps', 'a b', 'a;rm', '../x', 'a_b', '']) assert.throws(() => checkContainer(bad), /a-z, 0-9/, bad);
  assert.equal(deviceName(4023), 'port4023');
  assert.deepEqual(wantedDevice(4023), { type: 'proxy', listen: 'tcp:127.0.0.1:4023', connect: 'tcp:127.0.0.1:4023' });
});

let appId;
test('deploy creates the proxy device, health-checks it from the host and logs each step', async () => {
  const c = await newApp('web1', 'shop', P1);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  appId = c.data.app.id;
  const dep = await deploy(appId);
  assert.equal(dep.status, 'success', dep.log);
  assert.deepEqual(devices('web1')[`port${P1}`], { type: 'proxy', listen: `tcp:127.0.0.1:${P1}`, connect: `tcp:127.0.0.1:${P1}` });
  const order = ['==> Starting with PM2', '==> Forwarding port', `Created proxy device port${P1}`, '==> Health check', 'HTTP 404', '==> Public hostname', '==> Deployed.'];
  let at = -1;
  for (const s of order.slice(1)) { const i = dep.log.indexOf(s); assert.ok(i > at, `${s} in order:\n${dep.log}`); at = i; }
  assert.match(dep.log, new RegExp(`-> http://localhost:${P1}`), 'the tunnel target is localhost:<port>');
  const n = (await req('GET', `/api/apps/${appId}/network`)).data;
  assert.equal(n.container, 'web1');
  assert.match(n.ip, /^10\.10\.10\./);
  assert.equal(n.port, P1);
  assert.equal(n.forward.status, 'ok');
  const doms = (await req('GET', '/api/domains')).data.domains.filter((x) => x.appId === appId);
  assert.equal(doms[0].target, `http://localhost:${P1}`);
});

test('a redeploy leaves the device alone (idempotent)', async () => {
  const puts = lxd.calls.filter((x) => x.method === 'PUT' && x.path === '/1.0/instances/web1').length;
  const dep = await deploy(appId);
  assert.equal(dep.status, 'success', dep.log);
  assert.match(dep.log, new RegExp(`Proxy device port${P1} already in place`));
  assert.equal(lxd.calls.filter((x) => x.method === 'PUT' && x.path === '/1.0/instances/web1').length, puts, 'no LXD write');
});

test('a device with another config is updated; a missing one is shown and fixed by the button', async () => {
  devices('web1')[`port${P1}`] = { type: 'proxy', listen: `tcp:0.0.0.0:${P1}`, connect: `tcp:127.0.0.1:${P1}` };
  lxd.syncProxies();
  assert.equal((await req('GET', `/api/apps/${appId}/network`)).data.forward.status, 'different');
  let r = await req('POST', `/api/apps/${appId}/forward`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.log.some((l) => l.startsWith(`Updated proxy device port${P1}`)), r.data.log.join('\n'));
  assert.equal(devices('web1')[`port${P1}`].listen, `tcp:127.0.0.1:${P1}`, 'host side on 127.0.0.1 only');

  delete devices('web1')[`port${P1}`];
  lxd.syncProxies();
  assert.equal((await req('GET', `/api/apps/${appId}/network`)).data.forward.status, 'missing');
  r = await req('POST', `/api/apps/${appId}/forward`);
  assert.equal(r.status, 200);
  assert.equal(r.data.network.forward.status, 'ok');
});

test('host port conflicts are refused with a clear message', async () => {
  // another container already forwards that host port
  let r = await newApp('web2', 'other', P1);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /already taken on the host by another app/);
  // a device made by hand on another container (not in the panel database)
  lxd.instances.get('downbox').devices.manual = { type: 'proxy', listen: `tcp:127.0.0.1:${P5}`, connect: 'tcp:127.0.0.1:80' };
  r = await newApp('web2', 'other', P5);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /already forwarded to the container downbox/);
  delete lxd.instances.get('downbox').devices.manual;
  lxd.syncProxies();
  // a port reserved for host services (a database that may just be stopped right now)
  r = await newApp('web2', 'other', 6379);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /reserved for services on the host/);
  // a program on the host
  const hog = net.createServer().listen(P2, '127.0.0.1');
  await new Promise((ok) => hog.once('listening', ok));
  try {
    r = await newApp('web2', 'other', P2);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /in use by another program on the host/);
    // without an explicit port the next free one is picked
    r = await req('POST', '/api/apps', { container: 'web2', name: 'auto', type: 'node', repoUrl: 'https://github.com/x/y', port: undefined });
    assert.equal(r.status, 201);
    assert.notEqual(r.data.app.port, P2);
    // a deploy that meets a taken port fails cleanly instead of crashing
    new Database(DB).prepare('UPDATE apps SET port = ? WHERE id = ?').run(P2, r.data.app.id);
    const dep = await deploy(r.data.app.id);
    assert.equal(dep.status, 'failed');
    assert.match(dep.log, /Port forwarding failed: Host port \d+ is already in use by another program on the host/);
    assert.ok(!dep.log.includes('==> Deployed.'));
    assert.equal((await req('DELETE', `/api/apps/${r.data.app.id}`, { confirm: 'auto' })).status, 200);
  } finally { hog.close(); }
});

test('changing the port forwards the new one and removes the old device', async () => {
  const r = await req('PUT', `/api/apps/${appId}`, { port: P3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(devices('web1')[`port${P1}`], 'old port stays live until the redeploy');
  const dep = await deploy(appId);
  assert.equal(dep.status, 'success', dep.log);
  assert.ok(devices('web1')[`port${P3}`]);
  assert.equal(devices('web1')[`port${P1}`], undefined);
  assert.match(dep.log, new RegExp(`Removed the old proxy device port${P1}`));
  const doms = (await req('GET', '/api/domains')).data.domains.filter((x) => x.appId === appId);
  assert.equal(doms[0].target, `http://localhost:${P3}`, 'the route follows the port');
});

test('no answer on the host port: deploy FAILED with PM2 state, ss -tlnp and the device in the log', async () => {
  const c = await newApp('downbox', 'web', P4);
  assert.equal(c.status, 201);
  const dep = await deploy(c.data.app.id);
  assert.equal(dep.status, 'failed');
  assert.match(dep.log, /try 2\/2: (connection reset|empty reply|connection refused)/);
  assert.match(dep.log, /FAILED: nothing answers on host port/);
  assert.match(dep.log, /==> Diagnostics/);
  assert.match(dep.log, /PM2: web is online/);
  assert.match(dep.log, /ss -tlnp/);
  assert.match(dep.log, new RegExp(`Nothing listens on port ${P4} inside the container`));
  assert.match(dep.log, new RegExp(`Proxy device: port${P4} present`));
  assert.equal((await req('GET', `/api/apps/${c.data.app.id}`)).data.app.status, 'failed');
});

test('deleting an app removes its proxy device', async () => {
  const id = (await req('GET', '/api/apps')).data.apps.find((a) => a.container === 'downbox').id;
  assert.ok(devices('downbox')[`port${P4}`]);
  assert.equal((await req('DELETE', `/api/apps/${id}`, { confirm: 'web' })).status, 200);
  assert.equal(devices('downbox')[`port${P4}`], undefined);
});

test('one-time script: dry run changes nothing, the real run creates the missing devices', async () => {
  delete devices('web1')[`port${P3}`];
  lxd.syncProxies();
  const run = (...a) => new Promise((resolve) => {
    execFile(process.execPath, ['scripts/forward-ports.js', ...a], { cwd: path.join(here, '..'), env: { ...process.env, ...ENV } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
  let r = await run('--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`web1/shop \\(kapil\\) port ${P3}: would create port${P3}`));
  assert.equal(devices('web1')[`port${P3}`], undefined);
  r = await run('--check');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`created port${P3}`));
  assert.match(r.out, /health: HTTP 404/);
  assert.deepEqual(devices('web1')[`port${P3}`], wantedDevice(P3));
  r = await run();
  assert.match(r.out, /already forwarded/);
});
