// Port forwarding for apps in LXD containers. cloudflared runs on the HOST and routes a public hostname to
// http://localhost:<port>. A process inside a container is not on the host's localhost, so every app port gets an LXD
// proxy device on its container:
//
//   port<PORT>: type=proxy listen=tcp:127.0.0.1:<PORT> connect=tcp:127.0.0.1:<PORT>
//
// The host side listens on 127.0.0.1 only (never 0.0.0.0), so nothing is opened to the network: the tunnel is the
// only way in. Devices are changed through the LXD REST API (JSON over the local socket), so no shell is involved and
// user input is never spliced into a command. The only host program run here is curl, through execFile with an
// argument array, for the health check.
//
// PORT_FORWARD=off turns this off (the old behaviour: routes go to the container IP).
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { getInstance, listInstances, updateInstance } from './lxd.js';

export const forwardingEnabled = () => process.env.PORT_FORWARD !== 'off';

const NAME_RE = /^[a-z0-9-]+$/;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export class ForwardError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export function checkPort(port) {
  const n = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) throw new ForwardError(`Port must be a whole number from ${MIN_PORT} to ${MAX_PORT}`, 400);
  return n;
}
export function checkContainer(name) {
  if (typeof name !== 'string' || name.length > 63 || !NAME_RE.test(name)) throw new ForwardError('Container names may only use a-z, 0-9 and dashes', 400);
  return name;
}

export const deviceName = (port) => `port${checkPort(port)}`;
export const wantedDevice = (port) => ({ type: 'proxy', listen: `tcp:127.0.0.1:${port}`, connect: `tcp:127.0.0.1:${port}` });
export const localTarget = (port) => `http://localhost:${checkPort(port)}`;

// Port a proxy device listens on at the host ("tcp:127.0.0.1:4023", "tcp:0.0.0.0:80" -> 4023 / 80), or null
function listenPort(dev) {
  if (dev?.type !== 'proxy' || typeof dev.listen !== 'string') return null;
  const m = /^tcp:(?:\[[^\]]*\]|[^:]*):(\d+)(?:-\d+)?$/.exec(dev.listen);
  return m ? Number(m[1]) : null;
}
const sameDevice = (dev, port) => {
  const w = wantedDevice(port);
  return dev?.type === w.type && dev.listen === w.listen && dev.connect === w.connect;
};
const devicesOf = (inst) => ({ ...(inst.expanded_devices || {}), ...(inst.devices || {}) });

// Can the host bind 127.0.0.1:<port>? false = something on the host already listens there.
export function hostPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (err) => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES'));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

// State of the forward for one container + port:
//   ok        port<PORT> exists with exactly the wanted config
//   different port<PORT> exists with another config (will be replaced)
//   other     another device in this container already forwards 127.0.0.1:<PORT> to <PORT> (added by hand); left alone
//   missing   nothing forwards this port
export async function forwardStatus(container, port) {
  checkContainer(container);
  checkPort(port);
  const inst = await getInstance(container);
  const devs = devicesOf(inst);
  const name = deviceName(port);
  if (devs[name]) return { status: sameDevice(devs[name], port) ? 'ok' : 'different', device: name, config: devs[name] };
  const other = Object.entries(devs).find(([, d]) => sameDevice(d, port));
  if (other) return { status: 'other', device: other[0], config: other[1] };
  return { status: 'missing', device: name, config: null };
}

// Host ports an app may never take, even while nothing listens there: a stopped database or the panel itself would
// otherwise have its localhost traffic captured by a customer's container. PORT_FORWARD_RESERVED adds more (comma list).
const RESERVED = [
  2026, 4000, // the panels
  2375, 2376, 2379, 2380, 3306, 33060, 5432, 5433, 5672, 15672, 6379, 6380, 8200, 8443, 9050, 9090, 9200, 9300, 11211, 27017, 27018, 27019,
];
export function reservedPorts() {
  const extra = String(process.env.PORT_FORWARD_RESERVED || '').split(',').map((x) => Number(x.trim())).filter(Number.isInteger);
  return new Set([...RESERVED, Number(process.env.PORT) || 4000, ...extra]);
}

// Who else holds host port <port>? Another container's proxy device, or a host program. Returns text or null.
export async function hostConflict(container, port, { probeHost = true } = {}) {
  checkContainer(container);
  checkPort(port);
  if (reservedPorts().has(port)) return `Host port ${port} is reserved for services on the host. Pick another port for this app.`;
  for (const inst of await listInstances()) {
    if (inst.name === container) continue;
    for (const [dev, d] of Object.entries(devicesOf(inst))) {
      if (listenPort(d) === port) return `Host port ${port} is already forwarded to the container ${inst.name} (device ${dev}). Pick another port for this app.`;
    }
  }
  if (probeHost && !(await hostPortFree(port))) {
    return `Host port ${port} is already in use by another program on the host (not a Sampanna Cloud app). Pick another port for this app.`;
  }
  return null;
}

// Why port <port> cannot be forwarded to this container right now (text), or null when it can (or already is).
// A container that does not exist yet (a new app host) only needs the host side to be free.
export async function portProblem(container, port) {
  let cur;
  try { cur = await forwardStatus(container, port); } catch (err) {
    if (err.status !== 404) throw err;
    cur = { status: 'missing', config: null };
  }
  if (cur.status === 'ok' || cur.status === 'other') return null;
  // A differently configured port<PORT> in this container may hold the host port itself; only probe when it does not
  const holdsPort = cur.status === 'different' && listenPort(cur.config) === port;
  return hostConflict(container, port, { probeHost: !holdsPort });
}

// LXD refuses a write whose ETag is stale (another change landed in between): read again and retry
async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i += 1) {
    try { return await fn(); } catch (err) {
      if (i >= tries || !/etag|precondition/i.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 200 * i));
    }
  }
}

// Creates or repairs the forward. Idempotent: same config = nothing to do.
// Resolves { action: 'unchanged'|'created'|'updated'|'manual', device }; throws ForwardError on a conflict.
export async function ensureForward(container, port) {
  checkContainer(container);
  checkPort(port);
  const cur = await forwardStatus(container, port);
  if (cur.status === 'ok') return { action: 'unchanged', device: cur.device };
  if (cur.status === 'other') return { action: 'manual', device: cur.device };
  const conflict = await portProblem(container, port);
  if (conflict) throw new ForwardError(conflict);
  const name = deviceName(port);
  await withRetry(() => updateInstance(container, (next) => {
    // A device that came from a profile cannot be edited here; the local one overrides it
    next.devices[name] = wantedDevice(port);
  }));
  return { action: cur.status === 'different' ? 'updated' : 'created', device: name };
}

// Removes port<PORT> from the container, but only a device that has the shape this module creates (a proxy listening
// on the host's 127.0.0.1:<PORT>), so a hand-made device with another purpose is never deleted.
export async function removeForward(container, port) {
  checkContainer(container);
  checkPort(port);
  const name = deviceName(port);
  const inst = await getInstance(container);
  const d = inst.devices?.[name];
  if (!d) return false;
  if (d.type !== 'proxy' || listenPort(d) !== port || !/^tcp:127\.0\.0\.1:/.test(d.listen)) return false;
  await withRetry(() => updateInstance(container, (next) => { delete next.devices[name]; }));
  return true;
}

// One request to http://127.0.0.1:<port> from the host. Any HTTP status is a success (the app answered).
// Uses curl as asked for in the runbook; falls back to Node's http client where curl is not installed.
export function probe(port, { timeoutMs = 5000 } = {}) {
  checkPort(port);
  const url = `http://127.0.0.1:${port}/`;
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(Math.ceil(timeoutMs / 1000)), url], { timeout: timeoutMs + 2000 }, (err, stdout) => {
      if (err?.code === 'ENOENT') return resolve(probeNode(port, timeoutMs));
      const code = Number(String(stdout).trim());
      if (code >= 100 && code <= 599) return resolve({ ok: true, code });
      const why = { 7: 'connection refused', 28: 'timed out', 52: 'empty reply', 56: 'connection reset' }[err?.code] || (err ? `curl exit ${err.code}` : 'no HTTP answer');
      return resolve({ ok: false, code: null, error: why });
    });
  });
}
function probeNode(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => { res.resume(); resolve({ ok: true, code: res.statusCode }); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve({ ok: false, code: null, error: err.code === 'ECONNREFUSED' ? 'connection refused' : err.code || err.message }));
  });
}

// Tries a few times (apps take a moment to bind). say(line) gets one line per attempt.
export async function healthCheck(port, { tries = Number(process.env.HEALTH_TRIES) || 5, delayMs = Number(process.env.HEALTH_DELAY_MS) || 2000, say = () => {} } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i += 1) {
    last = await probe(port);
    if (last.ok) { say(`HTTP ${last.code} from http://127.0.0.1:${port} (try ${i}/${tries})`); return { ...last, tries: i }; }
    say(`try ${i}/${tries}: ${last.error}`);
    if (i < tries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ...last, tries };
}
