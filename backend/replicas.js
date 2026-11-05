// ReplicaService: host applications that run as several real replicas (PM2 processes or Docker containers), each on its
// own 127.0.0.1 port, behind one Nginx upstream (loadbalancer.js).
//
//   replica 0 = primary, 1..n = replicas. Process / container name: kc-<app>-<idx>.
//   Health: HTTP GET 127.0.0.1:<port><health_path> every HEALTH_INTERVAL_MS. 2 failures -> unhealthy -> removed from the
//   upstream (failover) + alert; 2 successes -> healthy -> back in. Weight = traffic share; weight 0 = hot standby (backup).
//   Rolling restart / update: one replica at a time is drained, restarted (or recreated with the new image), checked,
//   and put back. If it does not become healthy the replica is rolled back to the old version and the update stops.
// Every change runs under a per-app lock (no concurrent conflicting changes) and is written to app_events + the audit log.
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { db, audit } from './db.js';
import { seal, open } from './secrets.js';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { locks, allowedDir, parseEnv, tailFile } from './hostexec.js';
import { dockerRequest, safeCreateBody, pullImage, containerStats, demux } from './docker.js';
import { wrap, bad, notFound, conflict, int, str } from './http.js';

const APP_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const range = (s, def) => {
  const m = String(s || def).match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : def.split('-').map(Number);
};
const REPLICA_PORTS = () => range(process.env.REPLICA_PORTS, '5000-5999');
const LB_PORTS = () => range(process.env.LB_PORTS, '8100-8199');
const HEALTH_INTERVAL = () => Number(process.env.HEALTH_INTERVAL_MS) || 10_000;
const HEALTH_WAIT = () => Number(process.env.HEALTH_WAIT_MS) || 60_000;
const FAILS = 2;
const OKS = 2;
const MAX_REPLICAS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const q = {
  apps: () => db.prepare('SELECT * FROM host_apps ORDER BY name').all(),
  app: (id) => db.prepare('SELECT * FROM host_apps WHERE id = ?').get(id),
  replicas: (appId) => db.prepare('SELECT * FROM app_replicas WHERE app_id = ? ORDER BY idx').all(appId),
  replica: (appId, idx) => db.prepare('SELECT * FROM app_replicas WHERE app_id = ? AND idx = ?').get(appId, idx),
  allReplicas: () => db.prepare('SELECT r.*, a.name AS app_name, a.health_path FROM app_replicas r JOIN host_apps a ON a.id = r.app_id').all(),
  usedPorts: () => new Set([
    ...db.prepare('SELECT port FROM app_replicas').all().map((r) => r.port),
    ...db.prepare('SELECT lb_port AS port FROM host_apps WHERE lb_port IS NOT NULL').all().map((r) => r.port),
  ]),
  events: (appId, limit) => db.prepare('SELECT * FROM app_events WHERE app_id = ? ORDER BY id DESC LIMIT ?').all(appId, limit),
};

// Is anything (any process, any interface) listening on this TCP port?
export function portFree(port) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
  return tryHost('0.0.0.0').then((a) => a && tryHost('127.0.0.1')).then((b) => b && tryHost('::'));
}

async function allocate(n, [lo, hi], { prefer = null, exclude = new Set() } = {}) {
  const used = q.usedPorts();
  const out = [];
  if (prefer) {
    for (let i = 0; i < n; i += 1) {
      const p = prefer + i;
      if (p < 1024 || p > 65535) throw bad(`Port ${p} is out of range`);
      if (used.has(p) || exclude.has(p)) throw conflict(`Port ${p} is already used by another Kapil Cloud application`);
      if (!(await portFree(p))) throw conflict(`Port ${p} is already in use on this server`);
      out.push(p);
    }
    return out;
  }
  for (let p = lo; p <= hi && out.length < n; p += 1) {
    if (used.has(p) || exclude.has(p)) continue;
    if (await portFree(p)) out.push(p);
  }
  if (out.length < n) throw conflict(`Not enough free ports in ${lo}-${hi}`);
  return out;
}

function probe(port, pathName, timeout = 3000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout, headers: { 'user-agent': 'kapil-cloud-health' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 500, code: res.statusCode, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - t0 }));
  });
}

export function createReplicas({ io, pm2, lb, monitoring }) {
  const router = express.Router();
  const draining = new Set(); // replica ids temporarily out of the upstream (rolling operations)

  const event = (appId, kind, message, { level = 'info', by = null } = {}) => {
    db.prepare('INSERT INTO app_events (app_id, ts, kind, level, message, by_user) VALUES (?, ?, ?, ?, ?, ?)').run(appId, Date.now(), kind, level, message, by);
    io.to('admin').emit('hostapp', { id: appId, kind, message, level });
  };
  const setOp = (id, op, status, message) => {
    db.prepare('UPDATE host_apps SET op = ?, op_status = ?, op_message = ?, op_at = ? WHERE id = ?').run(op, status, message, Date.now(), id);
    io.to('admin').emit('hostapp', { id, op, status, message });
  };
  const procName = (app, idx) => `kc-${app.name}-${idx}`;
  const envOf = (app) => { try { return JSON.parse(open(app.env_enc) || '{}'); } catch { return {}; } };

  // ---------- runtime: start / stop / remove one replica ----------
  async function startReplica(app, r, { version } = {}) {
    const env = { ...envOf(app), KC_APP: app.name, KC_REPLICA: String(r.idx) };
    if (app.runtime === 'pm2') {
      await pm2.startApp({
        name: procName(app, r.idx), cwd: app.cwd, script: app.script, ...(app.args ? { args: app.args } : {}),
        env: { ...env, PORT: String(r.port) }, exec_mode: 'fork', instances: 1, autorestart: true, time: true,
        ...(app.max_memory_mb ? { max_memory_restart: `${app.max_memory_mb}M` } : {}),
      });
    } else {
      const image = version || r.version || app.version || app.image;
      const name = procName(app, r.idx);
      await dockerRequest('DELETE', `/containers/${name}`, { query: { force: true } }).catch((e) => { if (e.status !== 404) throw e; });
      const made = await dockerRequest('POST', '/containers/create', {
        query: { name },
        body: safeCreateBody({
          image, env: { ...env, PORT: String(app.container_port) }, ports: [{ host: r.port, container: app.container_port }],
          memoryMb: app.max_memory_mb, cpus: app.cpus, labels: { 'kapil.cloud.app': app.name, 'kapil.cloud.replica': String(r.idx) },
        }),
      });
      await dockerRequest('POST', `/containers/${made.Id}/start`);
    }
  }
  async function stopReplica(app, r) {
    if (app.runtime === 'pm2') await pm2.pm2(['stop', procName(app, r.idx)], 'stop').catch(() => {});
    else await dockerRequest('POST', `/containers/${procName(app, r.idx)}/stop`, { query: { t: 15 }, timeout: 60_000 }).catch((e) => { if (![304, 404].includes(e.status)) throw e; });
  }
  async function restartReplica(app, r) {
    if (app.runtime === 'pm2') {
      const r2 = await pm2.pm2(['restart', procName(app, r.idx), '--update-env'], 'restart').catch(() => null);
      if (!r2) await startReplica(app, r);
    } else {
      await dockerRequest('POST', `/containers/${procName(app, r.idx)}/restart`, { query: { t: 15 }, timeout: 60_000 })
        .catch(async (e) => { if (e.status === 404) await startReplica(app, r); else throw e; });
    }
  }
  async function removeReplica(app, r) {
    if (app.runtime === 'pm2') await pm2.pm2(['delete', procName(app, r.idx)], 'delete').catch(() => {});
    else await dockerRequest('DELETE', `/containers/${procName(app, r.idx)}`, { query: { force: true } }).catch((e) => { if (e.status !== 404) throw e; });
  }

  // Waits until the replica answers its health check (or HEALTH_WAIT passes)
  async function waitHealthy(app, r) {
    const end = Date.now() + HEALTH_WAIT();
    let last;
    while (Date.now() < end) {
      last = await probe(r.port, app.health_path, 3000);
      if (last.ok) {
        db.prepare("UPDATE app_replicas SET health = 'healthy', fails = 0, oks = ?, response_ms = ?, last_check_at = ?, last_error = NULL WHERE id = ?").run(OKS, last.ms, Date.now(), r.id);
        return true;
      }
      await sleep(1000);
    }
    db.prepare("UPDATE app_replicas SET health = 'unhealthy', fails = ?, last_check_at = ?, last_error = ? WHERE id = ?").run(FAILS, Date.now(), last?.error || `HTTP ${last?.code}`, r.id);
    return false;
  }

  // ---------- load balancer ----------
  function lbServers(app) {
    const reps = q.replicas(app.id);
    const servers = reps.map((r) => {
      const usable = r.enabled && r.desired === 'running' && r.health !== 'unhealthy' && !draining.has(r.id);
      return { port: r.port, weight: r.weight || 1, state: !usable ? 'down' : r.weight === 0 ? 'backup' : 'active' };
    });
    // Everything down but something is enabled and meant to run: send traffic to it anyway (better than a sure 502)
    if (!servers.some((s) => s.state !== 'down')) {
      reps.forEach((r, i) => { if (r.enabled && r.desired === 'running' && !draining.has(r.id)) servers[i].state = 'active'; });
    }
    return servers;
  }
  async function applyLb(app, reason, by = null) {
    if (!app.lb_port) return { changed: false };
    const r = await lb.apply(app, lbServers(app), `${app.name}: ${reason}`);
    if (r.changed) event(app.id, 'lb', `Load balancer updated (${reason}) [${r.hash}]`, { by });
    return r;
  }
  // Background re-apply after health changes; failures become an event + alert, not a crash
  const pendingLb = new Map();
  function scheduleLb(appId, reason) {
    clearTimeout(pendingLb.get(appId));
    pendingLb.set(appId, setTimeout(async () => {
      pendingLb.delete(appId);
      const app = q.app(appId);
      if (!app) return;
      try {
        await applyLb(app, reason);
        monitoring?.clear('lb_apply', `app:${app.name}`);
      } catch (err) {
        if (err.status === 409) { scheduleLb(appId, reason); return; } // nginx busy: retry
        event(app.id, 'lb', `Load balancer update failed: ${err.message}`, { level: 'error' });
        monitoring?.raise('lb_apply', `app:${app.name}`, 'critical', `${app.name}: load balancer update failed: ${err.message}`);
      }
    }, 300));
  }

  // ---------- health checks ----------
  let checking = false;
  async function healthLoop() {
    if (checking) return;
    checking = true;
    try {
      const reps = q.allReplicas().filter((r) => r.desired === 'running');
      await Promise.all(reps.map(async (r) => {
        const res = await probe(r.port, r.health_path);
        const fails = res.ok ? 0 : r.fails + 1;
        const oks = res.ok ? r.oks + 1 : 0;
        let health = r.health;
        if (!res.ok && fails >= FAILS) health = 'unhealthy';
        if (res.ok && (oks >= OKS || r.health === 'unknown')) health = 'healthy';
        db.prepare('UPDATE app_replicas SET fails = ?, oks = ?, health = ?, response_ms = ?, last_check_at = ?, last_error = ?, last_change_at = CASE WHEN health != ? THEN ? ELSE last_change_at END WHERE id = ?')
          .run(fails, oks, health, res.ok ? res.ms : null, Date.now(), res.ok ? null : (res.error || `HTTP ${res.code}`), health, Date.now(), r.id);
        if (health !== r.health && !draining.has(r.id)) {
          const label = r.idx === 0 ? 'primary' : `replica ${r.idx}`;
          const target = `app:${r.app_name}:${r.idx}`;
          if (health === 'unhealthy') {
            event(r.app_id, 'health', `${label} (port ${r.port}) is unhealthy: ${res.error || `HTTP ${res.code}`}. Removed from the load balancer.`, { level: 'error' });
            monitoring?.raise('replica_down', target, 'warning', `${r.app_name} ${label} is unhealthy and was taken out of traffic`);
          } else if (health === 'healthy') {
            if (r.health === 'unhealthy') event(r.app_id, 'health', `${label} (port ${r.port}) recovered. Back in the load balancer.`);
            monitoring?.clear('replica_down', target);
          }
          if (r.enabled) scheduleLb(r.app_id, `${label} ${health}`);
        }
      }));
      // whole-app alert
      for (const app of q.apps()) {
        const live = q.replicas(app.id).filter((r) => r.desired === 'running' && r.enabled);
        if (live.length && live.every((r) => r.health === 'unhealthy')) monitoring?.raise('app_down', `app:${app.name}`, 'critical', `${app.name}: no healthy replica`);
        else monitoring?.clear('app_down', `app:${app.name}`);
      }
    } catch (err) {
      console.error('Replica health check failed:', err.message);
    } finally {
      checking = false;
    }
  }

  // ---------- long operations: run in the background under the app lock, progress in op_* + events ----------
  function background(app, op, by, fn) {
    if (locks.busy(`app:${app.id}`)) throw conflict(`${app.name} is busy: ${locks.busy(`app:${app.id}`).what}`);
    setOp(app.id, op, 'running', null);
    locks.with(`app:${app.id}`, op, () => fn())
      .then((msg) => { setOp(app.id, op, 'success', msg || 'done'); event(app.id, op, msg || `${op} finished`, { by }); })
      .catch((err) => { setOp(app.id, op, 'failed', err.message); event(app.id, op, `${op} failed: ${err.message}`, { level: 'error', by }); });
  }

  async function rolling(app, by, { image } = {}) {
    const reps = q.replicas(app.id).filter((r) => r.desired === 'running');
    if (!reps.length) return 'Nothing to restart (no running replicas)';
    if (image && app.runtime === 'docker') {
      event(app.id, 'deploy', `Pulling ${image}`, { by });
      await pullImage(image);
    }
    for (const r of reps) {
      const label = r.idx === 0 ? 'primary' : `replica ${r.idx}`;
      const others = reps.filter((x) => x.id !== r.id && x.enabled && x.health !== 'unhealthy');
      if (others.length) { draining.add(r.id); await applyLb(app, `drain ${label}`, by); }
      try {
        const old = r.version || app.version || app.image;
        if (image) await startReplica(app, r, { version: image }); else await restartReplica(app, r);
        if (!(await waitHealthy(app, r))) {
          if (image) {
            event(app.id, 'deploy', `${label} did not become healthy on ${image}; rolling it back to ${old}`, { level: 'error', by });
            await startReplica(app, r, { version: old });
            await waitHealthy(app, r);
            throw new Error(`${label} failed its health check on ${image}. It was rolled back to ${old}; replicas after it were not touched.`);
          }
          throw new Error(`${label} did not become healthy after restart; stopped the rolling restart`);
        }
        if (image) db.prepare('UPDATE app_replicas SET version = ? WHERE id = ?').run(image, r.id);
        event(app.id, image ? 'deploy' : 'restart', `${label} ${image ? `now runs ${image}` : 'restarted'} and is healthy`, { by });
      } finally {
        draining.delete(r.id);
        await applyLb(q.app(app.id), `restore ${label}`, by).catch((e) => event(app.id, 'lb', `Load balancer update failed: ${e.message}`, { level: 'error' }));
      }
    }
    if (image) db.prepare('UPDATE host_apps SET version = ?, updated_at = ? WHERE id = ?').run(image, Date.now(), app.id);
    return image ? `All replicas run ${image}` : `Rolling restart of ${reps.length} replica(s) done without downtime`;
  }

  // ---------- views ----------
  async function runtimeState(app) {
    const out = {};
    try {
      if (app.runtime === 'pm2') {
        for (const p of await pm2.jlist()) {
          const m = p.name.match(/^kc-(.+)-(\d+)$/);
          if (m && m[1] === app.name) out[m[2]] = { status: p.status, pid: p.pid, cpu: p.cpu, memory: p.memory, restarts: p.restarts, uptime: p.uptime };
        }
      } else {
        const list = await dockerRequest('GET', '/containers/json', { query: { all: true, filters: { label: [`kapil.cloud.app=${app.name}`] } } });
        await Promise.all(list.map(async (c) => {
          const idx = c.Labels['kapil.cloud.replica'];
          const st = c.State === 'running' ? await containerStats(c.Id).catch(() => null) : null;
          out[idx] = { status: c.State, image: c.Image, cpu: st?.cpu ?? 0, memory: st?.memory ?? 0, id: c.Id.slice(0, 12) };
        }));
      }
    } catch (err) {
      out.error = err.message;
    }
    return out;
  }
  const view = (app) => {
    const { env_enc, ...rest } = app;
    return { ...rest, envKeys: Object.keys(envOf(app)), busy: locks.busy(`app:${app.id}`)?.what || null };
  };

  const getApp = (id) => {
    const app = q.app(Number(id));
    if (!app) throw notFound('No such application');
    return app;
  };
  const getReplica = (app, idx) => {
    const r = q.replica(app.id, Number(idx));
    if (!r) throw notFound('No such replica');
    return r;
  };
  const who = (req) => req.session.username;
  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: who(req), ip: clientIp(req), action, target, result, detail });

  function validateApp(b, existing = null) {
    const runtime = existing?.runtime || (b.runtime === 'docker' ? 'docker' : 'pm2');
    const out = { runtime };
    if (!existing) out.name = str(b.name, { max: 32, name: 'Name', re: APP_RE });
    if (runtime === 'pm2') {
      if (!existing || b.cwd !== undefined) out.cwd = allowedDir(b.cwd, 'App folder');
      if (!existing || b.script !== undefined) {
        out.script = str(b.script, { max: 200, name: 'Start script', re: /^[A-Za-z0-9._/@:-]+$/ });
        if (out.script.includes('..')) throw bad('Start script may not contain ..');
      }
      if (b.args !== undefined) out.args = b.args ? str(b.args, { max: 300, name: 'Arguments', re: /^[\w .=:/@,-]+$/ }) : null;
    } else {
      if (!existing || b.image !== undefined) out.image = str(b.image, { max: 255, name: 'Image', re: IMAGE_RE });
      if (!existing || b.containerPort !== undefined) out.container_port = int(b.containerPort, { min: 1, max: 65535, name: 'Container port' });
      if (b.cpus !== undefined) {
        out.cpus = b.cpus === '' || b.cpus == null ? null : Number(b.cpus);
        if (out.cpus != null && !(out.cpus > 0 && out.cpus <= 64)) throw bad('CPUs must be between 0.01 and 64');
      }
    }
    if (b.healthPath !== undefined || !existing) out.health_path = str(b.healthPath || '/', { max: 200, name: 'Health check path', re: /^\/[\w./?=&%-]*$/ });
    if (b.maxMemoryMb !== undefined) out.max_memory_mb = int(b.maxMemoryMb, { min: 32, max: 262144, name: 'Memory limit (MB)', optional: true });
    if (b.serverName !== undefined) {
      const names = String(b.serverName || '').trim().split(/\s+/).filter(Boolean);
      if (names.length > 10 || names.some((n) => !HOST_RE.test(n))) throw bad('Domain names must be valid hostnames, separated by spaces');
      out.server_name = names.join(' ') || null;
    }
    if (b.lbMethod !== undefined) out.lb_method = b.lbMethod === 'least_conn' ? 'least_conn' : 'weighted';
    if (b.env !== undefined) out.env = parseEnv(b.env);
    return out;
  }

  // ---------- routes ----------
  router.use(requireAdmin);

  router.get('/lb/status', wrap(async (_req, res) => {
    res.json({ ...lb.status(), nginx: await lb.nginxVersion(), connections: await lb.activeConnections() });
  }));

  router.get('/apps', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ apps: q.apps().map((a) => ({ ...view(a), replicas: q.replicas(a.id) })) });
  }));

  router.get('/apps/:id', wrap(async (req, res) => {
    const app = getApp(req.params.id);
    res.set('Cache-Control', 'no-store');
    const state = await runtimeState(app);
    const servers = lbServers(app);
    const reps = q.replicas(app.id).map((r, i) => ({ ...r, runtime: state[r.idx] || null, lbState: servers[i]?.state, draining: draining.has(r.id) }));
    res.json({ app: view(app), replicas: reps, runtimeError: state.error || null, events: q.events(app.id, 50), nginx: lb.current(app.name) });
  }));

  router.get('/apps/:id/traffic', wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const minutes = int(req.query.minutes ?? 60, { min: 5, max: 60, name: 'minutes' });
    res.set('Cache-Control', 'no-store');
    res.json({ ...lb.trafficSummary(app.name, minutes), connections: await lb.activeConnections() });
  }));

  router.get('/apps/:id/replicas/:idx/logs', wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const r = getReplica(app, req.params.idx);
    const lines = int(req.query.lines ?? 200, { min: 10, max: 2000, name: 'lines' });
    res.set('Cache-Control', 'no-store');
    if (app.runtime === 'pm2') {
      const p = (await pm2.jlist(true)).find((x) => x.name === procName(app, r.idx));
      return res.json({ logs: p ? `${tailFile(p.outLog, lines)}\n${tailFile(p.errLog, lines)}`.trim() : 'Process not found in PM2' });
    }
    const buf = await dockerRequest('GET', `/containers/${procName(app, r.idx)}/logs`, { query: { stdout: true, stderr: true, tail: lines, timestamps: true }, raw: true });
    return res.json({ logs: demux(buf) });
  }));

  router.post('/apps', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const v = validateApp(b);
    if (q.apps().some((a) => a.name === v.name)) throw conflict(`An application named ${v.name} already exists`);
    const count = int(b.replicas ?? 3, { min: 1, max: MAX_REPLICAS, name: 'Number of instances' });
    const basePort = int(b.basePort, { min: 1024, max: 65535, name: 'First port', optional: true });
    const ports = await allocate(count, REPLICA_PORTS(), { prefer: basePort });
    const lbPort = b.loadBalancer === false ? null : (await allocate(1, LB_PORTS(), { prefer: int(b.lbPort, { min: 1024, max: 65535, name: 'Load balancer port', optional: true }), exclude: new Set(ports) }))[0];
    const now = Date.now();
    const id = db.transaction(() => {
      const appId = db.prepare(`INSERT INTO host_apps (name, runtime, cwd, script, args, image, container_port, health_path, env_enc, max_memory_mb, cpus,
        lb_port, lb_method, server_name, version, created_by, created_at, updated_at)
        VALUES (@name, @runtime, @cwd, @script, @args, @image, @container_port, @health_path, @env_enc, @max_memory_mb, @cpus, @lb_port, @lb_method, @server_name, @version, @by, @now, @now)`)
        .run({
          name: v.name, runtime: v.runtime, cwd: v.cwd || null, script: v.script || null, args: v.args || null, image: v.image || null,
          container_port: v.container_port || null, health_path: v.health_path, env_enc: seal(JSON.stringify(v.env || {})),
          max_memory_mb: v.max_memory_mb || null, cpus: v.cpus || null, lb_port: lbPort, lb_method: v.lb_method || 'weighted',
          server_name: v.server_name || null, version: v.image || null, by: who(req), now,
        }).lastInsertRowid;
      ports.forEach((port, idx) => db.prepare('INSERT INTO app_replicas (app_id, idx, port, weight, version, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(appId, idx, port, 1, v.image || null, now));
      return appId;
    })();
    const app = q.app(id);
    log(req, 'hostapp_create', v.name, `${v.runtime} x${count} ports ${ports.join(',')} lb ${lbPort ?? 'none'}`);
    event(id, 'create', `Created with ${count} instance(s) on ports ${ports.join(', ')}${lbPort ? `, load balancer on 127.0.0.1:${lbPort}` : ''}`, { by: who(req) });
    background(app, 'provision', who(req), async () => {
      if (app.runtime === 'docker') await pullImage(app.image);
      const bad2 = [];
      for (const r of q.replicas(id)) {
        await startReplica(app, r);
        if (!(await waitHealthy(app, r))) bad2.push(r.idx);
      }
      await applyLb(q.app(id), 'initial configuration', who(req));
      if (bad2.length) throw new Error(`Started, but instance(s) ${bad2.join(', ')} did not pass the health check on ${app.health_path}`);
      return `All ${count} instance(s) running and healthy`;
    });
    res.status(202).json({ app: view(app) });
  }));

  router.put('/apps/:id', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const v = validateApp(req.body || {}, app);
    const cols = ['cwd', 'script', 'args', 'image', 'container_port', 'health_path', 'max_memory_mb', 'cpus', 'server_name', 'lb_method'].filter((k) => v[k] !== undefined);
    await locks.with(`app:${app.id}`, 'save settings', async () => {
      const before = { ...app };
      db.transaction(() => {
        for (const k of cols) db.prepare(`UPDATE host_apps SET ${k} = ?, updated_at = ? WHERE id = ?`).run(v[k], Date.now(), app.id);
        if (v.env) {
          const old = envOf(app);
          for (const [k, val] of Object.entries(v.env)) if (val === '********' && k in old) v.env[k] = old[k]; // masked = keep
          db.prepare('UPDATE host_apps SET env_enc = ? WHERE id = ?').run(seal(JSON.stringify(v.env)), app.id);
        }
        if (v.image) db.prepare('UPDATE host_apps SET version = ? WHERE id = ?').run(v.image, app.id);
      })();
      if (['server_name', 'lb_method'].some((k) => cols.includes(k))) {
        try { await applyLb(q.app(app.id), 'settings changed', who(req)); } catch (err) {
          db.prepare('UPDATE host_apps SET server_name = ?, lb_method = ? WHERE id = ?').run(before.server_name, before.lb_method, app.id);
          throw err;
        }
      }
    });
    log(req, 'hostapp_update', app.name, [...cols, ...(v.env ? ['env'] : [])].join(','));
    event(app.id, 'settings', `Settings changed: ${[...cols, ...(v.env ? ['environment'] : [])].join(', ')}. Restart replicas to apply process changes.`, { by: who(req) });
    res.json({ app: view(q.app(app.id)) });
  }));

  router.get('/apps/:id/env', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    // Values are never sent back: the editor shows ******** and saving that keeps the stored value
    res.json({ env: Object.fromEntries(Object.keys(envOf(app)).map((k) => [k, '********'])) });
  }));

  router.delete('/apps/:id', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    if (req.body?.confirm !== app.name) throw bad(`Type "${app.name}" exactly to confirm`);
    const reps = q.replicas(app.id);
    await locks.with(`app:${app.id}`, 'delete', async () => {
      if (app.lb_port) await lb.remove(app.name, `remove ${app.name}`);
      for (const r of reps) await removeReplica(app, r);
      db.prepare('DELETE FROM host_apps WHERE id = ?').run(app.id);
    });
    for (const r of reps) monitoring?.clear('replica_down', `app:${app.name}:${r.idx}`);
    monitoring?.clear('app_down', `app:${app.name}`);
    log(req, 'hostapp_delete', app.name);
    io.to('admin').emit('hostapp', { id: app.id, deleted: true });
    res.json({ ok: true });
  }));

  // Replica actions: start | stop | restart
  router.post('/apps/:id/replicas/:idx/:action(start|stop|restart)', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const r = getReplica(app, req.params.idx);
    const { action } = req.params;
    const label = r.idx === 0 ? 'primary' : `replica ${r.idx}`;
    await locks.with(`app:${app.id}`, `${action} ${label}`, async () => {
      if (action === 'stop') {
        db.prepare("UPDATE app_replicas SET desired = 'stopped', health = 'unknown', fails = 0, oks = 0 WHERE id = ?").run(r.id);
        await applyLb(q.app(app.id), `stop ${label}`, who(req)); // out of traffic first
        await stopReplica(app, r);
        monitoring?.clear('replica_down', `app:${app.name}:${r.idx}`);
      } else {
        db.prepare("UPDATE app_replicas SET desired = 'running' WHERE id = ?").run(r.id);
        if (action === 'start') await startReplica(app, r); else await restartReplica(app, r);
        await waitHealthy(app, r);
        await applyLb(q.app(app.id), `${action} ${label}`, who(req));
      }
    });
    log(req, `replica_${action}`, `${app.name}/${r.idx}`);
    event(app.id, 'replica', `${label} ${action === 'stop' ? 'stopped' : `${action}ed`}`, { by: who(req) });
    res.json({ replica: q.replica(app.id, r.idx) });
  }));

  router.post('/apps/:id/replicas', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const reps = q.replicas(app.id);
    if (reps.length >= MAX_REPLICAS) throw bad(`At most ${MAX_REPLICAS} instances per application`);
    const [port] = await allocate(1, REPLICA_PORTS(), { prefer: int(req.body?.port, { min: 1024, max: 65535, name: 'Port', optional: true }) });
    const idx = Math.max(-1, ...reps.map((r) => r.idx)) + 1;
    const weight = int(req.body?.weight ?? 1, { min: 0, max: 100, name: 'Traffic weight' });
    db.prepare('INSERT INTO app_replicas (app_id, idx, port, weight, version, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(app.id, idx, port, weight, app.version, Date.now());
    log(req, 'replica_add', `${app.name}/${idx}`, `port ${port}`);
    event(app.id, 'replica', `Replica ${idx} added on port ${port}`, { by: who(req) });
    background(app, 'add replica', who(req), async () => {
      const r = q.replica(app.id, idx);
      await startReplica(app, r);
      const ok = await waitHealthy(app, r);
      await applyLb(q.app(app.id), `add replica ${idx}`, who(req));
      if (!ok) throw new Error(`Replica ${idx} started but is not healthy yet; it gets traffic once it passes ${app.health_path}`);
      return `Replica ${idx} is healthy and receiving traffic`;
    });
    res.status(202).json({ ok: true, idx, port });
  }));

  router.delete('/apps/:id/replicas/:idx', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const r = getReplica(app, req.params.idx);
    if (q.replicas(app.id).length === 1) throw bad('This is the last instance. Delete the application instead.');
    const label = r.idx === 0 ? 'primary' : `replica ${r.idx}`;
    if (req.body?.confirm !== label) throw bad(`Type "${label}" exactly to confirm`);
    await locks.with(`app:${app.id}`, `remove ${label}`, async () => {
      db.prepare("UPDATE app_replicas SET enabled = 0, desired = 'stopped' WHERE id = ?").run(r.id);
      await applyLb(q.app(app.id), `remove ${label}`, who(req));
      await removeReplica(app, r);
      db.prepare('DELETE FROM app_replicas WHERE id = ?').run(r.id);
      await applyLb(q.app(app.id), `removed ${label}`, who(req));
    });
    monitoring?.clear('replica_down', `app:${app.name}:${r.idx}`);
    log(req, 'replica_remove', `${app.name}/${r.idx}`);
    event(app.id, 'replica', `${label} (port ${r.port}) removed`, { by: who(req) });
    res.json({ ok: true });
  }));

  // Traffic switching: { replicas: [{ idx, weight (0-100; 0 = standby), enabled }] }. Applied atomically; rolled back if nginx refuses.
  router.put('/apps/:id/traffic', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const list = Array.isArray(req.body?.replicas) ? req.body.replicas : [];
    if (!list.length) throw bad('replicas is required');
    const reps = q.replicas(app.id);
    const changes = list.map((x) => {
      const r = reps.find((y) => y.idx === Number(x.idx));
      if (!r) throw bad(`No replica ${x.idx}`);
      return { r, weight: x.weight === undefined ? r.weight : int(x.weight, { min: 0, max: 100, name: 'Weight' }), enabled: x.enabled === undefined ? r.enabled : x.enabled ? 1 : 0 };
    });
    const after = reps.map((r) => changes.find((c) => c.r.id === r.id) || { r, weight: r.weight, enabled: r.enabled });
    if (!after.some((c) => c.enabled && c.weight > 0 && c.r.desired === 'running')) throw bad('At least one running instance must stay enabled with a traffic share above 0');
    await locks.with(`app:${app.id}`, 'traffic switch', async () => {
      const save = db.transaction((rows) => { for (const c of rows) db.prepare('UPDATE app_replicas SET weight = ?, enabled = ? WHERE id = ?').run(c.weight, c.enabled, c.r.id); });
      save(changes);
      try {
        await applyLb(q.app(app.id), 'traffic switch', who(req));
      } catch (err) {
        save(changes.map((c) => ({ r: c.r, weight: c.r.weight, enabled: c.r.enabled }))); // nginx refused: keep the DB matching nginx
        throw err;
      }
    });
    const total = after.filter((c) => c.enabled && c.weight > 0).reduce((s, c) => s + c.weight, 0);
    const desc = after.map((c) => `${c.r.idx === 0 ? 'primary' : `r${c.r.idx}`}=${!c.enabled ? 'off' : c.weight === 0 ? 'standby' : `${Math.round((c.weight / total) * 100)}%`}`).join(' ');
    log(req, 'traffic_switch', app.name, desc);
    event(app.id, 'traffic', `Traffic: ${desc}`, { by: who(req) });
    res.json({ replicas: q.replicas(app.id) });
  }));

  // Zero-downtime rolling restart, or rolling update to a new image (Docker) with automatic per-replica rollback
  router.post('/apps/:id/rolling', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const image = req.body?.image ? str(req.body.image, { max: 255, name: 'Image', re: IMAGE_RE }) : null;
    if (image && app.runtime !== 'docker') throw bad('New images are only for Docker applications. For PM2, update the code in the app folder, then do a rolling restart.');
    background(app, image ? 'rolling update' : 'rolling restart', who(req), () => rolling(app, who(req), { image }));
    log(req, image ? 'hostapp_update_image' : 'hostapp_rolling_restart', app.name, image);
    res.status(202).json({ ok: true });
  }));

  // Re-write the Nginx config from the database (e.g. after the LB was installed)
  router.post('/apps/:id/lb/apply', requireSuperAdmin, wrap(async (req, res) => {
    const app = getApp(req.params.id);
    const r = await applyLb(app, 'manual apply', who(req));
    log(req, 'lb_apply', app.name);
    res.json(r);
  }));

  // ---------- start ----------
  let timer = null;
  function start() {
    const loop = () => healthLoop().finally(() => { timer = setTimeout(loop, HEALTH_INTERVAL()); timer.unref?.(); });
    timer = setTimeout(loop, 2000);
    timer.unref?.();
    // An operation that was running when the panel stopped did not finish
    db.prepare("UPDATE host_apps SET op_status = 'failed', op_message = 'Interrupted: the panel restarted during this operation' WHERE op_status = 'running'").run();
  }
  function counts() {
    return {
      apps: db.prepare('SELECT COUNT(*) AS n FROM host_apps').get().n,
      replicas: db.prepare("SELECT COUNT(*) AS n FROM app_replicas WHERE desired = 'running'").get().n,
      healthy: db.prepare("SELECT COUNT(*) AS n FROM app_replicas WHERE desired = 'running' AND health = 'healthy'").get().n,
    };
  }

  return { router, start, counts, stop: () => clearTimeout(timer) };
}

