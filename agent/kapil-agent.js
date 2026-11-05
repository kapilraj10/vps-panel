#!/usr/bin/env node
// Kapil Cloud node agent. One file, no dependencies, Node.js 22+ (uses the built-in WebSocket and fetch).
//
//   node kapil-agent.js enroll --master https://panel.example.com --token <one-time token> [--config /etc/kapil-agent/agent.json]
//   node kapil-agent.js run [--config /etc/kapil-agent/agent.json]
//
// It dials OUT to the control plane (wss://<master>/agent/v1/connect): the node opens no inbound port.
// Every 15 s it sends measured facts (from /proc, statfs, os, the Docker socket and `pm2 jlist`); the control plane can
// call a FIXED list of operations (below). There is no "run this command" operation. Management operations (PM2 / Docker
// actions) only work if this node's config enables them ("manage": { "pm2": true, "docker": true }).
// If the control plane is down, nothing here affects the apps on this node; the agent just keeps reconnecting.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const VERSION = '1.0.0';
const argv = process.argv.slice(2);
const flag = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const CONFIG = flag('config', process.env.KAPIL_AGENT_CONFIG || '/etc/kapil-agent/agent.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') {
  console.error(`kapil-agent needs Node.js 22 or newer (this is ${process.version}).`);
  process.exit(1);
}

const run = (cmd, args, { timeout = 20_000, maxBuffer = 8 * 1024 * 1024, env } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer, env: env ? { ...process.env, ...env } : process.env }, (err, stdout = '', stderr = '') => resolve({
    ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr),
    missing: err?.code === 'ENOENT', killed: !!err?.killed,
  }));
});
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// ============================== measurements ==============================
let prev = null; // previous counters for rates

function cpuTimes() {
  const out = {};
  for (const line of read('/proc/stat').split('\n')) {
    const m = line.match(/^(cpu\d*)\s+(.*)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.slice(0, 8).reduce((s, x) => s + (x || 0), 0);
    out[m[1]] = { idle, total };
  }
  return out;
}
const pctBusy = (a, b) => (a && b && b.total > a.total ? round(100 * (1 - (b.idle - a.idle) / (b.total - a.total))) : null);

function meminfo() {
  const kv = {};
  for (const l of read('/proc/meminfo').split('\n')) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) kv[m[1]] = Number(m[2]) * 1024; }
  const total = kv.MemTotal || os.totalmem();
  const available = kv.MemAvailable ?? os.freemem();
  return {
    total, available, free: kv.MemFree ?? null, used: total - available, buffers: kv.Buffers ?? null, cached: kv.Cached ?? null,
    swapTotal: kv.SwapTotal ?? 0, swapUsed: (kv.SwapTotal ?? 0) - (kv.SwapFree ?? 0),
  };
}

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'vfat', 'f2fs', 'reiserfs', 'jfs', 'ntfs', 'ntfs3', 'exfat', 'bcachefs']);
function filesystems() {
  const seen = new Set();
  const out = [];
  for (const line of read('/proc/mounts').split('\n')) {
    const [dev, mount, type] = line.split(' ');
    if (!REAL_FS.has(type) || seen.has(dev) || mount.startsWith('/snap/') || mount.startsWith('/var/snap/')) continue;
    seen.add(dev);
    try {
      const s = fs.statfsSync(mount.replace(/\\040/g, ' '));
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      out.push({ device: dev, mount, type, total, used: total - s.bfree * s.bsize, free, inodesUsedPct: s.files ? round(100 * (1 - s.ffree / s.files)) : null });
    } catch { /* unreadable mount */ }
  }
  return out;
}

function diskCounters() {
  let r = 0;
  let w = 0;
  for (const line of read('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 10 || !/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(p[2])) continue;
    r += Number(p[5]) * 512;
    w += Number(p[9]) * 512;
  }
  return { r, w };
}

const VIRTUAL_IF = /^(lo|veth|lxdbr|br-|docker|virbr|cni|flannel|tap|tun|wg)/;
function netCounters() {
  const out = {};
  for (const line of read('/proc/net/dev').split('\n').slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[m[1]] = { rx: v[0], rxPackets: v[1], rxErrors: v[2], rxDrops: v[3], tx: v[8], txPackets: v[9], txErrors: v[10], txDrops: v[11] };
  }
  return out;
}

// LISTEN sockets and ESTABLISHED count from /proc/net/tcp{,6} (no extra tools)
function sockets() {
  const listen = new Map();
  let established = 0;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of read(f).split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 4) continue;
      if (p[3] === '01') established += 1;
      if (p[3] !== '0A') continue;
      const [hexIp, hexPort] = p[1].split(':');
      const port = parseInt(hexPort, 16);
      let addr;
      if (hexIp.length === 8) addr = hexIp.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
      else addr = /^0+$/.test(hexIp) ? '::' : (hexIp === '00000000000000000000000001000000' ? '::1' : 'ipv6');
      listen.set(`${addr}:${port}`, { addr, port, proto: f.endsWith('6') ? 'tcp6' : 'tcp' });
    }
  }
  return { listening: [...listen.values()].sort((a, b) => a.port - b.port).slice(0, 300), established };
}

function processes() {
  const pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  const page = 4096;
  const top = [];
  for (const pid of pids) {
    const statm = read(`/proc/${pid}/statm`);
    if (!statm) continue;
    const rss = Number(statm.split(' ')[1]) * page;
    if (top.length < 10 || rss > top[top.length - 1].rss) {
      top.push({ pid: Number(pid), rss });
      top.sort((a, b) => b.rss - a.rss);
      if (top.length > 10) top.pop();
    }
  }
  for (const p of top) {
    p.name = read(`/proc/${p.pid}/comm`).trim();
    try { p.user = fs.statSync(`/proc/${p.pid}`).uid; } catch { p.user = null; }
  }
  return { count: pids.length, topMemory: top };
}

function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (name === 'lo') continue;
    out.push({ name, mac: addrs[0]?.mac || null, addresses: addrs.map((a) => ({ address: a.address, family: a.family, cidr: a.cidr, internal: a.internal })) });
  }
  return out;
}

function osRelease() {
  const kv = Object.fromEntries(read('/etc/os-release').split('\n').map((l) => l.match(/^(\w+)="?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  return { pretty: kv.PRETTY_NAME || os.type(), id: kv.ID || null, version: kv.VERSION_ID || null };
}

async function failedServices() {
  const r = await run('systemctl', ['list-units', '--type=service', '--state=failed', '--no-legend', '--plain'], { timeout: 8000 });
  if (!r.ok && r.missing) return null;
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 50);
}

// ---------- PM2 / Docker (optional) ----------
const PM2 = () => (process.env.PM2_BIN || 'pm2').split(/\s+/);
async function pm2(args, timeout = 30_000) {
  const [cmd, ...pre] = PM2();
  return run(cmd, [...pre, ...args], { timeout });
}
async function pm2List() {
  const r = await pm2(['jlist']);
  if (!r.ok) return { available: false, error: r.missing ? 'pm2 not installed' : (r.stderr || 'pm2 jlist failed').trim().slice(0, 200) };
  const i = r.stdout.indexOf('[');
  const list = i < 0 ? [] : JSON.parse(r.stdout.slice(i));
  return {
    available: true,
    processes: list.map((p) => ({
      id: p.pm_id, name: p.name, pid: p.pid || null, status: p.pm2_env?.status, mode: p.pm2_env?.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
      instances: p.pm2_env?.instances ?? 1, cpu: p.monit?.cpu ?? 0, memory: p.monit?.memory ?? 0, restarts: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.status === 'online' ? p.pm2_env?.pm_uptime ?? null : null, port: Number(p.pm2_env?.env?.PORT) || null,
      cwd: p.pm2_env?.pm_cwd || null, outLog: p.pm2_env?.pm_out_log_path || null, errLog: p.pm2_env?.pm_err_log_path || null,
    })),
  };
}

const DOCKER_SOCKET = () => process.env.DOCKER_SOCKET || '/var/run/docker.sock';
function docker(method, p, { query, raw = false, timeout = 20_000 } = {}) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]))}` : '';
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET(), method, path: `/v1.41${p}${qs}`, timeout, headers: { host: 'docker' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = buf.toString();
          try { msg = JSON.parse(msg).message; } catch { /* text */ }
          return reject(new Error(`Docker: ${msg}`.slice(0, 300)));
        }
        if (raw) return resolve(buf);
        try { return resolve(buf.length ? JSON.parse(buf.toString()) : null); } catch { return resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker did not answer')));
    req.on('error', reject);
    req.end();
  });
}
async function dockerList() {
  try {
    const list = await docker('GET', '/containers/json', { query: { all: true } });
    return {
      available: true,
      containers: list.map((c) => ({
        id: c.Id.slice(0, 12), name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status, createdAt: c.Created * 1000,
        ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => ({ ip: p.IP, host: p.PublicPort, container: p.PrivatePort })),
        compose: c.Labels?.['com.docker.compose.project'] || null, managedApp: c.Labels?.['kapil.cloud.app'] || null,
      })),
    };
  } catch (e) {
    return { available: false, error: /ENOENT|ECONNREFUSED/.test(e.message) ? 'Docker not installed' : /EACCES/.test(e.message) ? 'No access to the Docker socket (add the agent user to the docker group)' : e.message };
  }
}
function demux(buf) {
  if (buf.length < 8 || ![0, 1, 2].includes(buf[0]) || buf[1] || buf[2] || buf[3]) return buf.toString();
  const out = [];
  for (let i = 0; i + 8 <= buf.length;) { const n = buf.readUInt32BE(i + 4); out.push(buf.subarray(i + 8, i + 8 + n).toString()); i += 8 + n; }
  return out.join('');
}

// ---------- one heartbeat ----------
let beat = 0;
let slow = { services: null, pm2: null, docker: null, processes: null };
async function facts() {
  const c = cpuTimes();
  const d = diskCounters();
  const n = netCounters();
  const now = Date.now();
  const mem = meminfo();
  const load = read('/proc/loadavg').split(' ').slice(0, 3).map(Number);
  const up = Number(read('/proc/uptime').split(' ')[0]) || os.uptime();
  const cpus = os.cpus();
  const dt = prev ? (now - prev.t) / 1000 : null;
  const rate = (a, b) => (dt && b >= a ? Math.round((b - a) / dt) : null);
  const ifaces = {};
  let rx = 0;
  let tx = 0;
  for (const [name, v] of Object.entries(n)) {
    const p = prev?.n[name];
    ifaces[name] = { ...v, rxRate: p ? rate(p.rx, v.rx) : null, txRate: p ? rate(p.tx, v.tx) : null };
    if (!VIRTUAL_IF.test(name) && p) { rx += rate(p.rx, v.rx) || 0; tx += rate(p.tx, v.tx) || 0; }
  }
  const perCore = Object.keys(c).filter((k) => k !== 'cpu').map((k) => pctBusy(prev?.c[k], c[k]));
  const result = {
    at: now,
    system: {
      hostname: os.hostname(), os: osRelease(), kernel: os.release(), arch: os.arch(), uptime: Math.round(up), bootedAt: now - Math.round(up * 1000),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, time: now, agentVersion: VERSION, node: process.version,
    },
    cpu: { model: cpus[0]?.model?.trim() || null, cores: cpus.length, mhz: cpus[0]?.speed || null, usage: pctBusy(prev?.c.cpu, c.cpu), perCore, load },
    memory: mem,
    disks: filesystems(),
    diskIo: { read: prev ? rate(prev.d.r, d.r) : null, write: prev ? rate(prev.d.w, d.w) : null, readTotal: d.r, writeTotal: d.w },
    network: { rx: prev ? rx : null, tx: prev ? tx : null, interfaces: interfaces(), counters: ifaces, ...sockets() },
  };
  prev = { t: now, c, d, n };
  // Heavier bits less often
  if (beat % 4 === 0) {
    const [services, pm, dk] = await Promise.all([failedServices(), pm2List(), dockerList()]);
    slow = { services, pm2: pm, docker: dk, processes: processes() };
  } else if (beat % 2 === 0) {
    const [pm, dk] = await Promise.all([pm2List(), dockerList()]);
    slow = { ...slow, pm2: pm, docker: dk };
  }
  beat += 1;
  const strip = (x) => (x?.processes ? { ...x, processes: x.processes.map(({ outLog, errLog, ...p }) => p) } : x);
  return { ...result, failedServices: slow.services, processes: slow.processes, pm2: strip(slow.pm2), docker: slow.docker };
}

// ============================== operations (validated here too) ==============================
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const host = (h) => { if (typeof h !== 'string' || !(net.isIP(h) || HOST_RE.test(h))) throw new Error('Bad target host'); return h; };
const intIn = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be ${lo}-${hi}`); return n; };
const jitterOf = (a) => (a.length > 1 ? a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1) : 0);

async function ping({ target, count = 5, ipv6 = false }) {
  const n = intIn(count, 1, 50, 'count');
  const r = await run('ping', [ipv6 ? '-6' : '-4', '-n', '-c', String(n), '-i', '0.2', '-W', '2', '-w', String(n + 3), '--', host(target)], { timeout: (n + 8) * 1000 });
  if (r.missing) throw new Error('ping is not installed on this node (apt install iputils-ping)');
  const out = r.stdout;
  const times = [...out.matchAll(/time[=<]([\d.]+) ms/g)].map((m) => Number(m[1]));
  const sum = out.match(/(\d+) packets transmitted, (\d+) (?:packets )?received/);
  const sent = sum ? Number(sum[1]) : n;
  const received = sum ? Number(sum[2]) : times.length;
  return {
    target, ip: out.match(/^PING \S+ \(([^)]+)\)/m)?.[1] || null, sent, received, loss: sent ? round(((sent - received) / sent) * 100) : 100,
    min: times.length ? round(Math.min(...times), 2) : null, avg: times.length ? round(times.reduce((s, v) => s + v, 0) / times.length, 2) : null,
    max: times.length ? round(Math.max(...times), 2) : null, jitter: times.length ? round(jitterOf(times), 2) : null, times,
    error: received ? null : (r.stderr.trim().split('\n').pop() || 'No reply'),
  };
}

async function traceroute({ target, maxHops = 20 }) {
  const m = intIn(maxHops, 1, 40, 'maxHops');
  const t = host(target);
  let r = await run('traceroute', ['-n', '-q', '1', '-w', '2', '-m', String(m), t], { timeout: (m * 3 + 10) * 1000 });
  let tool = 'traceroute';
  if (r.missing) { r = await run('tracepath', ['-n', '-m', String(m), t], { timeout: (m * 3 + 10) * 1000 }); tool = 'tracepath'; }
  if (r.missing) throw new Error('Neither traceroute nor tracepath is installed (apt install traceroute)');
  const hops = [];
  for (const line of r.stdout.split('\n')) {
    const mm = line.match(/^\s*(\d+)[:?]?\s+(.*)$/);
    if (!mm) continue;
    const n = Number(mm[1]);
    const ip = mm[2].match(/(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+:[0-9a-f:]+)/i)?.[1] || null;
    const ms = mm[2].match(/([\d.]+)\s*ms/)?.[1];
    const existing = hops.find((h) => h.hop === n);
    if (existing) { if (!existing.ip && ip) Object.assign(existing, { ip, ms: ms ? Number(ms) : null, timeout: false }); continue; }
    hops.push({ hop: n, ip, ms: ms ? Number(ms) : null, timeout: !ip || /\*|no reply/.test(mm[2]) && !ms });
  }
  return { target: t, tool, hops, reached: hops.some((h) => h.ip && r.stdout.includes(`(${h.ip})`)) || hops.at(-1)?.ip != null };
}

async function dnsLookup({ name, type = 'A', server }) {
  const t = String(type).toUpperCase();
  if (!['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'].includes(t)) throw new Error('Unsupported record type');
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  if (server) resolver.setServers([host(server)]);
  const t0 = performance.now();
  try {
    const records = await resolver.resolve(host(name), t);
    return { name, type: t, ms: round(performance.now() - t0, 1), records, servers: resolver.getServers() };
  } catch (e) {
    return { name, type: t, ms: round(performance.now() - t0, 1), records: [], error: e.code || e.message, servers: resolver.getServers() };
  }
}

function tcp({ host: h, port, timeout = 4000 }) {
  const p = intIn(port, 1, 65535, 'port');
  const target = host(h);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = net.connect({ host: target, port: p });
    let banner = '';
    let opened = null;
    const done = (r) => { s.destroy(); resolve({ host: target, port: p, ...r }); };
    s.setTimeout(Math.min(15_000, Number(timeout) || 4000), () => done(opened != null ? { open: true, ms: opened, banner: banner || null } : { open: false, error: 'timed out' }));
    s.on('connect', () => {
      opened = round(performance.now() - t0, 1);
      // services that talk first (SSH, SMTP, MySQL…) send a banner; wait briefly for it
      setTimeout(() => done({ open: true, ms: opened, banner: banner.split('\n')[0].replace(/[^\x20-\x7e]/g, '').slice(0, 120) || null }), 600);
    });
    s.on('data', (d) => { banner += d.toString('latin1'); });
    s.on('error', (e) => done(opened != null ? { open: true, ms: opened } : { open: false, error: e.code || e.message }));
  });
}

async function httpCheck({ url, timeout = 10_000 }) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Bad URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https');
  host(u.hostname.replace(/^\[|\]$/g, ''));
  const t0 = performance.now();
  try {
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(30_000, Number(timeout) || 10_000)), headers: { 'user-agent': `kapil-agent/${VERSION}` } });
    const ttfb = round(performance.now() - t0, 1);
    await r.arrayBuffer().catch(() => null);
    return { url: u.href, status: r.status, ok: r.status < 400, ms: ttfb, totalMs: round(performance.now() - t0, 1), server: r.headers.get('server'), location: r.headers.get('location') };
  } catch (e) {
    return { url: u.href, ok: false, error: e.cause?.code || e.message, ms: round(performance.now() - t0, 1) };
  }
}

// Internet speed of THIS node, measured against Cloudflare's speed test service (same method as the panel's own test)
const CF = 'https://speed.cloudflare.com';
const CFH = { 'user-agent': `kapil-agent/${VERSION}`, referer: `${CF}/` };
async function speedtest({ seconds = 8 } = {}) {
  const phase = intIn(seconds, 3, 15, 'seconds') * 1000;
  const lat = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    const r = await fetch(`${CF}/__down?bytes=0`, { headers: CFH, cache: 'no-store' });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`Cloudflare answered ${r.status}`);
    if (i) lat.push(performance.now() - t0);
  }
  const sorted = [...lat].sort((a, b) => a - b);
  let trace = {};
  try { trace = Object.fromEntries((await (await fetch(`${CF}/cdn-cgi/trace`, { headers: CFH })).text()).split('\n').filter(Boolean).map((l) => l.split('='))); } catch { /* optional */ }
  const random = crypto.randomBytes(1024 * 1024);
  async function measure(worker) {
    const ctl = new AbortController();
    let total = 0;
    let base = null;
    const start = performance.now();
    const warm = setTimeout(() => { base = { t: performance.now(), b: total }; }, 1000);
    const stop = setTimeout(() => ctl.abort(), phase);
    await Promise.all(Array.from({ length: 4 }, async () => {
      let errors = 0;
      while (!ctl.signal.aborted) { try { await worker((n) => { total += n; }, ctl.signal); } catch { if (ctl.signal.aborted || ++errors > 3) break; } }
    }));
    clearTimeout(warm); clearTimeout(stop);
    const from = base || { t: start, b: 0 };
    if (!total) throw new Error('No data transferred');
    return { mbps: round(((total - from.b) * 8) / ((performance.now() - from.t) / 1000) / 1e6), bytes: total };
  }
  const down = await measure(async (count, signal) => {
    const r = await fetch(`${CF}/__down?bytes=25000000`, { headers: CFH, signal, cache: 'no-store' });
    for await (const c of r.body) count(c.length);
  });
  const up = await measure(async (count, signal) => {
    let sent = 0;
    const body = new ReadableStream({ pull(c) { if (sent >= 25e6) return c.close(); const n = 65536; c.enqueue(random.subarray(sent % random.length, (sent % random.length) + n)); sent += n; count(n); return undefined; } });
    const r = await fetch(`${CF}/__up`, { method: 'POST', headers: { ...CFH, 'content-type': 'application/octet-stream' }, body, duplex: 'half', signal });
    await r.arrayBuffer();
  });
  const loss = await ping({ target: '1.1.1.1', count: 10 }).catch(() => null);
  return {
    provider: 'Cloudflare speed test', server: trace.colo ? `Cloudflare ${trace.colo}` : 'Cloudflare', location: trace.loc || null, publicIp: trace.ip || null,
    latency: round(sorted[Math.floor(sorted.length / 2)], 1), jitter: round(jitterOf(lat), 1), download: down.mbps, upload: up.mbps,
    packetLoss: loss ? loss.loss : null, at: Date.now(),
  };
}

let config = null;
const manage = (what) => { if (!config?.manage?.[what]) throw new Error(`Managing ${what} is not enabled on this node (set "manage": { "${what}": true } in ${CONFIG} and restart the agent)`); };
const PM2_ACTIONS = ['start', 'stop', 'restart', 'reload', 'delete', 'flush'];
const DOCKER_ACTIONS = ['start', 'stop', 'restart'];
const idOrName = (v) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(v))) throw new Error('Bad id'); return String(v); };
function tail(file, lines) {
  try {
    const st = fs.statSync(file); const len = Math.min(st.size, 512 * 1024); const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    return b.toString().split('\n').slice(-lines - 1).join('\n');
  } catch { return ''; }
}

const OPS = {
  facts: () => facts(),
  ping, traceroute, dns: dnsLookup, tcp, http: httpCheck, speedtest,
  'pm2.list': () => pm2List().then((x) => (x.processes ? { ...x, processes: x.processes.map(({ outLog, errLog, ...p }) => p) } : x)),
  'pm2.action': async ({ id, action }) => {
    manage('pm2');
    if (!PM2_ACTIONS.includes(action)) throw new Error('Bad action');
    const r = await pm2([action, idOrName(id)], 60_000);
    if (!r.ok) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 300) || `pm2 ${action} failed`);
    return { ok: true };
  },
  'pm2.save': async () => { manage('pm2'); const r = await pm2(['save']); if (!r.ok) throw new Error('pm2 save failed'); return { ok: true }; },
  'pm2.logs': async ({ id, lines = 200 }) => {
    const l = intIn(lines, 10, 2000, 'lines');
    const r = await pm2List();
    const p = r.processes?.find((x) => String(x.id) === String(id) || x.name === id);
    if (!p) throw new Error('No such PM2 process');
    return { out: p.outLog ? tail(p.outLog, l) : '', err: p.errLog ? tail(p.errLog, l) : '' };
  },
  'docker.list': () => dockerList(),
  'docker.action': async ({ id, action }) => {
    manage('docker');
    if (!DOCKER_ACTIONS.includes(action)) throw new Error('Bad action');
    await docker('POST', `/containers/${idOrName(id)}/${action}`, { timeout: 60_000 });
    return { ok: true };
  },
  'docker.logs': async ({ id, tail: t = 300 }) => {
    const buf = await docker('GET', `/containers/${idOrName(id)}/logs`, { query: { stdout: true, stderr: true, tail: intIn(t, 10, 5000, 'tail'), timestamps: true }, raw: true });
    return { logs: demux(buf) };
  },
};

// ============================== connection ==============================
function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!c.master || !c.nodeId || !c.key) throw new Error(`${CONFIG} is missing master/nodeId/key. Enroll first.`);
  return c;
}

function connect() {
  const url = `${config.master.replace(/^http/, 'ws').replace(/\/+$/, '')}/agent/v1/connect`;
  let ws;
  let timer = null;
  let attempt = 0;
  let interval = 15_000;
  const schedule = () => {
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 1000);
    attempt += 1;
    setTimeout(open, wait);
  };
  const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };
  async function heartbeat() {
    try { send({ type: 'heartbeat', facts: await facts() }); } catch (e) { log('heartbeat failed:', e.message); }
    timer = setTimeout(heartbeat, interval);
  }
  function open() {
    try { ws = new WebSocket(url); } catch (e) { log('connect failed:', e.message); schedule(); return; }
    ws.addEventListener('open', () => send({ type: 'auth', nodeId: config.nodeId, key: config.key, version: VERSION }));
    ws.addEventListener('message', async (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.type === 'welcome') {
        attempt = 0;
        interval = Math.max(5, Number(m.heartbeatSeconds) || 15) * 1000;
        log(`connected to ${config.master} as node ${config.nodeId}`);
        clearTimeout(timer);
        heartbeat();
      } else if (m.type === 'call') {
        const fn = OPS[m.op];
        try {
          if (!fn) throw new Error(`Unknown operation ${m.op}`);
          send({ type: 'result', id: m.id, ok: true, data: await fn(m.args || {}) });
        } catch (e) {
          send({ type: 'result', id: m.id, ok: false, error: e.message });
        }
      } else if (m.type === 'refused') {
        log('control plane refused this agent:', m.reason);
      }
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      log(`disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}); reconnecting`);
      schedule();
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }
  open();
}

async function enroll() {
  const master = flag('master');
  const token = flag('token');
  if (!master || !token) throw new Error('Usage: kapil-agent.js enroll --master https://panel.example.com --token <token>');
  const f = await facts();
  const r = await fetch(`${master.replace(/\/+$/, '')}/agent/v1/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, version: VERSION, facts: { system: f.system, cpu: f.cpu, memory: { total: f.memory.total } } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Enrollment failed (${r.status})`);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* new */ }
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  const cfg = { manage: { pm2: false, docker: false }, ...existing, master, nodeId: data.nodeId, key: data.key };
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  console.log(`Enrolled as node ${data.nodeId} (${data.name}). Config written to ${CONFIG}.`);
}

(async () => {
  const cmd = argv[0] || 'run';
  try {
    if (cmd === 'enroll') await enroll();
    else if (cmd === 'facts') console.log(JSON.stringify(await (async () => { await facts(); await new Promise((r) => setTimeout(r, 1000)); return facts(); })(), null, 2));
    else if (cmd === 'version') console.log(VERSION);
    else if (cmd === 'run') { config = loadConfig(); connect(); }
    else throw new Error(`Unknown command ${cmd}. Use enroll, run, facts or version.`);
  } catch (e) {
    console.error(`kapil-agent: ${e.message}`);
    process.exit(1);
  }
})();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
