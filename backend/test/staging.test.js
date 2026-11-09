// STAGING_MODE keeps the background jobs off, but the server list must still fill itself from LXD after a restart.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-'));
const DB = path.join(tmp, 'panel.db');
const SOCK = path.join(tmp, 'lxd.sock');
const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lxd;
let proc;
let logs = '';

before(async () => {
  const d = new Database(DB);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT, ip TEXT, action TEXT NOT NULL, target TEXT, result TEXT NOT NULL, detail TEXT);`);
  d.prepare('INSERT INTO users (username, password_hash, role, container_name, created_at) VALUES (?, ?, ?, ?, ?)').run('kapil', bcrypt.hashSync(PW, 4), 'admin', null, 1);
  d.close();
  lxd = await startFakeLxd(SOCK, { instances: { sachin: { cpu: 1, memory: '1GiB', disk: '20GiB' } } });
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(here, '..'),
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, LXD_SOCKET: SOCK, SESSION_SECRET: 'x'.repeat(64), STAGING_MODE: '1',
      COOKIE_SECURE: 'false', SAMPLE_MS: '300', BACKUP_HELPER: '/nonexistent/panel-backup', BACKUP_STATE_DIR: path.join(tmp, 'state'), BACKUP_DISK_CHECK: 'off', MONITOR_SERVICES: '', CF_API_TOKEN: '',
    },
  });
  proc.stdout.on('data', (b) => { logs += b; });
  proc.stderr.on('data', (b) => { logs += b; });
  for (let i = 0; i < 150 && !logs.includes('running on'); i += 1) await sleep(100);
  assert.ok(logs.includes('running on'), logs);
});

after(async () => {
  proc?.kill('SIGTERM');
  await sleep(300);
  await lxd?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('staging panel lists LXD servers after a restart without any job running', async () => {
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kapil', password: PW }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  await sleep(1500);
  const list = await (await fetch(`${BASE}/api/containers`, { headers: { cookie } })).json();
  assert.deepEqual(list.containers.map((c) => c.name), ['sachin']);
});
