// Network page (admin only): ping / latency, the server's own internet speed (against Cloudflare's speed test
// servers) and endpoints the browser uses to measure its own connection to the panel.
import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { audit } from './db.js';
import { clientIp } from './auth.js';

const CF = 'https://speed.cloudflare.com';
const CF_HEADERS = { 'user-agent': 'vps-panel-speedtest', referer: `${CF}/` };
const PHASE_MS = 8000; // how long download and upload each run
const WARMUP_MS = 1000; // ignored at the start of each phase (TCP slow start)
const STREAMS = 4; // parallel connections, so one TCP stream is not the limit
const DOWN_CHUNK = 25_000_000;
const UP_CHUNK = 25_000_000;
const PROGRESS_MS = 500;
const HISTORY = 20;
const MAX_BROWSER_BYTES = 100 * 1024 * 1024;

export const DEFAULT_TARGETS = ['1.1.1.1', '8.8.8.8', 'google.com', 'github.com', 'speed.cloudflare.com'];
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const validHost = (h) => typeof h === 'string' && (net.isIP(h) !== 0 || HOST_RE.test(h));

const RANDOM = crypto.randomBytes(1024 * 1024); // random so nothing on the way can compress it
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const mbps = (bytes, ms) => (ms > 0 ? round((bytes * 8) / (ms / 1000) / 1e6, 1) : 0);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
// Average change between consecutive samples
const jitter = (a) => (a.length > 1 ? a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1) : 0);

// ---------- ping ----------
function parsePing(out) {
  const times = [...out.matchAll(/time[=<]([\d.]+) ms/g)].map((m) => Number(m[1]));
  const sum = out.match(/(\d+) packets transmitted, (\d+) (?:packets )?received/);
  const ip = out.match(/^PING \S+ \(([^)]+)\)/m)?.[1] || null;
  const sent = sum ? Number(sum[1]) : times.length;
  const received = sum ? Number(sum[2]) : times.length;
  return {
    ip,
    sent,
    received,
    loss: sent ? round(((sent - received) / sent) * 100) : 100,
    min: times.length ? round(Math.min(...times), 2) : null,
    avg: times.length ? round(times.reduce((s, v) => s + v, 0) / times.length, 2) : null,
    max: times.length ? round(Math.max(...times), 2) : null,
    jitter: times.length ? round(jitter(times), 2) : null,
    times,
  };
}

function ping(host, count) {
  // Argument array, never a shell. -i 0.2 is the fastest interval ping allows without root.
  const args = ['-n', '-c', String(count), '-i', '0.2', '-W', '2', '-w', String(count + 3), '--', host];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: (count + 6) * 1000 }, (err, stdout, stderr) => {
      const r = { host, at: Date.now(), ...parsePing(stdout || '') };
      if (err && !r.received) {
        const msg = (stderr || '').trim().split('\n').pop().replace(/^ping: /, '');
        r.error = err.code === 'ENOENT' ? 'ping is not installed (sudo apt install iputils-ping)'
          : msg || (err.killed ? 'Timed out' : 'No reply');
      }
      resolve(r);
    });
  });
}

// ---------- server speed test (Cloudflare) ----------
async function cfLatency(signal, n = 12) {
  const times = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const r = await fetch(`${CF}/__down?bytes=0`, { headers: CF_HEADERS, signal, cache: 'no-store' });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`Cloudflare answered ${r.status}`);
    if (i > 0) times.push(performance.now() - t0); // first one includes the TLS handshake
  }
  return { latency: round(median(times), 1), jitter: round(jitter(times), 1) };
}

async function cfTrace(signal) {
  try {
    const r = await fetch(`${CF}/cdn-cgi/trace`, { headers: CF_HEADERS, signal });
    const kv = Object.fromEntries((await r.text()).split('\n').filter(Boolean).map((l) => l.split('=')));
    return { colo: kv.colo || null, loc: kv.loc || null, ip: kv.ip || null };
  } catch {
    return { colo: null, loc: null, ip: null };
  }
}

// Runs `worker(count, signal)` on STREAMS connections for PHASE_MS and reports the speed every PROGRESS_MS.
// The speed counts only bytes after the warm-up.
async function measure(worker, onSpeed, outer) {
  const ctl = new AbortController();
  const stopOuter = () => ctl.abort();
  outer.addEventListener('abort', stopOuter);
  let total = 0;
  const count = (n) => { total += n; };
  const start = performance.now();
  let base = null;
  let last = { t: start, b: 0 };
  const errors = [];
  const tick = setInterval(() => {
    const now = performance.now();
    if (base == null && now - start >= WARMUP_MS) base = { t: now, b: total };
    onSpeed(mbps(total - last.b, now - last.t), Math.min(1, (now - start) / PHASE_MS));
    last = { t: now, b: total };
  }, PROGRESS_MS);
  const stop = setTimeout(() => ctl.abort(), PHASE_MS);
  await Promise.all(Array.from({ length: STREAMS }, async () => {
    while (!ctl.signal.aborted) {
      try {
        await worker(count, ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted) break;
        errors.push(e);
        if (errors.length > STREAMS * 2) { ctl.abort(); break; }
      }
    }
  }));
  clearInterval(tick);
  clearTimeout(stop);
  outer.removeEventListener('abort', stopOuter);
  if (outer.aborted) throw new Error('Cancelled');
  const end = performance.now();
  const from = base || { t: start, b: 0 };
  if (total === 0) throw new Error(errors[0]?.message || 'No data transferred');
  return { mbps: mbps(total - from.b, end - from.t), bytes: total };
}

async function downloadOnce(count, signal) {
  const r = await fetch(`${CF}/__down?bytes=${DOWN_CHUNK}`, { headers: CF_HEADERS, signal, cache: 'no-store' });
  if (!r.ok) throw new Error(`Download failed: Cloudflare answered ${r.status}`);
  for await (const chunk of r.body) count(chunk.length);
}

async function uploadOnce(count, signal) {
  let sent = 0;
  // Bytes are counted as the socket pulls them, so progress is live instead of per request
  const body = new ReadableStream({
    pull(c) {
      if (sent >= UP_CHUNK) return c.close();
      const n = Math.min(64 * 1024, UP_CHUNK - sent);
      c.enqueue(RANDOM.subarray(sent % RANDOM.length, (sent % RANDOM.length) + n));
      sent += n;
      count(n);
      return undefined;
    },
  });
  const r = await fetch(`${CF}/__up`, {
    method: 'POST', headers: { ...CF_HEADERS, 'content-type': 'application/octet-stream' }, body, duplex: 'half', signal,
  });
  await r.arrayBuffer();
  if (!r.ok) throw new Error(`Upload failed: Cloudflare answered ${r.status}`);
}

export function createNetwork({ io }) {
  const router = express.Router();
  const history = []; // finished server speed tests, newest first
  let job = null;
  let abort = null;
  const emit = () => io.to('admin').emit('net:speed', { job, history });

  async function runSpeedTest(by, ip) {
    abort = new AbortController();
    const { signal } = abort;
    job = { status: 'running', phase: 'latency', progress: 0, by, startedAt: Date.now(), latency: null, jitter: null, download: null, upload: null, live: null };
    emit();
    audit.log({ username: by, ip, action: 'speedtest', result: 'requested' });
    try {
      Object.assign(job, await cfTrace(signal), await cfLatency(signal));
      job.phase = 'download';
      emit();
      const down = await measure(downloadOnce, (live, progress) => { Object.assign(job, { live, progress }); emit(); }, signal);
      Object.assign(job, { download: down.mbps, downBytes: down.bytes, phase: 'upload', live: null, progress: 0 });
      emit();
      const up = await measure(uploadOnce, (live, progress) => { Object.assign(job, { live, progress }); emit(); }, signal);
      Object.assign(job, { upload: up.mbps, upBytes: up.bytes, status: 'success', phase: 'done', live: null, progress: 1 });
      audit.log({ username: by, ip, action: 'speedtest', result: 'success', detail: `down ${job.download} Mbps, up ${job.upload} Mbps, ping ${job.latency} ms` });
    } catch (e) {
      Object.assign(job, { status: 'failed', error: e.message, live: null });
      audit.log({ username: by, ip, action: 'speedtest', result: 'failure', detail: e.message });
    }
    job.finishedAt = Date.now();
    history.unshift({ ...job });
    history.length = Math.min(history.length, HISTORY);
    abort = null;
    emit();
  }

  router.get('/state', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ targets: DEFAULT_TARGETS, job, history });
  });

  router.post('/ping', async (req, res) => {
    const host = typeof req.body?.host === 'string' ? req.body.host.trim() : '';
    const count = Math.min(20, Math.max(1, Math.floor(Number(req.body?.count) || 5)));
    if (!validHost(host)) return res.status(400).json({ error: 'Enter a hostname (like google.com) or an IP address' });
    return res.json(await ping(host, count));
  });

  router.post('/speedtest', (req, res) => {
    if (job?.status === 'running') return res.status(409).json({ error: 'A speed test is already running' });
    runSpeedTest(req.session.username, clientIp(req));
    return res.status(202).json({ job });
  });

  router.post('/speedtest/cancel', (_req, res) => {
    if (!abort) return res.status(409).json({ error: 'No speed test is running' });
    abort.abort();
    return res.json({ ok: true });
  });

  // ---------- browser <-> panel test ----------
  router.get('/echo', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ t: Date.now() });
  });

  router.get('/download', (req, res) => {
    const total = Math.min(MAX_BROWSER_BYTES, Math.max(1, Math.floor(Number(req.query.bytes) || 0)));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(total), 'Cache-Control': 'no-store', 'Content-Encoding': 'identity' });
    let sent = 0;
    const pump = () => {
      while (sent < total && !res.destroyed) {
        const n = Math.min(RANDOM.length, total - sent);
        sent += n;
        if (!res.write(n === RANDOM.length ? RANDOM : RANDOM.subarray(0, n))) return void res.once('drain', pump);
      }
      if (!res.destroyed) res.end();
    };
    pump();
  });

  router.post('/upload', (req, res) => {
    let got = 0;
    req.on('data', (c) => {
      got += c.length;
      if (got > MAX_BROWSER_BYTES) {
        res.status(413).json({ error: 'Too much data' });
        req.destroy();
      }
    });
    req.on('end', () => { if (!res.headersSent) res.json({ bytes: got }); });
  });

  return { router, state: () => ({ job, history }) };
}
