// End-to-end: a customer connects their own VPS and deploys an app to it over SSH.
// The "VPS" is a real SSH server (ssh2) on 127.0.0.1 that RUNS the scripts with bash in a throwaway home folder,
// with stub pm2/docker on PATH and git rewriting the https repo URL to a local repository. No network, no root.
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
import { startFakeLxd } from './fake-lxd.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-myservers-test-'));
const DB = path.join(tmp, 'panel.db');
const PORT = 6300 + Math.floor(Math.random() * 300);
const SSH_PORT = 26300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
const VPS_PW = 'vps-password-123';
const VHOME = path.join(tmp, 'vps-home');
const BIN = path.join(tmp, 'bin');
const CALLS = path.join(tmp, 'calls.log');
const REPO = path.join(tmp, 'repo');
let lxd;
let proc;
let ssh;
let logs = '';
const seen = [];

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
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting\n${logs.slice(-2000)}`);
    await sleep(150);
  }
}

function startSsh(hostKey) {
  return new Promise((resolve) => {
    const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      client.on('error', () => {}); // a client that refuses our host key ends the handshake
      client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'deploy' && ctx.password === VPS_PW ? ctx.accept() : ctx.reject(['password'])));
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acc, _rej, info) => {
          seen.push(info.command);
          const ch = acc();
          const p = spawn('bash', ['-c', info.command], {
            cwd: VHOME,
            env: {
              PATH: `${BIN}:${process.env.PATH}`, HOME: VHOME,
              GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${REPO}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://example.test/shop.git',
            },
          });
          ch.pipe(p.stdin);
          p.stdout.pipe(ch, { end: false });
          p.stderr.pipe(ch.stderr, { end: false });
          p.on('close', (code) => { ch.exit(code ?? 1); ch.end(); });
        });
      }));
    });
    srv.listen(SSH_PORT, '127.0.0.1', () => resolve(srv));
  });
}

const ana = new Client();
const bob = new Client();
const sup = new Client();

before(async () => {
  fs.mkdirSync(VHOME, { recursive: true });
  fs.mkdirSync(BIN);
  for (const tool of ['pm2', 'docker']) fs.writeFileSync(path.join(BIN, tool), `#!/bin/sh\necho "${tool} $*" >> ${CALLS}\n[ "$1" = jlist ] && echo '[{"name":"shop","pm2_env":{"status":"online","restart_time":2},"monit":{"cpu":3,"memory":52428800}}]'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'docker'), `#!/bin/sh\necho "docker $*" >> ${CALLS}\ncase "$1" in\n  info) exit 0 ;;\n  inspect) [ "$2" = "-f" ] && echo running && exit 0; exit 1 ;;\n  stats) echo '1.5%|20MiB / 256MiB' ;;\nesac\nexit 0\n`, { mode: 0o755 });
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  fs.writeFileSync(path.join(REPO, 'server.js'), 'require("http").createServer((q, s) => s.end("ok")).listen(process.env.PORT)\n');
  const g = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', REPO, 'add', '.'], { env: g });
  execFileSync('git', ['-C', REPO, 'commit', '-qm', 'init'], { env: g });
  ssh = await startSsh(ssh2.utils.generateKeyPairSync('ed25519').private);

  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL)`);
  const h = bcrypt.hashSync(PW, 4);
  for (const [u, role] of [['kapil', 'admin'], ['ana', 'user'], ['bob', 'user']]) d.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, 1)').run(u, h, role);
  d.close();
  lxd = await startFakeLxd(path.join(tmp, 'lxd.sock'), { instances: {} });
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, HOME: tmp, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: path.join(tmp, 'lxd.sock'), SESSION_SECRET: 'm'.repeat(64),
      COOKIE_SECURE: 'false', GIT_CHECK: 'off', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '',
      DOCKER_SOCKET: path.join(tmp, 'docker.sock'), CUSTOMER_SSH_ALLOW_PRIVATE: '1',
    },
  });
  proc.stdout.on('data', (x) => { logs += x; });
  proc.stderr.on('data', (x) => { logs += x; });
  await until(() => logs.includes('running on'));
  for (const [c, u] of [[sup, 'kapil'], [ana, 'ana'], [bob, 'bob']]) assert.equal((await c.login(u)).status, 200);
});

after(async () => {
  proc?.kill('SIGTERM');
  await sleep(300);
  ssh?.close();
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const vps = { name: 'my-vps', host: '127.0.0.1', port: SSH_PORT, username: 'deploy', authType: 'password' };
let serverId;
let appId;

test('connect a VPS: verified before saving, secrets never returned, private to its owner', async () => {
  const wrong = await ana.post('/api/my-servers', { ...vps, password: 'nope' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /login failed/);
  assert.equal((await ana.post('/api/my-servers', { ...vps, authType: 'key', privateKey: 'not a key' })).status, 400);
  assert.equal((await sup.post('/api/my-servers', { ...vps, password: VPS_PW })).status, 403, 'admins use the fleet');
  const r = await ana.post('/api/my-servers', { ...vps, password: VPS_PW });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  serverId = r.data.server.id;
  assert.equal(r.data.server.status, 'online');
  assert.match(r.data.server.hostKey, /^SHA256:/);
  assert.ok(r.data.server.facts.cpus > 0 && r.data.server.facts.memTotal > 0);
  const list = await ana.get('/api/my-servers');
  assert.ok(!JSON.stringify(list.data).includes(VPS_PW), 'password never in a response');
  const raw = new Database(DB, { readonly: true });
  assert.ok(!raw.prepare('SELECT secret_enc FROM customer_servers').get().secret_enc.includes(VPS_PW), 'stored sealed');
  raw.close();
  assert.equal((await bob.get(`/api/my-servers/${serverId}`)).status, 404);
  assert.equal((await bob.get('/api/my-servers')).data.servers.length, 0);
  assert.equal((await sup.get('/api/my-servers')).data.servers[0].owner, 'ana', 'admins see all');
  assert.ok(seen.every((c) => c === 'bash -s'), 'only `bash -s`; values travel on stdin');
});

test('deploy an app to the VPS over SSH: real clone into ~/apps, PM2 start, stats, logs', async () => {
  assert.equal((await bob.post('/api/apps', { target: 'vps', serverId, name: 'shop', type: 'node', repoUrl: 'https://example.test/shop.git' })).status, 404, 'not bob\'s server');
  const r = await ana.post('/api/apps', { target: 'vps', serverId, name: 'shop', type: 'express', repoUrl: 'https://example.test/shop.git', branch: 'main', env: 'SECRET=a b', installCmd: '' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  appId = r.data.app.id;
  assert.equal(r.data.app.target, 'vps');
  assert.equal(r.data.app.serverName, 'my-vps');
  assert.equal(r.data.app.directUrl, `http://127.0.0.1:${r.data.app.port}`);
  assert.equal((await ana.post(`/api/apps/${appId}/deploy`)).status, 202);
  const done = await until(async () => { const d = (await ana.get(`/api/apps/${appId}`)).data; return !d.app.deploying && d.app.status !== 'deploying' ? d : null; });
  const dep = (await ana.get(`/api/apps/${appId}/deployments/${done.deployments[0].id}`)).data.deployment;
  assert.equal(done.app.status, 'running', dep.log);
  assert.match(dep.log, /Cloning https:\/\/example\.test\/shop\.git/);
  assert.match(dep.commit_sha, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(VHOME, 'apps', 'shop', 'server.js')), 'cloned on the VPS');
  assert.equal(fs.readFileSync(path.join(VHOME, 'apps', 'shop', '.env'), 'utf8'), 'SECRET="a b"\n');
  assert.match(fs.readFileSync(CALLS, 'utf8'), /pm2 start .*apps\/\.kapilcloud\/shop\/ecosystem\.json/);
  const st = (await ana.get(`/api/apps/${appId}/stats`)).data;
  assert.equal(st.status, 'online');
  assert.equal(st.memory, 52428800);
  assert.equal((await ana.get(`/api/apps/${appId}/logs`)).status, 200);
  assert.equal((await bob.get(`/api/apps/${appId}`)).status, 403);
  assert.equal((await ana.get('/api/domains')).data.domains.length, 0, 'no automatic subdomain for VPS apps');
});

test('database on my VPS: docker run there, port on 127.0.0.1 of that server, no bill, stats + delete over SSH', async () => {
  const r = await ana.post('/api/databases', { target: 'vps', serverId, name: 'anadb', engine: 'postgres', memoryMb: 256 });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const ready = await until(async () => { const d = (await ana.get('/api/databases')).data.databases.find((x) => x.name === 'anadb'); return d?.status === 'ready' || d?.status === 'error' ? d : null; });
  assert.equal(ready.status, 'ready', ready.error);
  assert.equal(ready.target, 'vps');
  assert.equal(ready.serverName, 'my-vps');
  const calls = fs.readFileSync(CALLS, 'utf8');
  assert.match(calls, /docker run -d --name kdb-anadb --restart unless-stopped --env-file \S+ -p 127\.0\.0\.1:5432:5432 -v kdb-anadb-data:\/var\/lib\/postgresql\/data --label kapil\.cloud\.db=anadb --security-opt no-new-privileges --memory 256m postgres:17-alpine/);
  const c = (await ana.get(`/api/databases/${ready.id}/credentials`)).data;
  assert.match(c.url, /^postgresql:\/\/app:.+@127\.0\.0\.1:5432\/app$/);
  assert.match(c.note, /On your VPS my-vps/);
  const st = (await ana.get(`/api/databases/${ready.id}/stats`)).data;
  assert.equal(st.state, 'running');
  assert.equal(st.memory, 20 * 1048576);
  assert.equal((await bob.get(`/api/databases/${ready.id}/credentials`)).status, 404);
  assert.equal((await ana.get('/api/billing/me')).data.wallet.burnPerDay, 0, 'own server: no charge');
  assert.equal((await ana.post(`/api/databases/${ready.id}/restart`)).status, 200);
  const d = await ana.del(`/api/databases/${ready.id}`, { confirm: 'anadb' });
  assert.equal(d.status, 200);
  assert.match(fs.readFileSync(CALLS, 'utf8'), /docker rm -f kdb-anadb/);
});

test('a changed host key is refused until the server is connected again', async () => {
  await new Promise((r) => ssh.close(r));
  ssh = await startSsh(ssh2.utils.generateKeyPairSync('ed25519').private);
  const c = await ana.post(`/api/my-servers/${serverId}/check`);
  assert.equal(c.data.server.status, 'host_key_changed');
  assert.match(c.data.server.lastError, /host key changed/);
  assert.equal((await ana.post(`/api/apps/${appId}/deploy`)).status, 409);
});

test('remove: refused while an app uses it, then allowed', async () => {
  assert.equal((await ana.del(`/api/my-servers/${serverId}`, { confirm: 'my-vps' })).status, 409);
  const d = await ana.del(`/api/apps/${appId}`, { confirm: 'shop' });
  assert.equal(d.status, 200);
  assert.match(d.data.note, /could not be reached/, 'host key mismatch means the app may still run there');
  assert.equal((await ana.del(`/api/my-servers/${serverId}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await ana.del(`/api/my-servers/${serverId}`, { confirm: 'my-vps' })).status, 200);
  const audit = (await sup.get('/api/audit?q=my_server')).data.entries.map((e) => e.action);
  assert.ok(audit.includes('my_server_add') && audit.includes('my_server_remove'));
});
