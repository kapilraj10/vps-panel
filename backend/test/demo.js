// DEV ONLY: runs the panel against the fake LXD with seeded users, for looking at the UI locally.
//   node test/demo.js [port]   ->  log in as kapil / demo-password-1 (super admin) or animesh / demo-password-1
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { startFakeLxd } from './fake-lxd.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || '4600';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-cloud-demo-'));
const sock = path.join(tmp, 'lxd.sock');
const dbPath = path.join(tmp, 'panel.db');
const d = new Database(dbPath);
d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')), container_name TEXT, created_at INTEGER NOT NULL)`);
const h = bcrypt.hashSync('demo-password-1', 4);
d.prepare('INSERT INTO users (username, password_hash, role, container_name, created_at) VALUES (?, ?, ?, ?, ?)').run('kapil', h, 'admin', null, Date.now());
d.prepare('INSERT INTO users (username, password_hash, role, container_name, created_at) VALUES (?, ?, ?, ?, ?)').run('animesh', h, 'user', 'animesh', Date.now());
d.close();
await startFakeLxd(sock, { instances: { animesh: { cpu: 4, memory: '4GiB', disk: '100GiB', ip: '10.10.10.20' }, sachin: { cpu: 1, memory: '1GiB', disk: '20GiB', status: 'Stopped' } } });
const p = spawn(process.execPath, ['server.js'], {
  cwd: path.join(here, '..'), stdio: 'inherit',
  env: { ...process.env, PORT: port, DB_PATH: dbPath, LXD_SOCKET: sock, SESSION_SECRET: 'd'.repeat(64), COOKIE_SECURE: 'false', BACKUP_DISK_CHECK: 'off', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state') },
});
const stop = () => { p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
