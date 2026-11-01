// Lightweight monitoring: per-minute averages in SQLite (7 days), threshold alerts, service checks.
// No extra daemons: everything runs inside the panel process on timers.
import express from 'express';
import { execFile } from 'node:child_process';
import { db, settings, audit } from './db.js';
import { roomFor } from './containers.js';
import { clientIp, isAdmin, ownsContainer } from './auth.js';

const KEEP_DAYS = 7;
const RANGES = { '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };
const MAX_POINTS = 360;
const SERVICES = (process.env.MONITOR_SERVICES || 'snap.lxd.daemon,cloudflared,nginx,ssh,panel-backup.timer')
  .split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9@._-]{1,80}$/.test(s));

const run = (cmd, args, timeout = 10_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: stdout || '' }));
});

const alertsDb = {
  open: (kind, target) => db.prepare('SELECT * FROM alerts WHERE kind = ? AND target = ? AND resolved_at IS NULL').get(kind, target),
  insert: (a) => db.prepare(`INSERT INTO alerts (kind, target, level, message, created_at, updated_at) VALUES (@kind, @target, @level, @message, @now, @now)`).run(a).lastInsertRowid,
  touch: (id, level, message) => db.prepare('UPDATE alerts SET level = ?, message = ?, updated_at = ? WHERE id = ?').run(level, message, Date.now(), id),
  resolve: (id) => db.prepare('UPDATE alerts SET resolved_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id),
  ack: (id, by) => db.prepare('UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?').run(by, Date.now(), id),
  get: (id) => db.prepare('SELECT * FROM alerts WHERE id = ?').get(id),
  recent: (limit, openOnly) => db.prepare(`SELECT * FROM alerts ${openOnly ? 'WHERE resolved_at IS NULL' : ''} ORDER BY resolved_at IS NOT NULL, id DESC LIMIT ?`).all(limit),
  forTargets: (targets, limit) => (targets.length ? db.prepare(`SELECT * FROM alerts WHERE target IN (${targets.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(...targets, limit) : []),
  prune: (before) => db.prepare('DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(before),
};

export function createMonitoring({ io }) {
  const acc = new Map(); // scope -> sums for the current minute
  const over = new Map(); // `${kind}:${target}` -> consecutive minutes over threshold
  let services = { at: 0, units: [], pm2: null };

  const emitAlert = (a) => {
    const rooms = ['admin'];
    if (a.target?.startsWith('ct:')) rooms.push(roomFor(a.target.slice(3)));
    io.to(rooms).emit('alert', a);
  };

  // ---------- alerts ----------
  function raise(kind, target, level, message) {
    const cur = alertsDb.open(kind, target);
    if (cur) {
      if (cur.level !== level || cur.message !== message) {
        alertsDb.touch(cur.id, level, message);
        emitAlert(alertsDb.get(cur.id));
      }
      return;
    }
    const id = alertsDb.insert({ kind, target, level, message, now: Date.now() });
    const a = alertsDb.get(id);
    audit.log({ username: 'system', action: 'alert', target: target || kind, result: level, detail: message });
    emitAlert(a);
  }
  function clear(kind, target) {
    const cur = alertsDb.open(kind, target);
    if (!cur) return;
    alertsDb.resolve(cur.id);
    emitAlert(alertsDb.get(cur.id));
  }
  // Raised only after the value stayed over the line for `alert_sustain_minutes` minutes in a row
  function sustained(kind, target, value, threshold, message) {
    const key = `${kind}:${target}`;
    if (value == null || !Number.isFinite(value)) return;
    if (value >= threshold) {
      const n = (over.get(key) || 0) + 1;
      over.set(key, n);
      if (n >= Number(settings.get('alert_sustain_minutes') || 5)) raise(kind, target, value >= Math.min(99, threshold + 7) ? 'critical' : 'warning', message);
    } else {
      over.delete(key);
      clear(kind, target);
    }
  }

  // ---------- samples ----------
  function add(scope, s) {
    const a = acc.get(scope) || { n: 0, cpu: 0, mem: 0, rx: 0, tx: 0, load1: 0, ior: 0, iow: 0, temp: null, mem_total: 0, disk: 0, disk_total: 0 };
    a.n += 1;
    a.cpu += s.cpu || 0;
    a.mem += s.mem || 0;
    a.rx += s.rx || 0;
    a.tx += s.tx || 0;
    a.load1 += s.load1 || 0;
    a.ior += s.ioRead || 0;
    a.iow += s.ioWrite || 0;
    if (s.temp != null) a.temp = Math.max(a.temp ?? -Infinity, s.temp);
    a.mem_total = s.memTotal || a.mem_total;
    a.disk = s.disk ?? a.disk;
    a.disk_total = s.diskTotal || a.disk_total;
    acc.set(scope, a);
  }
  const recordHost = (p) => add('host', {
    cpu: p.cpu, mem: p.ramUsed, memTotal: p.ramTotal, disk: p.diskUsed, diskTotal: p.diskTotal, rx: p.rx, tx: p.tx,
    load1: p.load1, temp: p.temp, ioRead: p.ioRead, ioWrite: p.ioWrite,
  });
  const recordContainer = (name, s) => add(`ct:${name}`, {
    cpu: s.cpu, mem: s.memUsed, memTotal: s.memTotal, disk: s.diskUsed, diskTotal: s.diskTotal, rx: s.rx, tx: s.tx,
  });

  const insert = db.prepare(`INSERT OR REPLACE INTO metrics (scope, ts, cpu, mem, mem_total, disk, disk_total, rx, tx, load1, temp, io_read, io_write)
    VALUES (@scope, @ts, @cpu, @mem, @mem_total, @disk, @disk_total, @rx, @tx, @load1, @temp, @io_read, @io_write)`);

  function flush() {
    const ts = Math.floor(Date.now() / 60_000) * 60_000;
    const cfg = settings.all();
    const rows = [];
    for (const [scope, a] of acc) {
      if (!a.n) continue;
      const r = {
        scope, ts, cpu: a.cpu / a.n, mem: a.mem / a.n, mem_total: a.mem_total, disk: a.disk, disk_total: a.disk_total,
        rx: a.rx / a.n, tx: a.tx / a.n, load1: a.load1 / a.n, temp: a.temp, io_read: a.ior / a.n, io_write: a.iow / a.n,
      };
      rows.push(r);
      const memPct = r.mem_total ? (r.mem / r.mem_total) * 100 : null;
      const diskPct = r.disk_total ? (r.disk / r.disk_total) * 100 : null;
      if (scope === 'host') {
        sustained('cpu_high', 'host', r.cpu, cfg.alert_cpu, `Host CPU at ${r.cpu.toFixed(0)}% (threshold ${cfg.alert_cpu}%)`);
        sustained('memory_high', 'host', memPct, cfg.alert_memory, `Host memory at ${memPct?.toFixed(0)}% (threshold ${cfg.alert_memory}%)`);
        sustained('disk_high', 'host', diskPct, cfg.alert_disk, `Host root disk at ${diskPct?.toFixed(0)}% (threshold ${cfg.alert_disk}%)`);
        if (r.temp != null) sustained('temp_high', 'host', r.temp, cfg.alert_temp, `CPU temperature ${r.temp.toFixed(0)}°C (threshold ${cfg.alert_temp}°C)`);
      } else {
        const name = scope.slice(3);
        sustained('ct_memory_high', scope, memPct, cfg.alert_memory, `${name}: memory at ${memPct?.toFixed(0)}% of its limit`);
        sustained('ct_disk_high', scope, diskPct, cfg.alert_disk, `${name}: disk at ${diskPct?.toFixed(0)}% of its quota`);
      }
    }
    acc.clear();
    db.transaction(() => { for (const r of rows) insert.run(r); })();
  }

  function prune() {
    db.prepare('DELETE FROM metrics WHERE ts < ?').run(Date.now() - KEEP_DAYS * 86400_000);
    alertsDb.prune(Date.now() - 30 * 86400_000);
  }

  // ---------- services ----------
  async function checkServices() {
    const units = [];
    for (const unit of SERVICES) {
      const { stdout } = await run('systemctl', ['show', '-p', 'LoadState,ActiveState,SubState,Description', '--', unit]);
      const kv = Object.fromEntries(stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const installed = kv.LoadState && kv.LoadState !== 'not-found';
      const u = { unit, installed: !!installed, active: kv.ActiveState || 'unknown', sub: kv.SubState || '', description: kv.Description || '' };
      units.push(u);
      if (installed && ['failed', 'inactive'].includes(u.active)) raise('service_down', `svc:${unit}`, 'critical', `Service ${unit} is ${u.active}`);
      else if (installed) clear('service_down', `svc:${unit}`);
    }
    let pm2 = null;
    const r = await run('pm2', ['jlist'], 15_000);
    if (!r.err) {
      try {
        pm2 = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).map((p) => ({
          name: p.name, status: p.pm2_env?.status, restarts: p.pm2_env?.restart_time ?? 0,
          cpu: p.monit?.cpu ?? 0, memory: p.monit?.memory ?? 0, uptime: p.pm2_env?.pm_uptime ?? null,
        }));
        for (const p of pm2) {
          if (['errored', 'stopped'].includes(p.status)) raise('pm2_down', `pm2:${p.name}`, p.status === 'errored' ? 'critical' : 'warning', `PM2 app ${p.name} is ${p.status}`);
          else clear('pm2_down', `pm2:${p.name}`);
        }
      } catch { pm2 = null; }
    }
    services = { at: Date.now(), units, pm2 };
    io.to('admin').emit('services', services);
  }

  // ---------- history ----------
  function history(scope, range) {
    const span = RANGES[range] || RANGES['1h'];
    const since = Date.now() - span;
    const bucket = Math.max(60_000, Math.ceil(span / MAX_POINTS / 60_000) * 60_000);
    return db.prepare(`SELECT (ts / @bucket) * @bucket AS t, AVG(cpu) AS cpu, AVG(mem) AS mem, MAX(mem_total) AS memTotal,
        MAX(disk) AS disk, MAX(disk_total) AS diskTotal, AVG(rx) AS rx, AVG(tx) AS tx, AVG(load1) AS load1, MAX(temp) AS temp,
        AVG(io_read) AS ioRead, AVG(io_write) AS ioWrite
      FROM metrics WHERE scope = @scope AND ts >= @since GROUP BY t ORDER BY t`).all({ scope, since, bucket });
  }

  // ---------- routes ----------
  const router = express.Router();

  router.get('/metrics', (req, res) => {
    const scope = String(req.query.scope || 'host');
    if (scope === 'host') {
      if (!isAdmin(req.session)) return res.status(403).json({ error: 'Admins only' });
    } else if (!scope.startsWith('ct:') || !ownsContainer(req.session, scope.slice(3))) {
      return res.status(403).json({ error: 'You can only see your own servers' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ scope, range: RANGES[req.query.range] ? req.query.range : '1h', points: history(scope, req.query.range) });
  });

  router.get('/alerts', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    if (isAdmin(req.session)) return res.json({ alerts: alertsDb.recent(limit, req.query.open === '1') });
    return res.json({ alerts: alertsDb.forTargets(req.session.containers.map((c) => `ct:${c}`), limit) });
  });

  router.post('/alerts/:id/ack', (req, res) => {
    if (!isAdmin(req.session)) return res.status(403).json({ error: 'Admins only' });
    const a = /^\d+$/.test(req.params.id) ? alertsDb.get(Number(req.params.id)) : null;
    if (!a) return res.status(404).json({ error: 'No such alert' });
    alertsDb.ack(a.id, req.session.username);
    audit.log({ username: req.session.username, ip: clientIp(req), action: 'alert_ack', target: a.target || a.kind, result: 'success', detail: a.message });
    const updated = alertsDb.get(a.id);
    emitAlert(updated);
    return res.json(updated);
  });

  router.get('/services', (req, res) => {
    if (!isAdmin(req.session)) return res.status(403).json({ error: 'Admins only' });
    res.set('Cache-Control', 'no-store');
    return res.json(services);
  });

  function start() {
    setInterval(() => { try { flush(); } catch (err) { console.error('Metrics flush failed:', err.message); } }, 60_000).unref();
    setInterval(() => { try { prune(); } catch (err) { console.error('Metrics prune failed:', err.message); } }, 3600_000).unref();
    const svcLoop = () => checkServices().catch((err) => console.error('Service check failed:', err.message)).finally(() => setTimeout(svcLoop, 60_000).unref());
    svcLoop();
    prune();
  }

  return {
    router, start, raise, clear, recordHost, recordContainer,
    services: () => services,
    openAlerts: () => alertsDb.recent(50, true),
  };
}
