// End-to-end tests: databases (Docker), two-factor login, Security center (fake root helper), master server setup.
// Real panel process + fake LXD + fake Docker API + a fake kapil-security helper. Nothing touches the real host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { startFakeLxd } from './fake-lxd.js';
import { startFakeDocker } from './fake-docker.js';
import { totp, fromBase32 } from '../totp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-platform-test-'));
const DB = path.join(tmp, 'panel.db');
const HOME = path.join(tmp, 'home');
const PORT = 5300 + Math.floor(Math.random() * 400);
const DBP = 23000 + Math.floor(Math.random() * 300) * 10;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
const HELPER_LOG = path.join(tmp, 'helper.log');
let lxd;
let docker;
let proc;
let logs = '';

// Fake root helper: records its arguments, answers like the real one
const FAKE_HELPER = `#!/usr/bin/env node
const fs = require('fs');
const [cmd, ...a] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(HELPER_LOG)}, [cmd, ...a].join(' ') + '\\n');
const ok = (o) => { console.log('@@RESULT ' + JSON.stringify(o)); process.exit(0); };
const no = (m, c = 2) => { console.error('@@ERROR ' + m); process.exit(c); };
const ufw = { installed: true, active: true, defaults: { incoming: 'deny', outgoing: 'allow', routed: 'deny' }, rules: [{ num: 1, to: '22/tcp', action: 'LIMIT', direction: 'IN', from: 'Anywhere', comment: null, v6: false }] };
if (cmd === 'status') ok({ ufw, fail2ban: { installed: true, running: true, jails: [{ name: 'sshd', failed: 2, banned: 1, totalFailed: 9, totalBanned: 3, ips: ['203.0.113.9'] }] }, sshPorts: [22], bridges: ['lxdbr0'] });
if (cmd === 'check') ok({ checks: [{ id: 'ssh_root', title: 'SSH root login', status: 'ok', detail: 'PermitRootLogin no' }], listening: [{ proto: 'tcp', addr: '0.0.0.0', port: 3001, process: 'node', public: true }] });
if (cmd === 'ufw-rule') { if (a[0] === 'deny' && a[1] === '22') no('Refused: that would block SSH'); ok({ ok: true, ufw }); }
if (cmd === 'ufw-delete') { if (a[0] === '1') no('Refused: rule 1 is the last one letting SSH (port 22) in.'); ok({ ok: true, ufw }); }
if (cmd === 'ufw-enable' || cmd === 'ufw-disable' || cmd === 'f2b-unban' || cmd === 'f2b-ban') ok({ ok: true, ufw });
no('Unknown command');
`;

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
  async login(username, password = PW) {
    const r = await this.req('POST', '/api/login', { username, password });
    if (r.status === 200 && r.data.ok) this.csrf = (await this.req('GET', '/api/me')).data.csrf;
    return r;
  }
  async loginWithCode(username, code) {
    const r = await this.req('POST', '/api/login', { username, password: PW });
    if (!r.data.twoFactor) return r;
    const r2 = await this.req('POST', '/api/login/2fa', { ticket: r.data.ticket, code });
    if (r2.status === 200) this.csrf = (await this.req('GET', '/api/me')).data.csrf;
    return r2;
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
const codeAt = (secret, offset = 0) => totp(fromBase32(secret), Math.floor(Date.now() / 30_000) + offset);

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'kapil-security'), FAKE_HELPER, { mode: 0o755 });
  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL)`);
  const h = bcrypt.hashSync(PW, 4);
  for (const [u, role] of [['kapil', 'admin'], ['ops', 'user'], ['dev', 'user']]) d.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, 1)').run(u, h, role);
  d.close();
  lxd = await startFakeLxd(path.join(tmp, 'lxd.sock'), { instances: {} });
  docker = await startFakeDocker(path.join(tmp, 'docker.sock'), {});
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, HOME, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: path.join(tmp, 'lxd.sock'), SESSION_SECRET: 'z'.repeat(64),
      COOKIE_SECURE: 'false', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '',
      DOCKER_SOCKET: path.join(tmp, 'docker.sock'), DB_PORTS: `${DBP}-${DBP + 5}`,
      SECURITY_HELPER: path.join(tmp, 'kapil-security'), SECURITY_SUDO: 'off',
    },
  });
  proc.stdout.on('data', (x) => { logs += x; });
  proc.stderr.on('data', (x) => { logs += x; });
  await until(() => logs.includes('running on'));
  const d2 = new Database(DB);
  d2.prepare("UPDATE users SET role = 'admin' WHERE username = 'ops'").run();
  d2.close();
  for (const [c, u] of [[sup, 'kapil'], [ops, 'ops'], [user, 'dev']]) assert.equal((await c.login(u)).status, 200);
});

after(async () => {
  proc?.kill('SIGTERM');
  await sleep(300);
  await docker?.close();
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- databases ----------
test('databases: roles, validation, options', async () => {
  assert.equal((await user.get('/api/databases')).status, 403);
  assert.equal((await ops.get('/api/databases')).status, 200);
  assert.equal((await ops.post('/api/databases', { name: 'shop', engine: 'postgres' })).status, 403, 'plain admins read only');
  const o = await sup.get('/api/databases/options');
  assert.deepEqual(Object.keys(o.data.engines).sort(), ['mongo', 'mysql', 'postgres']);
  assert.ok(o.data.access.some((a) => a.id === 'containers' && a.label.includes('10.10.10.1')), 'LXD bridge offered');
  for (const bad of [{ name: 'X', engine: 'postgres' }, { name: 'ok-name', engine: 'redis' }, { name: 'ok-name', engine: 'postgres', version: '9' },
    { name: 'ok-name', engine: 'postgres', user: 'Robert;drop' }, { name: 'ok-name', engine: 'mysql', user: 'root' }, { name: 'ok-name', engine: 'postgres', access: 'public' }]) {
    assert.equal((await sup.post('/api/databases', bad)).status, 400, JSON.stringify(bad));
  }
});

test('databases: create PostgreSQL, MySQL and MongoDB safely, credentials audited', async () => {
  const made = {};
  for (const [name, engine, extra] of [['shop', 'postgres', {}], ['blog', 'mysql', { access: 'containers' }], ['events', 'mongo', { memoryMb: 512 }]]) {
    const r = await sup.post('/api/databases', { name, engine, ...extra });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    made[name] = r.data.database;
  }
  await until(async () => (await sup.get('/api/databases')).data.databases.every((x) => x.status === 'ready' && x.state === 'running'), 20000);
  const list = (await ops.get('/api/databases')).data.databases;
  assert.equal(list.length, 3);
  assert.ok(list.every((x) => !('password' in x) && !JSON.stringify(x).includes('password_enc')), 'no secrets in the list');
  assert.equal(new Set(list.map((x) => x.port)).size, 3, 'each gets its own port');

  const body = (name) => docker.calls.find((c) => c.path === '/containers/create' && c.query.name === `kdb-${name}`).body;
  const pg = body('shop');
  assert.equal(pg.HostConfig.Privileged, false);
  assert.deepEqual(pg.HostConfig.SecurityOpt, ['no-new-privileges']);
  assert.equal(Object.values(pg.HostConfig.PortBindings)[0][0].HostIp, '127.0.0.1');
  assert.deepEqual(pg.HostConfig.Binds, ['kdb-shop-data:/var/lib/postgresql/data']);
  assert.equal(pg.Labels['kapil.cloud.db'], 'shop');
  assert.ok(pg.Env.some((e) => e.startsWith('POSTGRES_USER=app')) && pg.Env.some((e) => e.startsWith('POSTGRES_PASSWORD=')));
  const my = body('blog');
  assert.equal(Object.values(my.HostConfig.PortBindings)[0][0].HostIp, '10.10.10.1', 'LXD access binds the bridge address, never 0.0.0.0');
  assert.ok(my.Env.some((e) => e.startsWith('MYSQL_ROOT_PASSWORD=')), 'root password set, so backups can dump it');
  assert.equal(body('events').HostConfig.Memory, 512 * 1024 * 1024);

  assert.equal((await ops.get(`/api/databases/${made.shop.id}/credentials`)).status, 403);
  const c = await sup.get(`/api/databases/${made.shop.id}/credentials`);
  assert.equal(c.status, 200);
  assert.match(c.data.url, new RegExp(`^postgresql://app:[A-Za-z0-9_-]{20,}@127\\.0\\.0\\.1:${made.shop.port}/app$`));
  assert.ok(pg.Env.includes(`POSTGRES_PASSWORD=${c.data.password}`), 'the shown password is the one the container got');
  const raw = new Database(DB, { readonly: true });
  assert.ok(!raw.prepare('SELECT password_enc FROM databases WHERE name = ?').get('shop').password_enc.includes(c.data.password), 'stored encrypted');
  raw.close();
  const audit = (await sup.get('/api/audit?action=database_credentials_view')).data.entries;
  assert.equal(audit[0].target, 'shop');

  assert.equal((await sup.post('/api/databases', { name: 'shop', engine: 'postgres' })).status, 409, 'duplicate name');
  assert.equal((await sup.post('/api/docker/containers', { name: 'kdb-x', image: 'nginx:alpine' })).status, 400, 'kdb- names are reserved');
  const kdb = (await sup.get('/api/docker/containers')).data.containers.find((x) => x.name === 'kdb-shop');
  assert.equal(kdb.managedDb, 'shop');
  assert.equal((await sup.del(`/api/docker/containers/${kdb.id}`, { confirm: 'kdb-shop', force: true })).status, 400, 'not removable from the Docker page');
});

test('databases: stop/start, logs, delete keeps the volume unless asked', async () => {
  const list = (await sup.get('/api/databases')).data.databases;
  const shop = list.find((x) => x.name === 'shop');
  assert.equal((await sup.post(`/api/databases/${shop.id}/stop`)).status, 200);
  await until(async () => (await sup.get('/api/databases')).data.databases.find((x) => x.name === 'shop').state === 'exited');
  assert.equal((await sup.post(`/api/databases/${shop.id}/start`)).status, 200);
  assert.equal((await ops.get(`/api/databases/${shop.id}/logs`)).status, 200);

  assert.equal((await sup.del(`/api/databases/${shop.id}`, { confirm: 'wrong' })).status, 400);
  const keep = await sup.del(`/api/databases/${shop.id}`, { confirm: 'shop' });
  assert.equal(keep.status, 200);
  assert.equal(keep.data.keptVolume, 'kdb-shop-data');
  assert.ok(docker.volumes.has('kdb-shop-data'), 'data kept');
  const blog = list.find((x) => x.name === 'blog');
  assert.equal((await sup.del(`/api/databases/${blog.id}`, { confirm: 'blog', deleteData: true })).status, 200);
  assert.ok(!docker.volumes.has('kdb-blog-data'), 'data deleted when asked');
  assert.ok(![...docker.containers.values()].some((c) => c.name === 'kdb-blog'));
});

test('databases: a failed create is reported, leaves no container, and can be removed', async () => {
  // the fake Docker refuses volumes named *broken*
  const r = await sup.post('/api/databases', { name: 'broken', engine: 'mongo', version: '7' });
  assert.equal(r.status, 202);
  const row = await until(async () => {
    const x = (await sup.get('/api/databases')).data.databases.find((d) => d.name === 'broken');
    return x?.status === 'error' ? x : null;
  });
  assert.match(row.error, /no space left/);
  assert.ok(![...docker.containers.values()].some((c) => c.name === 'kdb-broken'));
  assert.equal((await sup.del(`/api/databases/${row.id}`, { confirm: 'broken' })).status, 200);
});

// ---------- two-factor ----------
test('2FA: setup, login needs the code, replay refused, recovery code works once', async () => {
  const c = new Client();
  assert.equal((await c.login('dev')).status, 200);
  assert.equal((await c.post('/api/me/2fa/setup', { password: 'wrong' })).status, 400);
  const s = await c.post('/api/me/2fa/setup', { password: PW });
  assert.equal(s.status, 200);
  assert.match(s.data.uri, /^otpauth:\/\/totp\/Kapil%20Cloud%3Adev\?secret=[A-Z2-7]+&issuer=Kapil%20Cloud/);
  const secret = s.data.secret.replace(/ /g, '');
  assert.equal((await c.post('/api/me/2fa/enable', { code: '000000' })).status, 400);
  const en = await c.post('/api/me/2fa/enable', { code: codeAt(secret) });
  assert.equal(en.status, 200);
  assert.equal(en.data.recoveryCodes.length, 10);
  assert.equal((await c.get('/api/me')).data.twoFactor, true);
  const raw = new Database(DB, { readonly: true });
  const row = raw.prepare("SELECT totp_secret_enc, totp_recovery FROM users WHERE username = 'dev'").get();
  raw.close();
  assert.ok(!row.totp_secret_enc.includes(secret) && !row.totp_recovery.includes(en.data.recoveryCodes[0]), 'secret and codes not stored in clear');

  // password alone is not a login any more
  const p = new Client();
  const step1 = await p.req('POST', '/api/login', { username: 'dev', password: PW });
  assert.equal(step1.data.twoFactor, true);
  assert.ok(!p.cookie, 'no session after the password alone');
  assert.equal((await p.get('/api/me')).status, 401);
  assert.equal((await p.req('POST', '/api/login/2fa', { ticket: step1.data.ticket, code: '123456' })).status, 401);
  // the code used for enabling (same 30 s step) is a replay; the next step's code is fine
  const next = codeAt(secret, 1);
  const ok = await p.req('POST', '/api/login/2fa', { ticket: step1.data.ticket, code: next });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await p.get('/api/me')).status, 200);
  const replay = new Client();
  assert.equal((await replay.loginWithCode('dev', next)).status, 401, 'same code twice refused');

  const rc = new Client();
  assert.equal((await rc.loginWithCode('dev', en.data.recoveryCodes[0])).status, 200, 'recovery code');
  assert.equal((await new Client().loginWithCode('dev', en.data.recoveryCodes[0])).status, 401, 'recovery code works once');
  assert.equal((await rc.get('/api/me/2fa')).data.recoveryLeft, 9);

  // super admin resets it (lost phone)
  const devId = (await sup.get('/api/users')).data.users.find((u) => u.username === 'dev').id;
  assert.equal((await ops.post(`/api/users/${devId}/2fa/reset`, { confirm: 'dev' })).status, 403);
  assert.equal((await sup.post(`/api/users/${devId}/2fa/reset`, { confirm: 'dev' })).status, 200);
  assert.equal((await rc.get('/api/me')).status, 401, 'logged out everywhere');
  assert.equal((await user.login('dev')).status, 200, 'password login again');
});

test('2FA: requiring it for admins blocks admin APIs and sockets until set up', async () => {
  assert.equal((await sup.put('/api/settings/require-2fa', { enabled: true })).status, 400, 'super admin needs 2FA first');
  const s = await sup.post('/api/me/2fa/setup', { password: PW });
  const secret = s.data.secret.replace(/ /g, '');
  assert.equal((await sup.post('/api/me/2fa/enable', { code: codeAt(secret) })).status, 200);
  assert.equal((await ops.put('/api/settings/require-2fa', { enabled: true })).status, 403);
  assert.equal((await sup.put('/api/settings/require-2fa', { enabled: true })).status, 200);

  const blocked = await ops.get('/api/databases');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, '2fa_required');
  assert.equal((await ops.get('/api/me')).data.mustSetup2fa, true);
  assert.equal((await ops.get('/api/me/2fa')).status, 200, 'setup pages still work');
  assert.equal((await user.get('/api/me/sessions')).status, 200, 'plain users are not affected');
  assert.equal((await sup.get('/api/databases')).status, 200);
  assert.equal((await sup.post('/api/me/2fa/disable', { password: PW, code: codeAt(secret, 1) })).status, 403, 'cannot switch off while required');
  assert.equal((await sup.put('/api/settings/require-2fa', { enabled: false })).status, 200);
  assert.equal((await ops.get('/api/databases')).status, 200);
});

// ---------- security center ----------
test('security: status/check for admins, changes for super admin only, all audited', async () => {
  assert.equal((await user.get('/api/security/status')).status, 403);
  const st = await ops.get('/api/security/status');
  assert.equal(st.status, 200);
  assert.equal(st.data.host.ufw.active, true);
  assert.deepEqual(st.data.host.fail2ban.jails[0].ips, ['203.0.113.9']);
  const ck = await ops.get('/api/security/check');
  assert.ok(ck.data.checks.some((x) => x.id === 'ssh_root'), 'host checks');
  assert.ok(ck.data.checks.some((x) => x.id === 'cookie_secure' && x.status === 'bad'), 'panel checks (COOKIE_SECURE=false in tests)');
  assert.ok(ck.data.checks.some((x) => x.id === 'admin_2fa'));

  assert.equal((await ops.post('/api/security/firewall/rules', { action: 'allow', port: '443/tcp' })).status, 403);
  assert.equal((await sup.post('/api/security/firewall/rules', { action: 'allow', port: '443/tcp', from: '203.0.113.0/24', comment: 'web' })).status, 200);
  const refused = await sup.post('/api/security/firewall/rules', { action: 'deny', port: '22' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /block SSH/);
  assert.equal((await sup.del('/api/security/firewall/rules/1')).status, 400, 'last SSH rule');
  assert.equal((await sup.del('/api/security/firewall/rules/x;rm')).status, 400);
  assert.equal((await sup.post('/api/security/firewall/disable', {})).status, 400, 'needs typed confirm');
  assert.equal((await sup.post('/api/security/firewall/disable', { confirm: 'disable' })).status, 200);
  assert.equal((await sup.post('/api/security/fail2ban/unban', { jail: 'sshd', ip: '203.0.113.9' })).status, 200);
  const calls = fs.readFileSync(HELPER_LOG, 'utf8');
  assert.match(calls, /^ufw-rule allow 443\/tcp 203\.0\.113\.0\/24 web$/m);
  assert.match(calls, /^f2b-unban sshd 203\.0\.113\.9$/m);
  const a = (await sup.get('/api/audit?q=firewall')).data.entries.map((e) => `${e.action}:${e.result}`);
  assert.ok(a.includes('firewall_rule_add:success') && a.includes('firewall_rule_add:failure') && a.includes('firewall_disable:success'));
});

test('security: panel login blocks are listed and can be cleared', async () => {
  for (let i = 0; i < 5; i++) await new Client().req('POST', '/api/login', { username: 'nobody', password: 'x' });
  const st = await sup.get('/api/security/status');
  const me = st.data.panelLogins.find((x) => x.blocked);
  assert.ok(me, 'this IP is blocked now');
  assert.equal((await new Client().login('dev')).status, 429);
  assert.equal((await sup.del(`/api/security/panel-logins/${encodeURIComponent(me.ip)}`)).status, 200);
  assert.equal((await new Client().login('dev')).status, 200);
});

// ---------- master server ----------
test('master setup: primary node in Kathmandu, panel key installed once, other keys kept', async () => {
  fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAexisting me@laptop\n');
  assert.equal((await ops.post('/api/fleet/master/setup', {})).status, 403);
  const r = await sup.post('/api/fleet/master/setup', { sshPort: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.node.is_primary, 1);
  assert.equal(r.data.node.location, 'Kathmandu');
  assert.equal(r.data.node.public_ip, '127.0.0.1');
  assert.equal(r.data.ssh.ok, false, 'no sshd on port 1 here: reported, not thrown');
  const keys = fs.readFileSync(path.join(HOME, '.ssh', 'authorized_keys'), 'utf8');
  const pub = (await sup.get('/api/ssh/public-key')).data.publicKey;
  assert.ok(keys.startsWith('ssh-ed25519 AAAAexisting me@laptop\n'), 'existing keys untouched');
  assert.ok(keys.includes(pub));
  assert.equal(fs.statSync(path.join(HOME, '.ssh', 'authorized_keys')).mode & 0o777, 0o600);
  const again = await sup.post('/api/fleet/master/setup', { location: 'Kathmandu, Nepal' });
  assert.equal(again.data.keyAdded, false);
  assert.equal(fs.readFileSync(path.join(HOME, '.ssh', 'authorized_keys'), 'utf8'), keys, 'idempotent');
  assert.equal(again.data.node.location, 'Kathmandu, Nepal');
  assert.equal((await sup.get('/api/nodes')).data.nodes.filter((n) => n.is_primary).length, 1);
});
