// LXD REST client over the local unix socket. Nothing here shells out, and the socket is never exposed:
// the browser only talks to the panel, which talks to LXD on behalf of an authorised session.
import http from 'node:http';
import WebSocket from 'ws';
import { CONTAINER_RE } from './db.js';

const SOCKET = process.env.LXD_SOCKET || '/var/snap/lxd/common/lxd/unix.socket';
const TIMEOUT_MS = 15_000;

export class LxdError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Low-level request. Returns { status, headers, body (Buffer) }.
function raw(method, path, { body = null, headers = {}, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET, path, method, timeout,
      headers: body != null ? { 'content-length': Buffer.byteLength(body), ...headers } : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new LxdError('LXD did not answer in time', 504)));
    req.on('error', (err) => reject(err instanceof LxdError ? err : new LxdError(`Cannot reach LXD: ${err.message}`, 503)));
    if (body != null) req.write(body);
    req.end();
  });
}

async function request(method, path, body, { headers = {}, timeout } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  const r = await raw(method, path, {
    body: payload, timeout, headers: payload ? { 'content-type': 'application/json', ...headers } : headers,
  });
  let data;
  try { data = JSON.parse(r.body.toString('utf8')); } catch {
    throw new LxdError(`LXD sent a non-JSON reply (HTTP ${r.status})`);
  }
  if (data.type === 'error' || r.status >= 400) {
    throw new LxdError(data.error || `LXD error (HTTP ${r.status})`, r.status === 404 ? 404 : r.status === 409 ? 409 : 502);
  }
  data.etag = r.headers.etag;
  return data;
}

const enc = encodeURIComponent;
function instancePath(name, suffix = '') {
  if (!CONTAINER_RE.test(name)) throw new LxdError('Invalid container name', 400);
  return `/1.0/instances/${enc(name)}${suffix}`;
}
const SNAP_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const validSnapshotName = (s) => typeof s === 'string' && SNAP_RE.test(s);

// ---------- operations ----------
function opPath(res) {
  const p = res.operation;
  if (!/^\/1\.0\/operations\/[0-9a-f-]{36}$/.test(p || '')) throw new LxdError('Unexpected operation path from LXD');
  return p;
}

// Waits for a background operation. onProgress gets the operation metadata (e.g. image download progress).
export async function waitOperation(res, { timeoutMs = 300_000, onProgress = () => {} } = {}) {
  if (res.type !== 'async') return res.metadata;
  const p = opPath(res);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let op;
    try {
      op = (await request('GET', `${p}/wait?timeout=2`, null, { timeout: 10_000 })).metadata;
    } catch (err) {
      // An expired wait only means "still running". LXD 5.21 reports it as an error body with the message below
      // (HTTP 200, error_code 500); other versions send 504. Real operation failures arrive in op.err further down.
      if (err.status === 504 || /context deadline exceeded/i.test(err.message)) continue;
      throw err;
    }
    // 103 Running, 105 Pending, 106 Starting, 107 Stopping, 200 Success, 400 Failure, 401 Cancelled
    if (op.status_code >= 400) throw new LxdError(op.err || `Operation ${op.status}`);
    if (op.status_code === 200) return op.metadata || {};
    onProgress(op.metadata || {}, op.status);
  }
  throw new LxdError(`Gave up waiting for LXD after ${Math.round(timeoutMs / 1000)} seconds`, 504);
}

// ---------- server ----------
export const serverInfo = async () => (await request('GET', '/1.0')).metadata;
export const hasExtension = async (ext) => ((await serverInfo()).api_extensions || []).includes(ext);
export const getProfile = async (name) => (await request('GET', `/1.0/profiles/${enc(name)}`)).metadata;
export const getNetwork = async (name) => (await request('GET', `/1.0/networks/${enc(name)}`)).metadata;
export const listNetworks = async () => (await request('GET', '/1.0/networks?recursion=1')).metadata || [];
export const listStoragePools = async () => (await request('GET', '/1.0/storage-pools?recursion=1')).metadata || [];
export const poolResources = async (pool) => (await request('GET', `/1.0/storage-pools/${enc(pool)}/resources`)).metadata;
export const networkLeases = async (net) => (await request('GET', `/1.0/networks/${enc(net)}/leases`)).metadata || [];

// ---------- instances ----------
export const listInstances = async () => (await request('GET', '/1.0/instances?recursion=1')).metadata || [];
export const getInstance = async (name) => (await request('GET', instancePath(name, '?recursion=1'))).metadata;
export const getState = async (name) => (await request('GET', instancePath(name, '/state'))).metadata;

const STATE_ACTIONS = ['start', 'stop', 'restart', 'freeze', 'unfreeze'];

// start/stop/restart/freeze/unfreeze; waits until LXD reports it finished.
export async function changeState(name, action, onProgress = () => {}, { force = false } = {}) {
  if (!STATE_ACTIONS.includes(action)) throw new LxdError('Invalid action', 400);
  const res = await request('PUT', instancePath(name, '/state'), { action, timeout: 30, force });
  await waitOperation(res, { timeoutMs: 120_000, onProgress: (_m, status) => onProgress(status) });
}

// Ubuntu LTS images from the official simplestreams server (the `ubuntu:` remote)
export const IMAGES = {
  'ubuntu-26.04': { alias: '26.04', label: 'Ubuntu 26.04 LTS' },
  'ubuntu-24.04': { alias: '24.04', label: 'Ubuntu 24.04 LTS' },
  'ubuntu-22.04': { alias: '22.04', label: 'Ubuntu 22.04 LTS' },
};
const imageSource = (key) => {
  const img = IMAGES[key];
  if (!img) throw new LxdError('Unknown image', 400);
  return { type: 'image', mode: 'pull', server: 'https://cloud-images.ubuntu.com/releases', protocol: 'simplestreams', alias: img.alias };
};

export async function createInstance({ name, image, config, devices, profiles = ['default'], description = '' }, onProgress) {
  const res = await request('POST', '/1.0/instances', {
    name, type: 'container', source: imageSource(image), config, devices, profiles, description,
  });
  await waitOperation(res, { timeoutMs: 20 * 60_000, onProgress });
}

export async function deleteInstance(name) {
  await waitOperation(await request('DELETE', instancePath(name)), { timeoutMs: 10 * 60_000 });
}

// Copy (clone) without snapshots. LXD gives the copy new MAC addresses.
export async function copyInstance(source, name, { config, devices } = {}, onProgress) {
  const res = await request('POST', '/1.0/instances', {
    name, type: 'container', source: { type: 'copy', source, instance_only: true }, ...(config ? { config } : {}), ...(devices ? { devices } : {}),
  });
  await waitOperation(res, { timeoutMs: 30 * 60_000, onProgress });
}

export async function renameInstance(name, newName) {
  await waitOperation(await request('POST', instancePath(name), { name: newName }), { timeoutMs: 5 * 60_000 });
}

// Needs the "instance_rebuild" API extension (LXD 5.19+). Replaces the root filesystem with a fresh image.
export async function rebuildInstance(name, image, onProgress) {
  const res = await request('POST', instancePath(name, '/rebuild'), { source: imageSource(image) });
  await waitOperation(res, { timeoutMs: 20 * 60_000, onProgress });
}

// Read-modify-write of config/devices with the ETag, so a concurrent change is never overwritten silently.
export async function updateInstance(name, mutate) {
  const cur = await request('GET', instancePath(name));
  const m = cur.metadata;
  const next = {
    architecture: m.architecture, config: { ...m.config }, devices: JSON.parse(JSON.stringify(m.devices || {})),
    ephemeral: m.ephemeral, profiles: m.profiles, description: m.description,
  };
  mutate(next, m);
  for (const k of Object.keys(next.config)) if (next.config[k] === null) delete next.config[k];
  const res = await request('PUT', instancePath(name), next, { headers: cur.etag ? { 'if-match': cur.etag } : {} });
  await waitOperation(res, { timeoutMs: 120_000 });
}

// ---------- snapshots ----------
export const listSnapshots = async (name) => (await request('GET', instancePath(name, '/snapshots?recursion=1'))).metadata || [];
export async function createSnapshot(name, snap) {
  if (!validSnapshotName(snap)) throw new LxdError('Snapshot names: letters, digits, dot, dash, underscore', 400);
  await waitOperation(await request('POST', instancePath(name, '/snapshots'), { name: snap, stateful: false }), { timeoutMs: 15 * 60_000 });
}
export async function deleteSnapshot(name, snap) {
  if (!validSnapshotName(snap)) throw new LxdError('Invalid snapshot name', 400);
  await waitOperation(await request('DELETE', instancePath(name, `/snapshots/${enc(snap)}`)), { timeoutMs: 10 * 60_000 });
}
// Rolls the container back to the snapshot (everything written after it is lost)
export async function restoreSnapshot(name, snap) {
  if (!validSnapshotName(snap)) throw new LxdError('Invalid snapshot name', 400);
  await updateInstanceRaw(name, { restore: snap });
}
async function updateInstanceRaw(name, body) {
  await waitOperation(await request('PUT', instancePath(name), body), { timeoutMs: 15 * 60_000 });
}

// ---------- logs ----------
// LXD's own log for the instance (start/stop problems) and the console output (boot messages)
export async function instanceLog(name, file = 'lxc.log') {
  if (!/^[a-z0-9_.-]{1,64}$/i.test(file)) throw new LxdError('Invalid log name', 400);
  const r = await raw('GET', instancePath(name, `/logs/${enc(file)}`));
  if (r.status === 404) return '';
  if (r.status >= 400) throw new LxdError(`Cannot read log (HTTP ${r.status})`);
  return r.body.toString('utf8');
}
export async function consoleLog(name) {
  const r = await raw('GET', instancePath(name, '/console'));
  if (r.status >= 400) return '';
  return r.body.toString('utf8');
}

// ---------- files inside the container ----------
export async function readFile(name, filePath) {
  const r = await raw('GET', instancePath(name, `/files?path=${enc(filePath)}`));
  if (r.status === 404) return null;
  if (r.status >= 400) {
    let msg = `HTTP ${r.status}`;
    try { msg = JSON.parse(r.body.toString()).error || msg; } catch { /* raw */ }
    throw new LxdError(`Cannot read ${filePath}: ${msg}`);
  }
  return { content: r.body, uid: Number(r.headers['x-lxd-uid']), gid: Number(r.headers['x-lxd-gid']), type: r.headers['x-lxd-type'] };
}
export async function writeFile(name, filePath, content, { uid = 0, gid = 0, mode = '0600', type = 'file' } = {}) {
  const r = await raw('POST', instancePath(name, `/files?path=${enc(filePath)}`), {
    body: type === 'directory' ? '' : content,
    headers: {
      'content-type': 'application/octet-stream', 'x-lxd-uid': String(uid), 'x-lxd-gid': String(gid),
      'x-lxd-mode': mode, 'x-lxd-type': type, 'x-lxd-write': 'overwrite',
    },
  });
  if (r.status >= 400) {
    let msg = `HTTP ${r.status}`;
    try { msg = JSON.parse(r.body.toString()).error || msg; } catch { /* raw */ }
    throw new LxdError(`Cannot write ${filePath}: ${msg}`);
  }
}

// ---------- exec ----------
const opSocket = (op, secret) => new WebSocket(`ws+unix://${SOCKET}:${op}/websocket?secret=${enc(secret)}`);
const opened = (ws) => new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

// Runs a command (argument array, never a host shell) and streams its output.
// Resolves { code, output } where output is the last `keep` bytes of stdout+stderr.
export async function execStream(name, command, { env = {}, cwd, user = 0, timeoutMs = 10 * 60_000, onOutput = () => {}, keep = 256 * 1024 } = {}) {
  if (!Array.isArray(command) || !command.length || !command.every((a) => typeof a === 'string')) throw new LxdError('Invalid command', 400);
  const res = await request('POST', instancePath(name, '/exec'), {
    command, environment: { HOME: '/root', LANG: 'C.UTF-8', ...env }, cwd, user,
    'wait-for-websocket': true, interactive: false,
  });
  const p = opPath(res);
  const fds = res.metadata?.metadata?.fds || {};
  const socks = {};
  let out = '';
  const push = (buf) => {
    const text = buf.toString('utf8');
    out = (out + text).slice(-keep);
    onOutput(text);
  };
  for (const fd of ['0', '1', '2', 'control']) {
    if (!fds[fd]) throw new LxdError('LXD did not offer the exec streams');
    socks[fd] = opSocket(p, fds[fd]);
  }
  // Listen before the sockets finish opening: the command starts as soon as the last one connects,
  // and output sent before a listener is attached would be lost.
  const closed = ['1', '2'].map((fd) => new Promise((resolve) => {
    socks[fd].on('message', (data) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    socks[fd].once('close', resolve);
  }));
  await Promise.all(Object.values(socks).map(opened));
  const timer = setTimeout(() => {
    try { socks.control.send(JSON.stringify({ command: 'signal', args: {}, signal: 9 })); } catch { /* gone */ }
    push(Buffer.from(`\n[Kapil Cloud] Stopped after ${Math.round(timeoutMs / 60000)} minutes\n`));
  }, timeoutMs);
  try {
    const meta = await waitOperation(res, { timeoutMs: timeoutMs + 60_000 });
    await Promise.race([Promise.all(closed), new Promise((r) => setTimeout(r, 3000))]);
    return { code: Number(meta?.return ?? -1), output: out };
  } finally {
    clearTimeout(timer);
    for (const ws of Object.values(socks)) { try { ws.close(); } catch { /* ignore */ } }
  }
}

// Interactive shell (PTY) for the browser terminal. Returns handles; the caller wires them to the client.
export async function execInteractive(name, { command, env = {}, cols = 80, rows = 24, user = 0, cwd = '/root' }) {
  const res = await request('POST', instancePath(name, '/exec'), {
    command, environment: { TERM: 'xterm-256color', HOME: '/root', LANG: 'C.UTF-8', ...env },
    cwd, user, interactive: true, 'wait-for-websocket': true, width: cols, height: rows,
  });
  const p = opPath(res);
  const fds = res.metadata?.metadata?.fds || {};
  if (!fds['0'] || !fds.control) throw new LxdError('LXD did not offer the terminal streams');
  const pty = opSocket(p, fds['0']);
  const control = opSocket(p, fds.control);
  // The shell starts as soon as both sockets connect, so its first output (the prompt) can arrive before the caller
  // has attached anything. Hold it until onData is called.
  const early = [];
  let sink = null;
  pty.on('message', (data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // An empty frame is LXD's end-of-stream: the shell has exited, and the operation stays open until we hang up
    if (!b.length) { try { pty.close(); control.close(); } catch { /* gone */ } return; }
    if (sink) sink(b); else early.push(b);
  });
  await Promise.all([opened(pty), opened(control)]);
  // `opened` only listens while connecting; an unhandled 'error' after that would take the whole panel down
  pty.on('error', () => {});
  control.on('error', () => {});
  const done = waitOperation(res, { timeoutMs: 24 * 3600_000 }).then((m) => Number(m?.return ?? 0), () => -1);
  return {
    pty,
    done,
    onData: (fn) => { sink = fn; for (const b of early.splice(0)) fn(b); },
    write: (data) => { if (pty.readyState === WebSocket.OPEN) pty.send(Buffer.from(data, 'utf8')); },
    resize: (c, r) => {
      if (control.readyState === WebSocket.OPEN) {
        control.send(JSON.stringify({ command: 'window-resize', args: { width: String(c), height: String(r) } }));
      }
    },
    close: () => {
      try { control.send(JSON.stringify({ command: 'signal', args: {}, signal: 1 })); } catch { /* gone */ }
      setTimeout(() => { try { pty.close(); control.close(); } catch { /* ignore */ } }, 200);
    },
  };
}

// ---------- sizes ----------
// "4GiB", "512MB", "2048" (bytes) -> bytes. Percent values return null (caller falls back).
export function parseSize(v) {
  if (v == null || v === '') return null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]i?B|B)?$/i);
  if (!m) return null;
  const unit = (m[2] || 'B').toUpperCase();
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5, EB: 6 };
  const base = unit.includes('I') ? 1024 : 1000;
  const exp = pow[unit.replace('I', '')] ?? 0;
  return Math.round(Number(m[1]) * base ** exp);
}
export const toMiB = (bytes) => `${Math.max(1, Math.round(bytes / 1048576))}MiB`;
export const toGiB = (bytes) => `${Math.max(1, Math.round(bytes / 1073741824))}GiB`;
