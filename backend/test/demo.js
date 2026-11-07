// DEV ONLY: runs the panel against the fake LXD with seeded users, for looking at the UI locally.
//   node test/demo.js [port]   ->  log in as kapil / demo-password-1 (super admin) or animesh / demo-password-1
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { startFakeLxd } from './fake-lxd.js';
import { startFakeDocker } from './fake-docker.js';

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
// Host services: fake PM2 / Docker / nginx so the PM2, Docker and Replicas pages have something to show
for (const dir of ['nginx/conf', 'nginx/log', 'flags', 'apps/web', 'pm2']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
const docker = await startFakeDocker(path.join(tmp, 'docker.sock'), { flags: path.join(tmp, 'flags') });
const nginx = `${process.execPath} ${path.join(here, 'fake-nginx.js')}`;
const host = {
  PM2_BIN: `${process.execPath} ${path.join(here, 'fake-pm2.js')}`, FAKE_PM2_STATE: path.join(tmp, 'pm2', 'state.json'), FAKE_FLAGS: path.join(tmp, 'flags'),
  DOCKER_SOCKET: path.join(tmp, 'docker.sock'), NGINX_TEST: `${nginx} test`, NGINX_RELOAD: `${nginx} reload`, NGINX_VERSION_CMD: `${nginx} version`,
  LB_CONF_DIR: path.join(tmp, 'nginx/conf'), LB_LOG_DIR: path.join(tmp, 'nginx/log'), LB_STATUS_PORT: '18189', REPLICA_PORTS: '25000-25099', LB_PORTS: '25100-25199',
  HOST_APP_ROOTS: path.join(tmp, 'apps'),
};
console.log(`Demo app folder for PM2: ${path.join(tmp, 'apps/web')}`);
const p = spawn(process.execPath, ['server.js'], {
  cwd: path.join(here, '..'), stdio: 'inherit',
  env: { ...process.env, PORT: port, DB_PATH: dbPath, LXD_SOCKET: sock, SESSION_SECRET: 'd'.repeat(64), COOKIE_SECURE: 'false', BACKUP_DISK_CHECK: 'off', BACKUP_HELPER: '/nonexistent', BACKUP_STATE_DIR: path.join(tmp, 'state'), ...host },
});
const stop = async () => {
  try { execFileSync(process.execPath, [path.join(here, 'fake-pm2.js'), 'killall'], { env: { ...process.env, ...host } }); } catch { /* ignore */ }
  await docker.close();
  p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
