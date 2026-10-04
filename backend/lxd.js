// Minimal LXD REST client over the local unix socket (no shelling out).
import http from 'node:http';
import { CONTAINER_RE } from './db.js';

const SOCKET = process.env.LXD_SOCKET || '/var/snap/lxd/common/lxd/unix.socket';
const TIMEOUT_MS = 15_000;

export class LxdError extends Error {}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCKET,
      path,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          return reject(new LxdError(`LXD sent a non-JSON reply (HTTP ${res.statusCode})`));
        }
        if (data.type === 'error' || res.statusCode >= 400) {
          return reject(new LxdError(data.error || `LXD error (HTTP ${res.statusCode})`));
        }
        return resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new LxdError('LXD did not answer in time')));
    req.on('error', (err) => reject(err instanceof LxdError ? err : new LxdError(`Cannot reach LXD: ${err.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function instancePath(name, suffix = '') {
  if (!CONTAINER_RE.test(name)) throw new LxdError('Invalid container name');
  return `/1.0/instances/${encodeURIComponent(name)}${suffix}`;
}

// Full instance objects (config, expanded_config, expanded_devices, status, last_used_at...)
export const listInstances = async () => (await request('GET', '/1.0/instances?recursion=1')).metadata || [];
export const getInstance = async (name) => (await request('GET', instancePath(name, '?recursion=1'))).metadata;
export const getState = async (name) => (await request('GET', instancePath(name, '/state'))).metadata;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts start/stop/restart and polls the background operation until LXD reports it finished.
// onProgress is called with each operation status while it runs.
export async function changeState(name, action, onProgress = () => {}) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new LxdError('Invalid action');
  const res = await request('PUT', instancePath(name, '/state'), { action, timeout: 30, force: false });
  if (res.type !== 'async' || !res.operation) return; // finished synchronously
  const opPath = res.operation;
  if (!/^\/1\.0\/operations\/[0-9a-f-]{36}$/.test(opPath)) throw new LxdError('Unexpected operation path from LXD');

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const op = (await request('GET', opPath)).metadata;
    // 103 Running, 105 Pending, 106 Starting, 107 Stopping, 200 Success, 400 Failure, 401 Cancelled
    if (op.status_code >= 400) throw new LxdError(op.err || `Operation ${op.status}`);
    if (op.status_code === 200) return;
    onProgress(op.status);
    await sleep(1000);
  }
  throw new LxdError('Gave up waiting for LXD after 2 minutes');
}

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
