// Databases: PostgreSQL, MySQL and MongoDB as Docker containers on the master host.
//
// Each database is one container (kdb-<name>) with one named volume (kdb-<name>-data), created with the Docker manager's
// safety rules (no privileges, no-new-privileges, no host mounts). Its port is published on 127.0.0.1 only, or on the LXD
// bridge address when LXD containers must reach it. It is never published on a public interface.
// Passwords are generated here, stored AES-256-GCM encrypted and shown only to a super admin (audited).
// The backup helper dumps these containers by itself (it finds them by image and uses the official env variables).
import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { db, audit } from './db.js';
import { seal, open as unseal } from './secrets.js';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { dockerRequest, safeCreateBody, pullImage, demux } from './docker.js';
import { locks } from './hostexec.js';
import { listNetworks } from './lxd.js';
import { wrap, bad, notFound, conflict, int, str } from './http.js';

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const IDENT_RE = /^[a-z_][a-z0-9_]{0,30}$/;
const LABEL = 'kapil.cloud.db';

export const ENGINES = {
  postgres: {
    label: 'PostgreSQL', port: 5432, mount: '/var/lib/postgresql/data',
    versions: { 17: 'postgres:17-alpine', 16: 'postgres:16-alpine', 15: 'postgres:15-alpine' },
    env: (d) => ({ POSTGRES_USER: d.user, POSTGRES_PASSWORD: d.password, POSTGRES_DB: d.dbName }),
    url: (d) => `postgresql://${d.user}:${d.password}@${d.host}:${d.port}/${d.dbName}`,
  },
  mysql: {
    label: 'MySQL', port: 3306, mount: '/var/lib/mysql',
    versions: { '8.4': 'mysql:8.4', '8.0': 'mysql:8.0' },
    env: (d) => ({ MYSQL_ROOT_PASSWORD: d.rootPassword, MYSQL_DATABASE: d.dbName, MYSQL_USER: d.user, MYSQL_PASSWORD: d.password }),
    url: (d) => `mysql://${d.user}:${d.password}@${d.host}:${d.port}/${d.dbName}`,
  },
  mongo: {
    label: 'MongoDB', port: 27017, mount: '/data/db',
    versions: { 8: 'mongo:8', 7: 'mongo:7' },
    env: (d) => ({ MONGO_INITDB_ROOT_USERNAME: d.user, MONGO_INITDB_ROOT_PASSWORD: d.password, MONGO_INITDB_DATABASE: d.dbName }),
    url: (d) => `mongodb://${d.user}:${d.password}@${d.host}:${d.port}/${d.dbName}?authSource=admin`,
  },
};

function portRange() {
  const m = /^(\d+)-(\d+)$/.exec(process.env.DB_PORTS || '15400-15999');
  const [lo, hi] = m ? [Number(m[1]), Number(m[2])] : [15400, 15999];
  if (!(lo >= 1024 && hi <= 65535 && lo <= hi)) throw new Error('DB_PORTS must look like 15400-15999');
  return [lo, hi];
}

const listening = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(800, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});

// IPv4 address of the managed LXD bridge (e.g. 10.10.10.1), if there is one
async function bridgeAddress() {
  try {
    const nets = await listNetworks();
    const br = nets.find((n) => n.managed && n.type === 'bridge' && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(n.config?.['ipv4.address'] || ''));
    return br ? { network: br.name, ip: br.config['ipv4.address'].split('/')[0] } : null;
  } catch {
    return null;
  }
}

const password = () => crypto.randomBytes(18).toString('base64url');
const view = (r, live) => ({
  id: r.id, name: r.name, engine: r.engine, engineLabel: ENGINES[r.engine]?.label, version: r.version, image: r.image,
  container: r.container, volume: r.volume, port: r.port, bindIp: r.bind_ip, dbName: r.db_name, user: r.db_user,
  memoryMb: r.memory_mb, status: r.status, error: r.error, notes: r.notes, createdBy: r.created_by, createdAt: r.created_at,
  state: live?.State || null, dockerStatus: live?.Status || null,
});

export function createDatabases() {
  const router = express.Router();
  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });
  const rows = () => db.prepare('SELECT * FROM databases ORDER BY name').all();
  const getRow = (id) => { const r = db.prepare('SELECT * FROM databases WHERE id = ?').get(Number(id)); if (!r) throw notFound('No such database'); return r; };
  const setStatus = (id, status, error = null) => db.prepare('UPDATE databases SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, Date.now(), id);

  async function liveContainers() {
    const list = await dockerRequest('GET', '/containers/json', { query: { all: true, filters: { label: [LABEL] } } });
    return Object.fromEntries(list.map((c) => [c.Labels?.[LABEL], c]));
  }

  async function freePort() {
    const [lo, hi] = portRange();
    const taken = new Set(db.prepare('SELECT port FROM databases').all().map((r) => r.port));
    const docker = await dockerRequest('GET', '/containers/json', { query: { all: true } }).catch(() => []);
    for (const c of docker) for (const p of c.Ports || []) if (p.PublicPort) taken.add(p.PublicPort);
    for (let p = lo; p <= hi; p += 1) {
      if (taken.has(p)) continue;
      if (await listening('127.0.0.1', p)) continue;
      return p;
    }
    throw conflict(`No free port left in DB_PORTS (${lo}-${hi})`);
  }

  // Creates the volume + container in the background; the row says how far it got
  function build(row, secrets) {
    const e = ENGINES[row.engine];
    return locks.with(`db:${row.name}`, `create database ${row.name}`, async () => {
      try {
        setStatus(row.id, 'pulling');
        await pullImage(row.image);
        setStatus(row.id, 'creating');
        await dockerRequest('POST', '/volumes/create', { body: { Name: row.volume, Labels: { [LABEL]: row.name } } });
        const body = safeCreateBody({
          image: row.image,
          env: e.env({ user: row.db_user, dbName: row.db_name, ...secrets }),
          ports: [{ host: row.port, container: e.port, hostIp: row.bind_ip }],
          volumes: [{ source: row.volume, target: e.mount }],
          memoryMb: row.memory_mb || undefined,
          labels: { [LABEL]: row.name, 'kapil.cloud.engine': row.engine },
        });
        const made = await dockerRequest('POST', '/containers/create', { query: { name: row.container }, body });
        await dockerRequest('POST', `/containers/${made.Id}/start`, { timeout: 60_000 });
        setStatus(row.id, 'ready');
        audit.log({ username: row.created_by, action: 'database_ready', target: row.name, result: 'success', detail: `${row.image} on ${row.bind_ip}:${row.port}` });
      } catch (err) {
        setStatus(row.id, 'error', err.message.slice(0, 500));
        audit.log({ username: row.created_by, action: 'database_ready', target: row.name, result: 'failure', detail: err.message.slice(0, 300) });
        // a half-made container must not hold the name; the volume (maybe with data) is kept
        await dockerRequest('DELETE', `/containers/${row.container}`, { query: { force: true } }).catch(() => {});
      }
    });
  }

  router.use(requireAdmin);

  router.get('/options', wrap(async (_req, res) => {
    const bridge = await bridgeAddress();
    res.json({
      engines: Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, { label: e.label, port: e.port, versions: Object.keys(e.versions).sort((a, b) => Number(b) - Number(a)) }])),
      access: [{ id: 'local', label: 'This server only (127.0.0.1)' }, ...(bridge ? [{ id: 'containers', label: `This server and LXD containers (${bridge.ip})` }] : [])],
      ports: portRange(),
    });
  }));

  router.get('/', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let live = {};
    let dockerError = null;
    try { live = await liveContainers(); } catch (e) { dockerError = e.message; }
    res.json({ databases: rows().map((r) => view(r, live[r.name])), dockerError });
  }));

  router.post('/', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 32, name: 'Name', re: NAME_RE });
    const e = ENGINES[b.engine];
    if (!e) throw bad('Engine must be postgres, mysql or mongo');
    const version = String(b.version ?? Object.keys(e.versions).sort((x, y) => Number(y) - Number(x))[0]);
    const image = e.versions[version];
    if (!image) throw bad(`${e.label} version must be one of ${Object.keys(e.versions).join(', ')}`);
    const dbName = b.dbName ? str(b.dbName, { max: 31, name: 'Database name', re: IDENT_RE }) : 'app';
    const user = b.user ? str(b.user, { max: 31, name: 'User', re: IDENT_RE }) : 'app';
    if (b.engine === 'mysql' && user === 'root') throw bad('Pick another user name: MySQL already has root');
    const memoryMb = int(b.memoryMb, { min: 128, max: 65536, name: 'Memory (MB)', optional: true }) || null;
    let bindIp = '127.0.0.1';
    if (b.access === 'containers') {
      const bridge = await bridgeAddress();
      if (!bridge) throw bad('No managed LXD bridge found, so LXD containers cannot be given access');
      bindIp = bridge.ip;
    } else if (b.access && b.access !== 'local') throw bad('Access must be local or containers');
    if (db.prepare('SELECT 1 FROM databases WHERE name = ?').get(name)) throw conflict(`A database named ${name} already exists`);
    const container = `kdb-${name}`;
    const existing = await dockerRequest('GET', `/containers/${container}/json`).catch((err) => (err.status === 404 ? null : Promise.reject(err)));
    if (existing) throw conflict(`A Docker container named ${container} already exists`);

    const secrets = { password: password(), rootPassword: b.engine === 'mysql' ? password() : undefined };
    const port = await freePort();
    const now = Date.now();
    const id = db.prepare(`INSERT INTO databases (name, engine, version, image, container, volume, port, bind_ip, db_name, db_user, password_enc,
      root_password_enc, memory_mb, status, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(name, b.engine, version, image, container, `kdb-${name}-data`, port, bindIp, dbName, user, seal(secrets.password),
        secrets.rootPassword ? seal(secrets.rootPassword) : null, memoryMb, b.notes ? str(b.notes, { max: 300, name: 'Notes', re: /^[^<>]*$/ }) : null,
        req.session.username, now, now).lastInsertRowid;
    log(req, 'database_create', name, `${image} ${bindIp}:${port}`);
    const row = getRow(id);
    build(row, secrets).catch(() => {});
    res.status(202).json({ database: view(row) });
  }));

  // Connection details incl. password: super admin only, and every look is audited
  router.get('/:id/credentials', requireSuperAdmin, (req, res) => {
    const r = getRow(req.params.id);
    const d = { user: r.db_user, password: unseal(r.password_enc), host: r.bind_ip, port: r.port, dbName: r.db_name };
    log(req, 'database_credentials_view', r.name);
    res.set('Cache-Control', 'no-store');
    res.json({
      ...d, url: ENGINES[r.engine].url(d),
      rootPassword: r.root_password_enc ? unseal(r.root_password_enc) : null,
      note: r.bind_ip === '127.0.0.1' ? 'Reachable from this server only. Apps in LXD containers need "LXD containers" access.' : `Reachable from this server and LXD containers via ${r.bind_ip}.`,
    });
  });

  for (const action of ['start', 'stop', 'restart']) {
    router.post(`/:id/${action}`, requireSuperAdmin, wrap(async (req, res) => {
      const r = getRow(req.params.id);
      if (!['ready', 'error'].includes(r.status)) throw conflict(`${r.name} is still being created`);
      await locks.with(`db:${r.name}`, `${action} ${r.name}`, () => dockerRequest('POST', `/containers/${r.container}/${action}`, { query: action === 'start' ? undefined : { t: 30 }, timeout: 90_000 })
        .catch((err) => { if (err.status !== 304) throw err; }));
      log(req, `database_${action}`, r.name);
      res.json({ ok: true });
    }));
  }

  router.get('/:id/logs', wrap(async (req, res) => {
    const r = getRow(req.params.id);
    const buf = await dockerRequest('GET', `/containers/${r.container}/logs`, { query: { stdout: true, stderr: true, tail: 300, timestamps: true }, raw: true });
    res.set('Cache-Control', 'no-store');
    res.json({ logs: demux(buf) });
  }));

  // Delete: typed name; the data volume is kept unless deleteData is set (then it is gone for good)
  router.delete('/:id', requireSuperAdmin, wrap(async (req, res) => {
    const r = getRow(req.params.id);
    if (req.body?.confirm !== r.name) throw bad(`Type "${r.name}" exactly to confirm`);
    if (['queued', 'pulling', 'creating'].includes(r.status)) throw conflict(`${r.name} is still being created. Wait until it is ready or failed.`);
    const deleteData = req.body?.deleteData === true;
    await locks.with(`db:${r.name}`, `delete ${r.name}`, async () => {
      await dockerRequest('DELETE', `/containers/${r.container}`, { query: { force: true } }).catch((err) => { if (err.status !== 404) throw err; });
      if (deleteData) await dockerRequest('DELETE', `/volumes/${r.volume}`).catch((err) => { if (err.status !== 404) throw err; });
      db.prepare('DELETE FROM databases WHERE id = ?').run(r.id);
    });
    log(req, 'database_delete', r.name, deleteData ? `container and volume ${r.volume} deleted` : `container deleted, volume ${r.volume} kept`);
    res.json({ ok: true, keptVolume: deleteData ? null : r.volume });
  }));

  return { router };
}
