// Restricted host command execution (SecurityService "command execution restrictions").
// Only these programs can be run, always as argv arrays (never through a shell), with timeouts and output caps.
// Paths come from .env so tests (and unusual installs) can point at other binaries; the UI can never choose them.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { conflict, bad } from './http.js';

const split = (s) => String(s).trim().split(/\s+/).filter(Boolean);

// name -> argv prefix
const PROGRAMS = {
  pm2: () => split(process.env.PM2_BIN || 'pm2'),
  docker: () => split(process.env.DOCKER_BIN || 'docker'),
  nginxTest: () => split(process.env.NGINX_TEST || 'sudo -n /usr/sbin/nginx -t'),
  nginxReload: () => split(process.env.NGINX_RELOAD || 'sudo -n /usr/bin/systemctl reload nginx'),
  nginxVersion: () => split(process.env.NGINX_VERSION_CMD || '/usr/sbin/nginx -v'),
};

export function hostRun(program, args = [], { timeout = 30_000, maxBuffer = 8 * 1024 * 1024, cwd, env } = {}) {
  const make = PROGRAMS[program];
  if (!make) throw new Error(`Program ${program} is not allowed`);
  if (!args.every((a) => typeof a === 'string' && !a.includes('\0'))) throw new Error('Bad argument');
  const [cmd, ...pre] = make();
  return new Promise((resolve) => {
    execFile(cmd, [...pre, ...args], { timeout, maxBuffer, cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true },
      (err, stdout = '', stderr = '') => resolve({
        ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout), stderr: String(stderr), error: err && (err.code === 'ENOENT' ? `${cmd} is not installed` : err.killed ? 'timed out' : null),
      }));
  });
}

// ---------- locks: one infrastructure change per resource at a time ----------
const held = new Map(); // key -> { what, since }
export const locks = {
  async with(key, what, fn) {
    const cur = held.get(key);
    if (cur) throw conflict(`Busy: ${cur.what} (started ${Math.round((Date.now() - cur.since) / 1000)}s ago). Try again when it finishes.`);
    held.set(key, { what, since: Date.now() });
    try { return await fn(); } finally { held.delete(key); }
  },
  busy: (key) => held.get(key) || null,
};

// ---------- directories the panel may run apps from / build from ----------
// HOST_APP_ROOTS: comma list of absolute folders (default: the panel user's home). System folders are always refused.
const DENY = ['/etc', '/root', '/proc', '/sys', '/dev', '/boot', '/var/lib', '/var/snap', '/snap', '/usr', '/bin', '/sbin', '/lib'];
export const appRoots = () => (process.env.HOST_APP_ROOTS || os.homedir()).split(',').map((s) => s.trim()).filter((s) => path.isAbsolute(s)).map((s) => path.resolve(s));

export function allowedDir(input, name = 'Folder') {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 300) throw bad(`${name} must be an absolute path`);
  let real;
  try { real = fs.realpathSync(input); } catch { throw bad(`${name} does not exist: ${input}`); }
  if (!fs.statSync(real).isDirectory()) throw bad(`${name} is not a folder`);
  if (DENY.some((d) => real === d || real.startsWith(`${d}/`))) throw bad(`${name} is a system folder`);
  const roots = appRoots();
  if (!roots.some((r) => real === r || real.startsWith(`${r}/`))) throw bad(`${name} must be inside ${roots.join(' or ')} (HOST_APP_ROOTS)`);
  return real;
}

// KEY=value lines -> object (validated names, size-limited)
export function parseEnv(text) {
  if (text == null || text === '') return {};
  if (typeof text === 'object') text = Object.entries(text).map(([k, v]) => `${k}=${v}`).join('\n');
  if (typeof text !== 'string' || text.length > 32_000) throw bad('Environment is too large');
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) throw bad(`Bad environment line: ${line.slice(0, 40)}`);
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw bad(`Bad variable name: ${k.slice(0, 40)}`);
    out[k] = line.slice(i + 1);
  }
  if (Object.keys(out).length > 200) throw bad('At most 200 variables');
  return out;
}

// Last `lines` lines of a file (reads at most the last 512 KB)
export function tailFile(file, lines = 200) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-lines - 1).join('\n');
  } catch {
    return '';
  }
}
