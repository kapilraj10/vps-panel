// Fleet (NodeService + agent hub + uptime): registered VPS nodes, their agents, live facts, metric history, incidents.
//
// Status is never taken from the database record alone. It is derived every few seconds from:
//   * the agent's heartbeat (fresh = within node_offline_seconds)  -> online / degraded
//   * a TCP probe of the node's SSH port from the control plane    -> reachable or not
//   maintenance            set by an admin; incidents are not counted
//   online / degraded      heartbeat is fresh (degraded = RAM or a disk >= 95 %, or load per core >= 2)
//   agent_disconnected     agent enrolled but silent; SSH port still answers
//   offline                agent enrolled but silent; SSH port does not answer (or no IP to probe)
//   no_agent               no agent yet; SSH port answers
//   unreachable            no agent; SSH port does not answer
//   pending                nothing known yet
// Down states open an incident (node_incidents) and raise an alert; recovery closes both.
import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { db, audit, settings } from './db.js';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { wrap, bad, notFound, conflict, int, str, HttpError } from './http.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/;
const TEXT_RE = /^[^\u0000-\u001f<>]{0,80}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const DOWN = new Set(['offline', 'unreachable']);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Test hooks (defaults are the production values)
const BUCKET_MS = Number(process.env.NODE_METRIC_BUCKET_MS) || 60_000;
const PROBE_MS = Number(process.env.NODE_PROBE_MS) || 20_000;
const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3 };

export const nodesDb = {
  all: () => db.prepare('SELECT * FROM nodes ORDER BY is_primary DESC, name').all(),
  get: (id) => db.prepare('SELECT * FROM nodes WHERE id = ?').get(id),
  byUid: (uid) => db.prepare('SELECT * FROM nodes WHERE uid = ?').get(uid),
};

function probeTcp(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve({ ok, ms: Date.now() - t0 }); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

const validHost = (v) => typeof v === 'string' && (net.isIP(v) !== 0 || HOST_RE.test(v));

export function createNodes({ io, monitoring }) {
  const router = express.Router();
  const publicRouter = express.Router();
  const live = new Map(); // nodeId -> { ws, facts, factsAt, connectedAt, ip, calls: Map, version }
  const probes = new Map(); // nodeId -> { ok, ms, at }
  const acc = new Map(); // nodeId -> per-minute accumulator

  const emit = (n) => io.to('admin').emit('node', view(n));
  const offlineMs = () => Number(settings.get('node_offline_seconds') || 45) * 1000;

  // ---------- views ----------
  function uptime(n, rangeMs) {
    const now = Date.now();
    const from = Math.max(now - rangeMs, n.first_seen_at || now);
    if (now - from < 1000) return null;
    const rows = db.prepare("SELECT started_at, ended_at FROM node_incidents WHERE node_id = ? AND kind IN ('offline', 'unreachable') AND (ended_at IS NULL OR ended_at > ?)").all(n.id, from);
    let down = 0;
    for (const r of rows) down += Math.max(0, Math.min(r.ended_at || now, now) - Math.max(r.started_at, from));
    return Math.round((1 - down / (now - from)) * 100000) / 1000;
  }
  function summary(f) {
    if (!f) return null;
    const root = f.disks?.find((d) => d.mount === '/') || f.disks?.[0];
    return {
      at: f.at, cpu: f.cpu?.usage ?? null, cores: f.cpu?.cores, load: f.cpu?.load, memUsed: f.memory?.used, memTotal: f.memory?.total,
      swapUsed: f.memory?.swapUsed, swapTotal: f.memory?.swapTotal, diskUsed: root?.used, diskTotal: root?.total,
      diskMaxPct: f.disks?.length ? Math.max(...f.disks.map((d) => (d.total ? (d.used / d.total) * 100 : 0))) : null,
      rx: f.network?.rx, tx: f.network?.tx, connections: f.network?.established, uptime: f.system?.uptime,
      pm2: f.pm2?.available ? { total: f.pm2.processes.length, online: f.pm2.processes.filter((p) => p.status === 'online').length } : null,
      docker: f.docker?.available ? { total: f.docker.containers.length, running: f.docker.containers.filter((c) => c.state === 'running').length } : null,
    };
  }
  function view(n) {
    const l = live.get(n.id);
    const { agent_key_hash, enroll_hash, ssh_key_enc, ...rest } = n;
    return {
      ...rest, hasAgent: !!agent_key_hash, hasOwnSshKey: !!ssh_key_enc, agentConnected: !!l, connectedAt: l?.connectedAt || null,
      enrollPending: !!enroll_hash && n.enroll_expires_at > Date.now(), probe: probes.get(n.id) || null, live: summary(l?.facts),
      uptime24h: uptime(n, RANGES['24h']), uptime7d: uptime(n, RANGES['7d']), uptime30d: uptime(n, RANGES['30d']),
      openIncident: db.prepare('SELECT * FROM node_incidents WHERE node_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(n.id) || null,
    };
  }

  // ---------- status ----------
  function derive(n) {
    if (n.maintenance) return 'maintenance';
    const l = live.get(n.id);
    const fresh = n.last_heartbeat_at && Date.now() - n.last_heartbeat_at < offlineMs();
    if (l && fresh) {
      const s = summary(l.facts);
      const degraded = s && ((s.memTotal && s.memUsed / s.memTotal >= 0.95) || s.diskMaxPct >= 95 || (s.cores && s.load?.[0] / s.cores >= 2));
      return degraded ? 'degraded' : 'online';
    }
    const p = probes.get(n.id);
    if (n.agent_key_hash) return p?.ok ? 'agent_disconnected' : (p || !n.public_ip ? 'offline' : n.status);
    if (!p) return 'pending';
    return p.ok ? 'no_agent' : 'unreachable';
  }
  function setStatus(n, status) {
    if (n.status === status) return;
    const now = Date.now();
    db.transaction(() => {
      db.prepare('UPDATE nodes SET status = ?, status_since = ? WHERE id = ?').run(status, now, n.id);
      const open = db.prepare('SELECT * FROM node_incidents WHERE node_id = ? AND ended_at IS NULL').get(n.id);
      const incidentKind = DOWN.has(status) ? status : status === 'agent_disconnected' ? 'agent_disconnected' : null;
      if (open && open.kind !== incidentKind) db.prepare('UPDATE node_incidents SET ended_at = ? WHERE id = ?').run(now, open.id);
      // only after the node has been seen once (a never-installed node is not "down")
      if (incidentKind && (!open || open.kind !== incidentKind) && n.first_seen_at) {
        db.prepare('INSERT INTO node_incidents (node_id, kind, started_at, detail) VALUES (?, ?, ?, ?)').run(n.id, incidentKind, now, `was ${n.status}`);
      }
    })();
    const target = `node:${n.id}`;
    if (DOWN.has(status) && n.first_seen_at) monitoring.raise('node_offline', target, 'critical', `${n.name} is ${status === 'offline' ? 'offline (no heartbeat, SSH port not answering)' : 'unreachable'}`);
    else monitoring.clear('node_offline', target);
    if (status === 'agent_disconnected') monitoring.raise('node_agent', target, 'warning', `${n.name}: agent disconnected (server still answers on SSH)`);
    else monitoring.clear('node_agent', target);
    if (status === 'degraded') monitoring.raise('node_degraded', target, 'warning', `${n.name} is degraded (RAM, disk or load very high)`);
    else monitoring.clear('node_degraded', target);
    audit.log({ username: 'system', action: 'node_status', target: n.name, result: status, detail: `was ${n.status}` });
    emit(nodesDb.get(n.id));
  }
  let probing = false;
  async function statusLoop() {
    if (probing) return;
    probing = true;
    try {
      const now = Date.now();
      await Promise.all(nodesDb.all().map(async (n) => {
        const l = live.get(n.id);
        const fresh = l && n.last_heartbeat_at && now - n.last_heartbeat_at < offlineMs();
        const p = probes.get(n.id);
        // probe when there is no fresh heartbeat, at most every 20 s per node
        if (!fresh && !n.maintenance && n.public_ip && (!p || now - p.at > PROBE_MS)) {
          probes.set(n.id, { ...(await probeTcp(n.public_ip, n.ssh_port)), at: Date.now() });
        }
        setStatus(n, derive(nodesDb.get(n.id)));
      }));
    } finally {
      probing = false;
    }
  }

  // ---------- metrics: per-minute averages, hourly roll-up, retention ----------
  function record(nodeId, f) {
    const s = summary(f);
    if (!s || s.cpu == null) return;
    const minute = Math.floor(f.at / BUCKET_MS) * BUCKET_MS;
    let a = acc.get(nodeId);
    if (a && a.ts !== minute) { flushMinute(nodeId, a); a = null; }
    if (!a) a = { ts: minute, n: 0, cpu: 0, load1: 0, mem_used: 0, swap_used: 0, disk_used: 0, rx: 0, tx: 0, io_read: 0, io_write: 0, connections: 0 };
    a.n += 1;
    a.cpu += s.cpu; a.load1 += s.load?.[0] || 0; a.mem_used += s.memUsed || 0; a.swap_used += s.swapUsed || 0; a.disk_used += s.diskUsed || 0;
    a.rx += s.rx || 0; a.tx += s.tx || 0; a.io_read += f.diskIo?.read || 0; a.io_write += f.diskIo?.write || 0; a.connections += s.connections || 0;
    Object.assign(a, { mem_total: s.memTotal, swap_total: s.swapTotal, disk_total: s.diskTotal });
    acc.set(nodeId, a);
  }
  function flushMinute(nodeId, a) {
    const avg = (k) => a[k] / a.n;
    db.prepare(`INSERT OR REPLACE INTO node_metrics (node_id, ts, samples, cpu, load1, mem_used, mem_total, swap_used, swap_total, disk_used, disk_total, rx, tx, io_read, io_write, connections)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nodeId, a.ts, a.n, Math.round(avg('cpu') * 10) / 10, Math.round(avg('load1') * 100) / 100,
      Math.round(avg('mem_used')), a.mem_total, Math.round(avg('swap_used')), a.swap_total, Math.round(avg('disk_used')), a.disk_total,
      Math.round(avg('rx')), Math.round(avg('tx')), Math.round(avg('io_read')), Math.round(avg('io_write')), Math.round(avg('connections')));
  }
  function rollup() {
    const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
    // completed hours that have minute rows
    db.prepare(`INSERT OR REPLACE INTO node_metrics_hourly (node_id, ts, samples, cpu, cpu_max, load1, mem_used, mem_total, swap_used, swap_total, disk_used, disk_total, rx, tx, io_read, io_write, connections)
      SELECT node_id, (ts / 3600000) * 3600000 AS h, SUM(samples), ROUND(AVG(cpu), 1), MAX(cpu), ROUND(AVG(load1), 2), CAST(AVG(mem_used) AS INTEGER), MAX(mem_total),
        CAST(AVG(swap_used) AS INTEGER), MAX(swap_total), CAST(AVG(disk_used) AS INTEGER), MAX(disk_total), CAST(AVG(rx) AS INTEGER), CAST(AVG(tx) AS INTEGER),
        CAST(AVG(io_read) AS INTEGER), CAST(AVG(io_write) AS INTEGER), CAST(AVG(connections) AS INTEGER)
      FROM node_metrics WHERE ts >= ? AND ts < ? GROUP BY node_id, h`).run(hour - 3 * 3600e3, hour);
    db.prepare('DELETE FROM node_metrics WHERE ts < ?').run(Date.now() - Number(settings.get('node_metrics_minute_hours') || 48) * 3600e3);
    db.prepare('DELETE FROM node_metrics_hourly WHERE ts < ?').run(Date.now() - Number(settings.get('node_metrics_hourly_days') || 90) * 86400e3);
    db.prepare('DELETE FROM network_tests WHERE started_at < ?').run(Date.now() - Number(settings.get('net_tests_keep_days') || 30) * 86400e3);
  }
  function history(nodeId, rangeMs) {
    const since = Date.now() - rangeMs;
    const minuteKeep = Number(settings.get('node_metrics_minute_hours') || 48) * 3600e3;
    if (rangeMs <= Math.min(minuteKeep, 48 * 3600e3)) {
      const rows = db.prepare('SELECT * FROM node_metrics WHERE node_id = ? AND ts >= ? ORDER BY ts').all(nodeId, since);
      const step = Math.max(1, Math.ceil(rows.length / 360));
      if (step === 1) return rows;
      const out = [];
      for (let i = 0; i < rows.length; i += step) {
        const g = rows.slice(i, i + step);
        const m = (k) => g.reduce((s, r) => s + (r[k] || 0), 0) / g.length;
        out.push({ ...g[0], cpu: Math.round(m('cpu') * 10) / 10, load1: m('load1'), mem_used: m('mem_used'), swap_used: m('swap_used'), disk_used: m('disk_used'), rx: m('rx'), tx: m('tx'), io_read: m('io_read'), io_write: m('io_write'), connections: m('connections') });
      }
      return out;
    }
    return db.prepare('SELECT * FROM node_metrics_hourly WHERE node_id = ? AND ts >= ? ORDER BY ts').all(nodeId, since);
  }

  // Threshold alerts per node (same settings as the main host: alert_cpu / alert_memory / alert_disk)
  const over = new Map();
  function thresholds(n, f) {
    const s = summary(f);
    if (!s) return;
    const check = (kind, value, limit, msg) => {
      const key = `${kind}:${n.id}`;
      if (value != null && value >= limit) {
        const k = (over.get(key) || 0) + 1;
        over.set(key, k);
        const needed = Math.ceil((Number(settings.get('alert_sustain_minutes') || 5) * 60) / Number(settings.get('node_heartbeat_seconds') || 15));
        if (k >= needed) monitoring.raise(kind, `node:${n.id}`, value >= Math.min(99, limit + 7) ? 'critical' : 'warning', msg);
      } else if (over.has(key) || value != null) {
        over.delete(key);
        monitoring.clear(kind, `node:${n.id}`);
      }
    };
    check('node_cpu', s.cpu, Number(settings.get('alert_cpu')), `${n.name}: CPU at ${s.cpu}%`);
    check('node_memory', s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : null, Number(settings.get('alert_memory')), `${n.name}: RAM at ${s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : '?'}%`);
    check('node_disk', s.diskMaxPct != null ? Math.round(s.diskMaxPct) : null, Number(settings.get('alert_disk')), `${n.name}: a disk is ${Math.round(s.diskMaxPct || 0)}% full`);
    for (const p of f.pm2?.processes || []) {
      if (['errored', 'stopped'].includes(p.status)) monitoring.raise('pm2_down', `node:${n.id}:pm2:${p.name}`, p.status === 'errored' ? 'critical' : 'warning', `${n.name}: PM2 app ${p.name} is ${p.status}`);
      else monitoring.clear('pm2_down', `node:${n.id}:pm2:${p.name}`);
    }
  }

  // ---------- agent connections ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  function handleUpgrade(req, socket, head) {
    if (!req.url.startsWith('/agent/v1/connect')) return false;
    wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, req));
    return true;
  }
  function onAgent(ws, req) {
    const ip = (typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip'].slice(0, 64)) || req.socket.remoteAddress;
    let node = null;
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return ws.close(4002, 'bad frame'); }
      if (!node) {
        if (m.type !== 'auth') return ws.close(4001, 'auth first');
        const n = typeof m.nodeId === 'string' ? nodesDb.byUid(m.nodeId) : null;
        const ok = n?.agent_key_hash && typeof m.key === 'string' && m.key.length < 200
          && crypto.timingSafeEqual(Buffer.from(sha(m.key)), Buffer.from(n.agent_key_hash));
        if (!ok) {
          audit.log({ username: 'agent', ip, action: 'agent_connect', target: n?.name || String(m.nodeId).slice(0, 40), result: 'failure', detail: 'bad credentials' });
          ws.send(JSON.stringify({ type: 'refused', reason: 'unknown node or wrong key' }));
          return ws.close(4003, 'refused');
        }
        if (!n.agent_enabled) {
          ws.send(JSON.stringify({ type: 'refused', reason: 'agent disconnected by an admin' }));
          return ws.close(4004, 'disabled');
        }
        clearTimeout(authTimer);
        live.get(n.id)?.ws.close(4005, 'replaced by a newer connection');
        node = n;
        live.set(n.id, { ws, facts: null, connectedAt: Date.now(), ip, calls: new Map(), version: String(m.version || '').slice(0, 20) });
        db.prepare('UPDATE nodes SET agent_version = ?, last_seen_ip = ?, first_seen_at = COALESCE(first_seen_at, ?) WHERE id = ?').run(String(m.version || '').slice(0, 20), ip, Date.now(), n.id);
        ws.send(JSON.stringify({ type: 'welcome', heartbeatSeconds: Number(settings.get('node_heartbeat_seconds') || 15) }));
        audit.log({ username: 'agent', ip, action: 'agent_connect', target: n.name, result: 'success', detail: `v${m.version}` });
        return undefined;
      }
      const l = live.get(node.id);
      if (!l || l.ws !== ws) return undefined;
      if (m.type === 'heartbeat' && m.facts && typeof m.facts === 'object') {
        const f = m.facts;
        l.facts = f;
        l.factsAt = Date.now();
        const sys = f.system || {};
        db.prepare(`UPDATE nodes SET last_heartbeat_at = ?, hostname = ?, os = ?, kernel = ?, arch = ?, cpu_model = ?, cores = ?, mem_total = ?, updated_at = updated_at WHERE id = ?`)
          .run(Date.now(), String(sys.hostname || '').slice(0, 100), String(sys.os?.pretty || '').slice(0, 100), String(sys.kernel || '').slice(0, 100),
            String(sys.arch || '').slice(0, 20), String(f.cpu?.model || '').slice(0, 120), Number(f.cpu?.cores) || null, Number(f.memory?.total) || null, node.id);
        record(node.id, f);
        const fresh = nodesDb.get(node.id);
        thresholds(fresh, f);
        setStatus(fresh, derive(fresh));
        io.to('admin').emit('node:facts', { id: node.id, facts: f, summary: summary(f) });
      } else if (m.type === 'result' && l.calls.has(m.id)) {
        const c = l.calls.get(m.id);
        l.calls.delete(m.id);
        clearTimeout(c.timer);
        if (m.ok) c.resolve(m.data); else c.reject(new HttpError(502, `${node.name}: ${m.error}`));
      }
      return undefined;
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!node) return;
      const l = live.get(node.id);
      if (l?.ws !== ws) return;
      for (const c of l.calls.values()) { clearTimeout(c.timer); c.reject(new HttpError(503, `${node.name}: agent disconnected`)); }
      live.delete(node.id);
      audit.log({ username: 'agent', ip, action: 'agent_disconnect', target: node.name, result: 'success' });
      emit(nodesDb.get(node.id) || node);
    });
    ws.on('error', () => {});
  }

  // Calls one whitelisted operation on a node's agent
  function call(nodeId, op, args = {}, timeout = 30_000) {
    const n = nodesDb.get(nodeId);
    if (!n) throw notFound('No such server');
    const l = live.get(n.id);
    if (!l) throw new HttpError(503, `${n.name}: agent is not connected`);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { l.calls.delete(id); reject(new HttpError(504, `${n.name}: no answer from the agent within ${Math.round(timeout / 1000)} s`)); }, timeout);
      l.calls.set(id, { resolve, reject, timer });
      l.ws.send(JSON.stringify({ type: 'call', id, op, args }));
    });
  }

  // ---------- validation ----------
  function fields(b, partial) {
    const out = {};
    const opt = (k, fn) => { if (b[k] !== undefined) out[k] = fn(b[k]); else if (!partial) out[k] = null; };
    if (!partial || b.name !== undefined) out.name = str(b.name, { max: 63, name: 'Name', re: NAME_RE });
    opt('provider', (v) => (v ? str(v, { max: 80, name: 'Provider', re: TEXT_RE }) : null));
    opt('location', (v) => (v ? str(v, { max: 80, name: 'Location', re: TEXT_RE }) : null));
    opt('netZone', (v) => (v ? str(v, { max: 40, name: 'Private network', re: /^[\w.-]+$/ }) : null));
    opt('notes', (v) => (v ? str(v, { max: 500, name: 'Notes', re: /^[^<>]*$/ }) : null));
    for (const k of ['publicIp', 'privateIp']) {
      opt(k, (v) => { if (!v) return null; if (!validHost(String(v).trim())) throw bad(`${k === 'publicIp' ? 'Public' : 'Private'} IP / hostname is not valid`); return String(v).trim(); });
    }
    if (b.sshPort !== undefined || !partial) out.sshPort = int(b.sshPort ?? 22, { min: 1, max: 65535, name: 'SSH port' });
    opt('sshUser', (v) => (v ? str(v, { max: 32, name: 'SSH user', re: USER_RE }) : null));
    return out;
  }
  const getNode = (id) => { const n = nodesDb.get(Number(id)); if (!n) throw notFound('No such server'); return n; };
  const who = (req) => req.session.username;
  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: who(req), ip: clientIp(req), action, target, result, detail });

  // ---------- routes (admin read, super admin write) ----------
  // admin guard only for this router's own paths (it is mounted at /api next to user routes)
  router.use(['/nodes', '/fleet'], requireAdmin);

  router.get('/nodes', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ nodes: nodesDb.all().map(view) });
  });

  router.get('/nodes/:id', (req, res) => {
    const n = getNode(req.params.id);
    res.set('Cache-Control', 'no-store');
    const l = live.get(n.id);
    res.json({ node: view(n), facts: l?.facts || null, factsAt: l?.factsAt || null });
  });

  router.get('/nodes/:id/metrics', (req, res) => {
    const n = getNode(req.params.id);
    const range = RANGES[req.query.range] ? req.query.range : '24h';
    res.set('Cache-Control', 'no-store');
    res.json({ range, points: history(n.id, RANGES[range]) });
  });

  router.get('/nodes/:id/incidents', (req, res) => {
    const n = getNode(req.params.id);
    res.json({ incidents: db.prepare('SELECT * FROM node_incidents WHERE node_id = ? ORDER BY id DESC LIMIT 200').all(n.id) });
  });

  router.get('/fleet/incidents', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ incidents: db.prepare('SELECT i.*, n.name AS node_name FROM node_incidents i JOIN nodes n ON n.id = i.node_id ORDER BY i.id DESC LIMIT 300').all() });
  });

  // Comparison: latest summary + history for several nodes
  router.get('/fleet/compare', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 12);
    const range = RANGES[req.query.range] ? req.query.range : '24h';
    const nodes = (ids.length ? ids.map((i) => nodesDb.get(i)).filter(Boolean) : nodesDb.all());
    res.set('Cache-Control', 'no-store');
    res.json({ range, nodes: nodes.map((n) => ({ ...view(n), history: history(n.id, RANGES[range]) })) });
  });

  router.post('/nodes', requireSuperAdmin, wrap(async (req, res) => {
    const f = fields(req.body || {}, false);
    if (db.prepare('SELECT 1 FROM nodes WHERE name = ?').get(f.name)) throw conflict(`A server named ${f.name} already exists`);
    const now = Date.now();
    const first = !db.prepare('SELECT 1 FROM nodes LIMIT 1').get();
    const id = db.prepare(`INSERT INTO nodes (uid, name, provider, location, net_zone, public_ip, private_ip, ssh_port, ssh_user, notes, is_primary, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), f.name, f.provider, f.location, f.netZone, f.publicIp, f.privateIp, f.sshPort, f.sshUser, f.notes, first ? 1 : 0, who(req), now, now).lastInsertRowid;
    log(req, 'node_create', f.name, `${f.publicIp || '-'}:${f.sshPort}${first ? ' (primary)' : ''}`);
    const n = nodesDb.get(id);
    emit(n);
    res.status(201).json({ node: view(n) });
  }));

  router.put('/nodes/:id', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    const f = fields(req.body || {}, true);
    if (f.name && f.name.toLowerCase() !== n.name.toLowerCase() && db.prepare('SELECT 1 FROM nodes WHERE name = ?').get(f.name)) throw conflict(`A server named ${f.name} already exists`);
    const map = { name: 'name', provider: 'provider', location: 'location', netZone: 'net_zone', publicIp: 'public_ip', privateIp: 'private_ip', sshPort: 'ssh_port', sshUser: 'ssh_user', notes: 'notes' };
    const keys = Object.keys(f).filter((k) => map[k]);
    db.transaction(() => { for (const k of keys) db.prepare(`UPDATE nodes SET ${map[k]} = ?, updated_at = ? WHERE id = ?`).run(f[k], Date.now(), n.id); })();
    // a new address or port = a different SSH endpoint: forget the pinned host key and the last probe
    if (keys.some((k) => ['publicIp', 'sshPort'].includes(k))) { db.prepare('UPDATE nodes SET ssh_host_key = NULL WHERE id = ?').run(n.id); probes.delete(n.id); }
    log(req, 'node_update', n.name, keys.join(','));
    emit(nodesDb.get(n.id));
    res.json({ node: view(nodesDb.get(n.id)) });
  }));

  router.delete('/nodes/:id', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    if (req.body?.confirm !== n.name) throw bad(`Type "${n.name}" exactly to confirm`);
    live.get(n.id)?.ws.close(4006, 'node removed');
    db.prepare('DELETE FROM nodes WHERE id = ?').run(n.id);
    for (const k of ['node_offline', 'node_agent', 'node_degraded', 'node_cpu', 'node_memory', 'node_disk']) monitoring.clear(k, `node:${n.id}`);
    log(req, 'node_delete', n.name, 'registration removed; nothing on the server was changed');
    io.to('admin').emit('node', { id: n.id, deleted: true });
    res.json({ ok: true });
  }));

  router.post('/nodes/:id/primary', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    db.transaction(() => {
      db.prepare('UPDATE nodes SET is_primary = 0 WHERE is_primary = 1').run();
      db.prepare('UPDATE nodes SET is_primary = 1 WHERE id = ?').run(n.id);
    })();
    log(req, 'node_primary', n.name);
    for (const x of nodesDb.all()) emit(x);
    res.json({ ok: true });
  }));

  router.post('/nodes/:id/maintenance', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    db.prepare('UPDATE nodes SET maintenance = ? WHERE id = ?').run(req.body?.on ? 1 : 0, n.id);
    log(req, 'node_maintenance', n.name, req.body?.on ? 'on' : 'off');
    setStatus(nodesDb.get(n.id), derive(nodesDb.get(n.id)));
    res.json({ node: view(nodesDb.get(n.id)) });
  }));

  // One-time enrollment token (1 hour). Only its hash is stored.
  router.post('/nodes/:id/enroll-token', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    const token = `kce_${crypto.randomBytes(24).toString('base64url')}`;
    const expires = Date.now() + 3600e3;
    db.prepare('UPDATE nodes SET enroll_hash = ?, enroll_expires_at = ? WHERE id = ?').run(sha(token), expires, n.id);
    log(req, 'node_enroll_token', n.name);
    emit(nodesDb.get(n.id));
    res.json({ token, expiresAt: expires });
  }));

  // Connect / disconnect: a disconnected agent is refused (it keeps retrying quietly) until connected again
  router.post('/nodes/:id/agent/:what(connect|disconnect|revoke)', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    const { what } = req.params;
    if (what === 'revoke' && req.body?.confirm !== n.name) throw bad(`Type "${n.name}" exactly to confirm`);
    if (what === 'connect') db.prepare('UPDATE nodes SET agent_enabled = 1 WHERE id = ?').run(n.id);
    if (what === 'disconnect') db.prepare('UPDATE nodes SET agent_enabled = 0 WHERE id = ?').run(n.id);
    if (what === 'revoke') db.prepare('UPDATE nodes SET agent_key_hash = NULL, agent_version = NULL WHERE id = ?').run(n.id);
    if (what !== 'connect') live.get(n.id)?.ws.close(4004, `agent ${what === 'revoke' ? 'key revoked' : 'disconnected'} by an admin`);
    log(req, `node_agent_${what}`, n.name);
    emit(nodesDb.get(n.id));
    res.json({ node: view(nodesDb.get(n.id)) });
  }));

  router.post('/nodes/:id/agent/test', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    const t0 = Date.now();
    const f = await call(n.id, 'facts', {}, 15_000);
    res.json({ ok: true, ms: Date.now() - t0, version: f.system?.agentVersion, hostname: f.system?.hostname });
  }));

  // ---------- public: enrollment (one-time token -> node key) ----------
  publicRouter.post('/agent/v1/enroll', wrap(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const ip = clientIp(req);
    const n = token.length < 100 ? db.prepare('SELECT * FROM nodes WHERE enroll_hash = ?').get(sha(token)) : null;
    if (!n || n.enroll_expires_at < Date.now()) {
      audit.log({ username: 'agent', ip, action: 'agent_enroll', result: 'failure', detail: n ? 'token expired' : 'unknown token' });
      throw new HttpError(401, 'Enrollment token is wrong or expired. Create a new one in the panel.');
    }
    const key = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE nodes SET agent_key_hash = ?, enroll_hash = NULL, enroll_expires_at = NULL, agent_enabled = 1, agent_version = ?, updated_at = ? WHERE id = ?')
      .run(sha(key), String(req.body.version || '').slice(0, 20), Date.now(), n.id);
    live.get(n.id)?.ws.close(4005, 'node re-enrolled');
    audit.log({ username: 'agent', ip, action: 'agent_enroll', target: n.name, result: 'success', detail: String(req.body.facts?.system?.hostname || '').slice(0, 80) });
    emit(nodesDb.get(n.id));
    res.json({ nodeId: n.uid, name: n.name, key });
  }));

  // ---------- start ----------
  function start() {
    const loop = () => statusLoop().catch((e) => console.error('Node status loop:', e.message)).finally(() => setTimeout(loop, Math.min(5000, PROBE_MS)).unref());
    setTimeout(loop, 1500).unref();
    setInterval(() => {
      const minute = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
      for (const [id, a] of acc) if (a.ts < minute) { try { flushMinute(id, a); } catch { /* node deleted */ } acc.delete(id); }
    }, Math.min(15_000, BUCKET_MS)).unref();
    setInterval(() => { try { rollup(); } catch (e) { console.error('Metric roll-up:', e.message); } }, 10 * 60_000).unref();
    setTimeout(() => { try { rollup(); } catch { /* ignore */ } }, 30_000).unref();
  }

  return {
    router, publicRouter, handleUpgrade, start, call, view, summary,
    isConnected: (id) => live.has(Number(id)), facts: (id) => live.get(Number(id))?.facts || null,
    list: () => nodesDb.all(), get: (id) => nodesDb.get(Number(id)),
    // for tests
    _rollup: rollup, _flushAll: () => { for (const [id, a] of acc) { flushMinute(id, a); acc.delete(id); } },
  };
}
