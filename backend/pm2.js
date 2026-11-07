// PM2Service: the host's PM2 (the panel user's PM2 daemon). Admins can look; only a super admin changes anything.
// Every command is `pm2 <fixed verb> <validated id>` through hostRun (no shell). Logs are read from PM2's own log files.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { hostRun, locks, allowedDir, parseEnv, tailFile } from './hostexec.js';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { audit } from './db.js';
import { wrap, bad, notFound, int, str, HttpError } from './http.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createPm2({ dataDir }) {
  const router = express.Router();
  const ecoDir = path.join(dataDir, 'pm2');
  let cache = { at: 0, list: null, error: null };

  async function jlist(force = false) {
    if (!force && cache.list && Date.now() - cache.at < 2000) return cache.list;
    const r = await hostRun('pm2', ['jlist'], { timeout: 20_000 });
    if (!r.ok) {
      cache = { at: Date.now(), list: null, error: r.error || r.stderr.trim().slice(0, 300) || 'pm2 jlist failed' };
      throw new HttpError(503, `PM2 is not available: ${cache.error}`);
    }
    const start = r.stdout.indexOf('[');
    const raw = start < 0 ? [] : JSON.parse(r.stdout.slice(start));
    const list = raw.map((p) => {
      const e = p.pm2_env || {};
      const env = e.env || {};
      return {
        id: p.pm_id, name: p.name, pid: p.pid || null, status: e.status, mode: e.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
        instances: e.instances ?? 1, cpu: p.monit?.cpu ?? 0, memory: p.monit?.memory ?? 0, restarts: e.restart_time ?? 0,
        uptime: e.status === 'online' ? e.pm_uptime ?? null : null, createdAt: e.created_at ?? null,
        port: Number(env.PORT || e.PORT) || null, cwd: e.pm_cwd || null, script: e.pm_exec_path || null,
        interpreter: e.exec_interpreter || null, version: e.version && e.version !== 'N/A' ? e.version : null,
        node: e.node_version || null, maxMemory: e.max_memory_restart || null, watch: !!e.watch,
        managed: String(p.name).startsWith('kc-'), self: p.pid === process.pid || (process.env.pm_id !== undefined && String(p.pm_id) === String(process.env.pm_id)), outLog: e.pm_out_log_path || null, errLog: e.pm_err_log_path || null,
      };
    });
    cache = { at: Date.now(), list, error: null };
    return list;
  }

  async function find(idOrName) {
    const list = await jlist(true);
    const p = list.filter((x) => String(x.id) === String(idOrName) || x.name === idOrName);
    if (!p.length) throw notFound('No such PM2 process');
    return p[0];
  }

  async function pm2(args, what) {
    const r = await hostRun('pm2', args, { timeout: 60_000 });
    cache.at = 0;
    if (!r.ok) throw new HttpError(502, `${what} failed: ${(r.error || r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
    return r;
  }

  // The panel's own PM2 process: stopping or deleting it from the panel would cut off the panel itself
  const isSelf = (p) => p.pid === process.pid || (process.env.pm_id !== undefined && String(p.id) === String(process.env.pm_id));
  const guardSelf = (p, action) => {
    if (isSelf(p) && ['stop', 'delete'].includes(action)) throw bad(`${p.name} is this panel. Stopping it from here would lock you out; use the server's shell (pm2 ${action} ${p.name}).`);
  };

  const log = (req, action, target, result = 'success', detail = null) =>
    audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });

  // Start (or replace) one PM2 app from a generated ecosystem file. Used by this router and by replicas.js.
  async function startApp(def) {
    fs.mkdirSync(ecoDir, { recursive: true, mode: 0o700 });
    const file = path.join(ecoDir, `${def.name}.config.json`);
    fs.writeFileSync(file, JSON.stringify({ apps: [def] }, null, 2), { mode: 0o600 }); // env may hold secrets
    await pm2(['delete', def.name], 'delete').catch(() => {});
    return pm2(['start', file], `start ${def.name}`);
  }

  router.use(requireAdmin);

  router.get('/processes', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const list = await jlist();
    res.json({ processes: list.map(({ outLog, errLog, ...p }) => p) });
  }));

  router.get('/processes/:id', wrap(async (req, res) => {
    const { outLog, errLog, ...p } = await find(req.params.id);
    res.json({ process: p });
  }));

  router.get('/processes/:id/logs', wrap(async (req, res) => {
    const p = await find(req.params.id);
    const lines = int(req.query.lines ?? 200, { min: 10, max: 2000, name: 'lines' });
    res.set('Cache-Control', 'no-store');
    res.json({ out: p.outLog ? tailFile(p.outLog, lines) : '', err: p.errLog ? tailFile(p.errLog, lines) : '' });
  }));

  router.post('/processes/:id/:action(start|stop|restart|reload|flush)', requireSuperAdmin, wrap(async (req, res) => {
    const { action } = req.params;
    const p = await find(req.params.id);
    guardSelf(p, action);
    await locks.with(`pm2:${p.name}`, `${action} ${p.name}`, () => pm2([action, String(p.id)], `${action} ${p.name}`));
    log(req, `pm2_${action}`, p.name);
    res.json({ ok: true });
  }));

  router.post('/processes/:id/scale', requireSuperAdmin, wrap(async (req, res) => {
    const p = await find(req.params.id);
    if (p.mode !== 'cluster') throw bad('Only cluster-mode apps can be scaled. Start it with instances > 1 (cluster mode).');
    const n = int(req.body?.instances, { min: 1, max: 32, name: 'instances' });
    await locks.with(`pm2:${p.name}`, `scale ${p.name}`, () => pm2(['scale', p.name, String(n)], `scale ${p.name}`));
    log(req, 'pm2_scale', p.name, 'success', `instances=${n}`);
    res.json({ ok: true });
  }));

  router.delete('/processes/:id', requireSuperAdmin, wrap(async (req, res) => {
    const p = await find(req.params.id);
    if (req.body?.confirm !== p.name) throw bad(`Type "${p.name}" exactly to confirm`);
    guardSelf(p, 'delete');
    if (p.managed) throw bad('This process belongs to a Kapil Cloud application. Remove the replica from the Applications page.');
    await locks.with(`pm2:${p.name}`, `delete ${p.name}`, () => pm2(['delete', String(p.id)], `delete ${p.name}`));
    log(req, 'pm2_delete', p.name);
    res.json({ ok: true });
  }));

  // New PM2 app from a folder on the host
  router.post('/processes', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 64, name: 'Name', re: NAME_RE });
    if (name.startsWith('kc-')) throw bad('Names starting with kc- are reserved for Kapil Cloud replicas');
    const cwd = allowedDir(b.cwd, 'Working folder');
    const script = str(b.script, { max: 200, name: 'Script', re: /^[A-Za-z0-9._/@:-]+$/ });
    if (script.includes('..')) throw bad('Script may not contain ..');
    const args = b.args ? str(b.args, { max: 300, name: 'Arguments', re: /^[\w .=:/@,-]+$/ }) : undefined;
    const instances = int(b.instances ?? 1, { min: 1, max: 32, name: 'Instances' });
    const maxMemoryMb = int(b.maxMemoryMb, { min: 32, max: 65536, name: 'Memory limit (MB)', optional: true });
    const env = parseEnv(b.env);
    if (b.port) env.PORT = String(int(b.port, { min: 1024, max: 65535, name: 'Port' }));
    if ((await jlist(true)).some((p) => p.name === name)) throw bad(`A PM2 process named ${name} already exists`);
    const def = {
      name, cwd, script, args, env, instances, exec_mode: b.mode === 'cluster' || instances > 1 ? 'cluster' : 'fork',
      ...(maxMemoryMb ? { max_memory_restart: `${maxMemoryMb}M` } : {}), time: true, autorestart: true,
    };
    await locks.with(`pm2:${name}`, `start ${name}`, () => startApp(def));
    log(req, 'pm2_create', name, 'success', `${cwd}/${script} x${instances}`);
    res.status(201).json({ ok: true });
  }));

  router.post('/save', requireSuperAdmin, wrap(async (req, res) => {
    await locks.with('pm2:global', 'pm2 save', () => pm2(['save'], 'pm2 save'));
    log(req, 'pm2_save', 'pm2');
    res.json({ ok: true });
  }));

  router.post('/resurrect', requireSuperAdmin, wrap(async (req, res) => {
    await locks.with('pm2:global', 'pm2 resurrect', () => pm2(['resurrect'], 'pm2 resurrect'));
    log(req, 'pm2_resurrect', 'pm2');
    res.json({ ok: true });
  }));

  return { router, jlist, startApp, pm2 };
}
