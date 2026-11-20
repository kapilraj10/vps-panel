// End-to-end tests: prepaid billing, plans, self-service servers and databases for users.
// Real panel process + fake LXD + fake Docker API. Nothing touches the real host.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-billing-test-'));
const DB = path.join(tmp, 'panel.db');
const HOME = path.join(tmp, 'home');
const PORT = 5800 + Math.floor(Math.random() * 400);
const DBP = 26000 + Math.floor(Math.random() * 300) * 10;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
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
const ana = new Client();
const bob = new Client();
const ids = {};
const raw = () => new Database(DB);
const sql = (q, ...a) => { const d = raw(); try { return d.prepare(q).run(...a); } finally { d.close(); } };
const one = (q, ...a) => { const d = raw(); try { return d.prepare(q).get(...a); } finally { d.close(); } };
const waitJob = (c, name) => until(async () => {
  const r = await c.get(`/api/containers/${name}`);
  return r.status === 200 && !r.data.action ? r.data : null;
});

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL)`);
  const h = bcrypt.hashSync(PW, 4);
  for (const [u, role] of [['kapil', 'admin'], ['ana', 'user'], ['bob', 'user']]) d.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, 1)').run(u, h, role);
  d.close();
  lxd = await startFakeLxd(path.join(tmp, 'lxd.sock'), { instances: {} });
  docker = await startFakeDocker(path.join(tmp, 'docker.sock'), {});
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, HOME, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: path.join(tmp, 'lxd.sock'), SESSION_SECRET: 'b'.repeat(64),
      COOKIE_SECURE: 'false', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '',
      DOCKER_SOCKET: path.join(tmp, 'docker.sock'), DB_PORTS: `${DBP}-${DBP + 5}`, BILLING_TICK_MS: '400',
    },
  });
  proc.stdout.on('data', (x) => { logs += x; });
  proc.stderr.on('data', (x) => { logs += x; });
  await until(() => logs.includes('running on'));
  for (const [c, u] of [[sup, 'kapil'], [ana, 'ana'], [bob, 'bob']]) assert.equal((await c.login(u)).status, 200);
  for (const u of (await sup.get('/api/users')).data.users) ids[u.username] = u.id;
});

after(async () => {
  proc?.kill('SIGTERM');
  await sleep(300);
  await docker?.close();
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const plan = {};
test('plans: only a super admin manages them; users see active ones only', async () => {
  assert.equal((await ana.post('/api/billing/plans', { kind: 'server', name: 'x', cpu: 1, memoryMb: 512, diskGb: 5, priceDay: 100 })).status, 403);
  for (const bad of [{ kind: 'vm', name: 'a', priceDay: 1 }, { kind: 'server', name: '<b>', cpu: 1, memoryMb: 512, diskGb: 5, priceDay: 1 },
    { kind: 'server', name: 'neg', cpu: 1, memoryMb: 512, diskGb: 5, priceDay: -5 }, { kind: 'server', name: 'nocpu', memoryMb: 512, diskGb: 5, priceDay: 5 }]) {
    assert.equal((await sup.post('/api/billing/plans', bad)).status, 400, JSON.stringify(bad));
  }
  let r = await sup.post('/api/billing/plans', { kind: 'server', name: 'Small', cpu: 1, memoryMb: 512, diskGb: 5, priceDay: 4800 });
  assert.equal(r.status, 201);
  plan.small = r.data.plan;
  r = await sup.post('/api/billing/plans', { kind: 'server', name: 'Old', cpu: 1, memoryMb: 256, diskGb: 5, priceDay: 100, active: false });
  plan.old = r.data.plan;
  r = await sup.post('/api/billing/plans', { kind: 'database', name: 'DB mini', memoryMb: 256, priceDay: 2400 });
  plan.db = r.data.plan;
  assert.equal((await sup.post('/api/billing/plans', { kind: 'server', name: 'Small', cpu: 2, memoryMb: 512, diskGb: 5, priceDay: 1 })).status, 409);
  const seen = (await ana.get('/api/billing/plans')).data.plans.map((p) => p.name).sort();
  assert.deepEqual(seen, ['DB mini', 'Small']);
  assert.equal((await sup.get('/api/billing/plans')).data.plans.length, 3);
});

test('self-service server: needs a plan and enough balance; refuses admin-only options', async () => {
  assert.equal((await ana.post('/api/containers', { name: 'ana-web', image: 'ubuntu-24.04', cpu: 4, memoryMiB: 4096, diskGiB: 50 })).status, 400, 'no plan');
  assert.equal((await ana.post('/api/containers', { name: 'ana-web', image: 'ubuntu-24.04', planId: plan.old.id })).status, 400, 'inactive plan');
  const poor = await ana.post('/api/containers', { name: 'ana-web', image: 'ubuntu-24.04', planId: plan.small.id });
  assert.equal(poor.status, 402);
  assert.match(poor.data.error, /Not enough balance/);
  assert.ok(!lxd.calls.some((c) => c.method === 'POST' && c.path === '/1.0/instances'), 'nothing sent to LXD');

  assert.equal((await ana.post(`/api/billing/users/${ids.ana}/tx`, { amount: 100000 })).status, 403, 'users cannot top themselves up');
  const top = await sup.post(`/api/billing/users/${ids.ana}/tx`, { amount: 10000, note: 'eSewa ref 123' });
  assert.equal(top.status, 200);
  assert.equal(top.data.wallet.balance, 10000);

  const r = await ana.post('/api/containers', { name: 'ana-web', image: 'ubuntu-24.04', planId: plan.small.id, stack: { components: ['pm2'] }, ip: '10.10.10.99', count: 3, cpu: 64 });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const made = await waitJob(ana, 'ana-web');
  assert.equal(made.status, 'Running');
  const inst = lxd.calls.find((c) => c.method === 'POST' && c.path === '/1.0/instances').body;
  assert.equal(inst.config['limits.cpu'], '1', 'plan size, not the asked cpu');
  assert.equal(inst.config['limits.memory'], '512MiB');
  assert.equal(inst.config['user.kapilcloud.owner'], 'ana');
  assert.ok(!Object.values(inst.devices).some((d) => d['ipv4.address']), 'no fixed IP for users');
  assert.equal((await bob.get('/api/containers/ana-web')).status, 403, 'other users cannot see it');

  const me = (await ana.get('/api/billing/me')).data.wallet;
  assert.equal(me.burnPerDay, 4800);
  assert.equal(me.resources[0].name, 'ana-web');
  assert.equal(me.resources[0].planName, 'Small');
  assert.equal(me.daysLeft, 2.1);
});

test('charging: exact per-day price, billed by the hour, ledger matches balance', async () => {
  const r = one("SELECT * FROM billed_resources WHERE name = 'ana-web'");
  sql('UPDATE billed_resources SET billed_until = ? WHERE id = ?', r.billed_until - 36 * 3_600_000, r.id); // pretend 36 h passed
  await until(() => one('SELECT charged FROM billed_resources WHERE id = ?', r.id).charged >= 7200);
  const after = one('SELECT charged FROM billed_resources WHERE id = ?', r.id).charged;
  assert.ok(after >= 7200 && after <= 7210, `36 h of 4800/day = 7200 (got ${after})`);
  const bal = one('SELECT balance FROM users WHERE id = ?', ids.ana).balance;
  const sum = one('SELECT SUM(amount) AS s FROM wallet_tx WHERE user_id = ?', ids.ana).s;
  assert.equal(bal, sum, 'balance = sum of ledger');
  const tx = (await ana.get('/api/billing/me')).data.transactions;
  assert.ok(tx.some((t) => t.kind === 'charge' && /ana-web/.test(t.note)));
  assert.ok(tx.some((t) => t.kind === 'topup' && t.note === 'eSewa ref 123'));
});

test('empty wallet: grace, then services stop (not deleted), start refused, top-up resumes', async () => {
  await sup.put('/api/billing/settings', { graceHours: 0 });
  const bal = one('SELECT balance FROM users WHERE id = ?', ids.ana).balance;
  await sup.post(`/api/billing/users/${ids.ana}/tx`, { kind: 'adjust', amount: -bal - 50, note: 'test' });
  await until(() => one('SELECT billing_state FROM users WHERE id = ?', ids.ana).billing_state === 'stopped', 10000);
  await until(async () => (await ana.get('/api/containers/ana-web')).data.status === 'Stopped');
  assert.equal(one("SELECT paused FROM billed_resources WHERE name = 'ana-web' AND ended_at IS NULL").paused, 1);
  const start = await ana.post('/api/containers/ana-web/action', { action: 'start' });
  assert.equal(start.status, 402);
  const audit = (await sup.get('/api/audit?action=billing_suspend')).data.entries;
  assert.match(audit[0].detail, /ana-web/);
  const charged = one("SELECT charged FROM billed_resources WHERE name = 'ana-web'").charged;
  await sleep(1200);
  assert.equal(one("SELECT charged FROM billed_resources WHERE name = 'ana-web'").charged, charged, 'no charges while stopped');

  await sup.post(`/api/billing/users/${ids.ana}/tx`, { amount: 20000 });
  await until(() => one('SELECT billing_state FROM users WHERE id = ?', ids.ana).billing_state === null);
  assert.equal(one("SELECT paused FROM billed_resources WHERE name = 'ana-web' AND ended_at IS NULL").paused, 0);
  assert.equal((await ana.post('/api/containers/ana-web/action', { action: 'start' })).status, 202);
  await waitJob(ana, 'ana-web');
  await sup.put('/api/billing/settings', { graceHours: 24 });
});

test('self-service database: owned, private to its owner, billed, stoppable', async () => {
  const o = (await ana.get('/api/databases/options')).data;
  assert.equal(o.plans[0].name, 'DB mini');
  assert.equal((await ana.post('/api/databases', { name: 'anadb', engine: 'postgres' })).status, 400, 'plan required');
  const r = await ana.post('/api/databases', { name: 'anadb', engine: 'postgres', planId: plan.db.id, access: 'local' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await until(async () => (await ana.get('/api/databases')).data.databases.find((x) => x.name === 'anadb')?.status === 'ready');
  const body = docker.calls.find((c) => c.path === '/containers/create' && c.query.name === 'kdb-anadb').body;
  assert.equal(Object.values(body.HostConfig.PortBindings)[0][0].HostIp, '10.10.10.1', 'reachable from the user\'s LXD servers');
  assert.equal(body.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal((await bob.get('/api/databases')).data.databases.length, 0);
  const id = r.data.database.id;
  assert.equal((await bob.get(`/api/databases/${id}/credentials`)).status, 404);
  assert.equal((await bob.del(`/api/databases/${id}`, { confirm: 'anadb' })).status, 404);
  const c = await ana.get(`/api/databases/${id}/credentials`);
  assert.equal(c.status, 200);
  assert.match(c.data.url, /^postgresql:\/\/app:/);
  assert.equal((await ana.get('/api/billing/me')).data.wallet.burnPerDay, 4800 + 2400);
  assert.equal((await sup.get('/api/databases')).data.databases.find((x) => x.name === 'anadb').ownerId, ids.ana);

  assert.equal((await bob.post('/api/databases', { name: 'bobdb', engine: 'mysql', planId: plan.db.id })).status, 402, 'bob has no money');

  assert.equal((await ana.del(`/api/databases/${id}`, { confirm: 'anadb', deleteData: true })).status, 200);
  assert.ok(one("SELECT ended_at FROM billed_resources WHERE name = 'anadb'").ended_at, 'billing ended');
});

test('users delete only servers they made; billing ends; admin can bill an existing server', async () => {
  const sw = await sup.post('/api/containers', { name: 'bob-old', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 256, diskGiB: 5, ownerId: ids.bob, acceptWarnings: true });
  assert.equal(sw.status, 202, JSON.stringify(sw.data));
  await waitJob(sup, 'bob-old');
  assert.equal((await bob.get('/api/billing/me')).data.wallet.burnPerDay, 0, 'no price given, not billed');
  assert.equal((await sup.post('/api/billing/resources', { userId: ids.bob, kind: 'server', name: 'ana-web', priceDay: 10 })).status, 400, 'not bob\'s');
  const b = await sup.post('/api/billing/resources', { userId: ids.bob, kind: 'server', name: 'bob-old', priceDay: 1500 });
  assert.equal(b.status, 200);
  assert.equal(b.data.wallet.burnPerDay, 1500);
  assert.equal((await bob.del('/api/containers/bob-old', { confirm: 'bob-old', stopFirst: true })).status, 403, 'admin made it');

  const d = await ana.del('/api/containers/ana-web', { confirm: 'ana-web', stopFirst: true });
  assert.equal(d.status, 202, JSON.stringify(d.data));
  await until(async () => (await ana.get('/api/containers/ana-web')).status !== 200);
  assert.ok(one("SELECT ended_at FROM billed_resources WHERE name = 'ana-web'").ended_at);
  assert.equal((await ana.get('/api/billing/me')).data.wallet.burnPerDay, 0);
  const ov = (await sup.get('/api/billing/overview')).data;
  assert.equal(ov.wallets.length, 2);
  assert.equal(ov.totals.burnPerDay, 1500);
  assert.ok(ov.totals.charged30d >= 7200);
});
