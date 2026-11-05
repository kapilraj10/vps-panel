// Network Diagnostics: tests run ON a chosen node by its agent (not in the browser, not on the control plane):
// ping, traceroute/tracepath, DNS, TCP port, HTTP(S), internet speed. Results are stored (network_tests).
// Targets for ping / traceroute / TCP / HTTP must be a registered node or an explicitly authorized target
// (network_targets). DNS lookups and speed tests need no target approval.
// Server-to-server matrix: every online node pings every other node (private IP when both are in the same private
// network zone, else public IP) every net_matrix_minutes; latency / loss alerts use alert_latency_ms / alert_packet_loss.
import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { db, audit, settings } from './db.js';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { wrap, bad, notFound, conflict, int, str } from './http.js';

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const KINDS = ['ping', 'traceroute', 'dns', 'tcp', 'http', 'speedtest'];
const TIMEOUTS = { ping: 60_000, traceroute: 150_000, dns: 20_000, tcp: 25_000, http: 40_000, speedtest: 120_000 };
const parse = (r) => (r ? { ...r, params: r.params ? JSON.parse(r.params) : null, result: r.result ? JSON.parse(r.result) : null } : r);

export function createNetTests({ io, nodes, monitoring }) {
  const router = express.Router();
  const running = new Set(); // `${kind}:${sourceId}` for speed tests (one per node at a time)

  const addressOf = (src, dst) => (src.net_zone && src.net_zone === dst.net_zone && dst.private_ip ? dst.private_ip : dst.public_ip || dst.private_ip);
  function authorizedHost(h) {
    const host = h.toLowerCase();
    const nodeHit = nodes.list().find((n) => [n.public_ip, n.private_ip, n.hostname].filter(Boolean).map((x) => x.toLowerCase()).includes(host));
    if (nodeHit) return { node: nodeHit };
    if (db.prepare('SELECT 1 FROM network_targets WHERE host = ?').get(host)) return { node: null };
    return null;
  }

  function store(row) {
    return db.prepare(`INSERT INTO network_tests (run_id, kind, source_id, target_id, target, params, status, by_user, started_at)
      VALUES (@run_id, @kind, @source_id, @target_id, @target, @params, 'running', @by, @now)`).run({ ...row, now: Date.now() }).lastInsertRowid;
  }
  function done(id, { result = null, error = null }) {
    const latency = result?.avg ?? result?.ms ?? result?.latency ?? null;
    const loss = result?.loss ?? result?.packetLoss ?? null;
    db.prepare('UPDATE network_tests SET status = ?, result = ?, error = ?, latency = ?, loss = ?, finished_at = ? WHERE id = ?')
      .run(error ? 'failed' : 'success', result ? JSON.stringify(result) : null, error, latency, loss, Date.now(), id);
    const row = parse(db.prepare('SELECT * FROM network_tests WHERE id = ?').get(id));
    io.to('admin').emit('nettest', row);
    return row;
  }

  // Runs one test on `source`; returns the stored row (awaits the agent)
  async function runTest({ kind, source, args, target, targetId = null, by, runId = null }) {
    const id = store({ run_id: runId, kind, source_id: source.id, target_id: targetId, target, params: JSON.stringify(args), by });
    try {
      const result = await nodes.call(source.id, kind, args, TIMEOUTS[kind]);
      return done(id, { result, error: result?.error && kind !== 'dns' && !result.received && !result.open ? result.error : null });
    } catch (e) {
      return done(id, { error: e.message });
    }
  }

  // admin guard only for this router's own paths (it is mounted at /api next to user routes)
  router.use(['/nettests', '/net-targets', '/net-matrix'], requireAdmin);

  // ---------- authorized targets ----------
  router.get('/net-targets', (_req, res) => res.json({ targets: db.prepare('SELECT * FROM network_targets ORDER BY host').all() }));
  router.post('/net-targets', requireSuperAdmin, wrap(async (req, res) => {
    const host = str(req.body?.host, { max: 253, name: 'Host' }).toLowerCase();
    if (!(net.isIP(host) || HOST_RE.test(host))) throw bad('Host must be an IP address or hostname');
    const note = req.body?.note ? str(req.body.note, { max: 120, name: 'Note', re: /^[^<>]*$/ }) : null;
    db.prepare('INSERT OR IGNORE INTO network_targets (host, note, created_by, created_at) VALUES (?, ?, ?, ?)').run(host, note, req.session.username, Date.now());
    audit.log({ username: req.session.username, ip: clientIp(req), action: 'net_target_add', target: host, result: 'success' });
    res.status(201).json({ ok: true });
  }));
  router.delete('/net-targets/:id', requireSuperAdmin, (req, res) => {
    const r = db.prepare('SELECT * FROM network_targets WHERE id = ?').get(Number(req.params.id));
    if (!r) throw notFound();
    db.prepare('DELETE FROM network_targets WHERE id = ?').run(r.id);
    audit.log({ username: req.session.username, ip: clientIp(req), action: 'net_target_remove', target: r.host, result: 'success' });
    res.json({ ok: true });
  });

  // ---------- one test ----------
  // body: { kind, sourceId, targetNodeId? | target?, count?, port?, url?, name?, type?, ipv6?, maxHops? }
  router.post('/nettests', wrap(async (req, res) => {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
    const source = nodes.get(b.sourceId);
    if (!source) throw notFound('Pick the server to run the test from');
    if (!nodes.isConnected(source.id)) throw conflict(`${source.name}: agent is not connected, so the test cannot run there`);
    let target = null;
    let targetId = null;
    const args = {};
    if (['ping', 'traceroute', 'tcp', 'http'].includes(b.kind)) {
      let hostName;
      if (b.targetNodeId) {
        const t = nodes.get(b.targetNodeId);
        if (!t) throw notFound('No such target server');
        hostName = addressOf(source, t);
        if (!hostName) throw bad(`${t.name} has no IP address`);
        targetId = t.id;
      } else if (b.kind === 'http') {
        let u;
        try { u = new URL(String(b.url || '')); } catch { throw bad('URL is not valid'); }
        if (!['http:', 'https:'].includes(u.protocol)) throw bad('Only http:// and https:// URLs');
        hostName = u.hostname.replace(/^\[|\]$/g, '');
      } else {
        hostName = str(b.target, { max: 253, name: 'Target' });
      }
      if (!(net.isIP(hostName) || HOST_RE.test(hostName))) throw bad('Target must be an IP address or hostname');
      const auth = authorizedHost(hostName);
      if (!auth) throw bad(`${hostName} is not a registered server or an authorized target. A super admin can add it under "Authorized targets".`);
      if (auth.node && !targetId) targetId = auth.node.id;
      target = hostName;
      if (b.kind === 'ping') Object.assign(args, { target: hostName, count: int(b.count ?? 10, { min: 1, max: 50, name: 'Count' }), ipv6: !!b.ipv6 });
      if (b.kind === 'traceroute') Object.assign(args, { target: hostName, maxHops: int(b.maxHops ?? 20, { min: 1, max: 40, name: 'Max hops' }) });
      if (b.kind === 'tcp') {
        const port = int(b.port, { min: 1, max: 65535, name: 'Port' });
        Object.assign(args, { host: hostName, port });
        target = `${hostName}:${port}`;
      }
      if (b.kind === 'http') {
        const u = new URL(b.targetNodeId ? `${b.scheme === 'https' ? 'https' : 'http'}://${hostName}${b.port ? `:${int(b.port, { min: 1, max: 65535, name: 'Port' })}` : ''}${b.path || '/'}` : b.url);
        Object.assign(args, { url: u.href });
        target = u.href;
      }
    } else if (b.kind === 'dns') {
      const name = str(b.name, { max: 253, name: 'Name' });
      if (!HOST_RE.test(name)) throw bad('Name must be a domain name');
      const type = String(b.type || 'A').toUpperCase();
      if (!['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'].includes(type)) throw bad('Unsupported record type');
      Object.assign(args, { name, type, ...(b.server ? { server: str(b.server, { max: 64, name: 'DNS server', re: /^[\d.:a-fA-F]+$/ }) } : {}) });
      target = `${name} ${type}`;
    } else if (b.kind === 'speedtest') {
      const key = `speedtest:${source.id}`;
      if (running.has(key)) throw conflict(`A speed test is already running on ${source.name}`);
      running.add(key);
      Object.assign(args, { seconds: 8 });
      target = 'internet';
    }
    audit.log({ username: req.session.username, ip: clientIp(req), action: `nettest_${b.kind}`, target: `${source.name} -> ${target}`, result: 'requested' });
    const p = runTest({ kind: b.kind, source, args, target, targetId, by: req.session.username })
      .finally(() => running.delete(`speedtest:${source.id}`));
    if (b.wait === false || b.kind === 'speedtest' || b.kind === 'traceroute') {
      const row = db.prepare('SELECT * FROM network_tests WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(source.id);
      p.catch(() => {});
      return res.status(202).json({ test: parse(row) });
    }
    return res.json({ test: await p });
  }));

  router.get('/nettests', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    res.set('Cache-Control', 'no-store');
    const rows = db.prepare(`SELECT t.*, s.name AS source_name, d.name AS target_name FROM network_tests t LEFT JOIN nodes s ON s.id = t.source_id LEFT JOIN nodes d ON d.id = t.target_id
      WHERE t.kind != 'matrix' ${kind ? 'AND t.kind = ?' : ''} ORDER BY t.id DESC LIMIT ?`).all(...(kind ? [kind, limit] : [limit]));
    res.json({ tests: rows.map(parse) });
  });
  router.get('/nettests/:id', (req, res) => {
    const r = db.prepare('SELECT * FROM network_tests WHERE id = ?').get(Number(req.params.id));
    if (!r) throw notFound();
    res.json({ test: parse(r) });
  });

  // ---------- server-to-server matrix ----------
  let matrixRunning = null;
  async function runMatrix(by = 'system') {
    if (matrixRunning) throw conflict('The matrix is already running');
    const runId = crypto.randomUUID();
    matrixRunning = runId;
    try {
      const all = nodes.list().filter((n) => !n.maintenance);
      const sources = all.filter((n) => nodes.isConnected(n.id));
      // each source pings all others; sources run in parallel, targets one after another (no flood)
      await Promise.all(sources.map(async (src) => {
        for (const dst of all) {
          if (dst.id === src.id) continue;
          const addr = addressOf(src, dst);
          if (!addr) continue;
          const row = await runTest({ kind: 'ping', source: src, args: { target: addr, count: 5 }, target: addr, targetId: dst.id, by, runId });
          db.prepare("UPDATE network_tests SET kind = 'matrix' WHERE id = ?").run(row.id);
          const key = `net:${src.id}:${dst.id}`;
          const lossLimit = Number(settings.get('alert_packet_loss') || 5);
          const latLimit = Number(settings.get('alert_latency_ms') || 150);
          const r = row.result;
          if (row.status === 'failed' || r?.loss >= 100) monitoring.raise('net_path', key, 'critical', `${src.name} cannot reach ${dst.name} (${addr})`);
          else if (r?.loss >= lossLimit) monitoring.raise('net_path', key, 'warning', `${src.name} → ${dst.name}: ${r.loss}% packet loss`);
          else if (r?.avg >= latLimit) monitoring.raise('net_path', key, 'warning', `${src.name} → ${dst.name}: ${r.avg} ms latency`);
          else monitoring.clear('net_path', key);
        }
      }));
      io.to('admin').emit('netmatrix', { runId });
      return runId;
    } finally {
      matrixRunning = null;
    }
  }

  router.get('/net-matrix', (req, res) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
    const since = Date.now() - hours * 3600e3;
    const latest = db.prepare(`SELECT t.* FROM network_tests t JOIN (SELECT source_id, target_id, MAX(id) AS id FROM network_tests WHERE kind = 'matrix' GROUP BY source_id, target_id) m ON m.id = t.id`).all();
    const stats = db.prepare(`SELECT source_id, target_id, COUNT(*) AS runs, ROUND(AVG(latency), 2) AS avg, ROUND(MIN(latency), 2) AS min, ROUND(MAX(latency), 2) AS max, ROUND(AVG(loss), 1) AS loss
      FROM network_tests WHERE kind = 'matrix' AND started_at >= ? GROUP BY source_id, target_id`).all(since);
    res.set('Cache-Control', 'no-store');
    res.json({
      nodes: nodes.list().map((n) => ({ id: n.id, name: n.name, location: n.location, connected: nodes.isConnected(n.id) })),
      latest: latest.map(parse), stats, running: !!matrixRunning, everyMinutes: Number(settings.get('net_matrix_minutes') || 0), hours,
    });
  });
  router.get('/net-matrix/history', (req, res) => {
    const src = Number(req.query.source);
    const dst = Number(req.query.target);
    const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
    res.json({ points: db.prepare("SELECT started_at AS t, latency, loss, status FROM network_tests WHERE kind = 'matrix' AND source_id = ? AND target_id = ? AND started_at >= ? ORDER BY id").all(src, dst, Date.now() - hours * 3600e3) });
  });
  router.post('/net-matrix/run', requireSuperAdmin, wrap(async (req, res) => {
    if (matrixRunning) throw conflict('The matrix is already running');
    audit.log({ username: req.session.username, ip: clientIp(req), action: 'net_matrix_run', result: 'requested' });
    runMatrix(req.session.username).catch((e) => console.error('Matrix:', e.message));
    res.status(202).json({ ok: true });
  }));

  function start() {
    let last = Date.now();
    setInterval(() => {
      const every = Number(settings.get('net_matrix_minutes') || 0);
      if (!every || matrixRunning || Date.now() - last < every * 60_000) return;
      last = Date.now();
      runMatrix().catch((e) => console.error('Matrix:', e.message));
    }, 30_000).unref();
  }

  return { router, start, runMatrix };
}
