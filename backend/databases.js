// Databases: PostgreSQL, MySQL and MongoDB as Docker containers on the master host.
//
// Each database is one container (kdb-<name>) with one named volume (kdb-<name>-data), created with the Docker manager's
// safety rules (no privileges, no-new-privileges, no host mounts). Its port is published on 127.0.0.1 only, or on the LXD
// bridge address when LXD containers must reach it. It is never published on a public interface.
// Passwords are generated here, stored AES-256-GCM encrypted and shown only to a super admin (audited).
// The backup helper dumps these containers by itself (it finds them by image and uses the official env variables).
import express from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { sshRun } from './sshexec.js';
import { customerServers } from './myservers.js';
import net from 'node:net';
import { db, audit } from './db.js';
import { seal, open as unseal } from './secrets.js';
import { isAdmin, isSuperAdmin, clientIp } from './auth.js';
import { plans } from './billing.js';
import { dockerRequest, safeCreateBody, pullImage, demux, containerStats } from './docker.js';
import { locks } from './hostexec.js';
import { listNetworks } from './lxd.js';
import { wrap, bad, forbidden, notFound, conflict, int, str } from './http.js';

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
  // Password from the environment (not the command line), append-only file for durability
  redis: {
    label: 'Redis', port: 6379, mount: '/data',
    versions: { 8: 'redis:8-alpine', 7: 'redis:7-alpine' },
    env: (d) => ({ REDIS_PASSWORD: d.password }),
    cmd: ['sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'],
    url: (d) => `redis://default:${d.password}@${d.host}:${d.port}/0`,
  },
};

// Fixed scripts run inside the database container (docker exec). Credentials come from the container's own env.
export const DUMP = {
  postgres: { ext: 'sql', script: 'exec pg_dumpall -U "${POSTGRES_USER:-postgres}"' },
  mysql: { ext: 'sql', script: 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump -uroot --all-databases --single-transaction --routines --events' },
  mongo: { ext: 'archive', script: 'exec mongodump --archive --authenticationDatabase admin -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"' },
  redis: { ext: 'rdb', script: 'export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli --rdb /dev/stdout' },
};
export const RESTORE = {
  postgres: 'exec psql -q -U "${POSTGRES_USER:-postgres}" -d postgres',
  mysql: 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot',
  mongo: 'exec mongorestore --archive --drop --authenticationDatabase admin -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"',
};
const DOCKER_CLI = process.env.DOCKER_CLI || 'docker';
const dockerCliEnv = () => ({ ...process.env, ...(process.env.DOCKER_SOCKET ? { DOCKER_HOST: `unix://${process.env.DOCKER_SOCKET}` } : {}) });

// Database on a CUSTOMER's VPS: Docker there, port on 127.0.0.1 of that server only. Values arrive as env (stdin).
const VPS_DB_SCRIPT = `set -eu
command -v docker >/dev/null || { echo "Docker is not installed on this server. Run Prepare (My VPS servers) first."; exit 30; }
# The SSH user may run Docker directly (docker group) or through passwordless sudo
D=docker
docker info >/dev/null 2>&1 || D="sudo -n docker"
case "$DB_OP" in
  create)
    if $D inspect "$DB_CONTAINER" >/dev/null 2>&1; then echo "A container named $DB_CONTAINER already exists on this server"; exit 31; fi
    $D volume create --label kapil.cloud.db="$DB_NAME" "$DB_VOLUME" >/dev/null
    F=$(mktemp); chmod 600 "$F"; printf '%s' "$DB_ENV_B64" | base64 -d > "$F"
    set -- $D run -d --name "$DB_CONTAINER" --restart unless-stopped --env-file "$F" -p "127.0.0.1:$DB_PORT:$DB_INNER_PORT" \
      -v "$DB_VOLUME:$DB_MOUNT" --label kapil.cloud.db="$DB_NAME" --security-opt no-new-privileges
    [ -z "\${DB_MEMORY:-}" ] || set -- "$@" --memory "$DB_MEMORY"
    if [ "$DB_ENGINE" = redis ]; then "$@" "$DB_IMAGE" sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes' >/dev/null
    else "$@" "$DB_IMAGE" >/dev/null; fi
    rm -f "$F"; echo "@@READY" ;;
  start|stop|restart) $D "$DB_OP" "$DB_CONTAINER" >/dev/null ;;
  logs) $D logs --tail 300 --timestamps "$DB_CONTAINER" 2>&1 || true ;;
  stats) $D stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' "$DB_CONTAINER" 2>/dev/null || true
         echo "@@STATE $($D inspect -f '{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo missing)" ;;
  delete) $D rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
          if [ "$DB_DELETE_DATA" = 1 ]; then $D volume rm "$DB_VOLUME" >/dev/null 2>&1 || true; fi ;;
esac
`;
const toBytes = (txt) => { const m = /([\d.]+)\s*([KMG]i?B|B|kB|MB|GB)/.exec(txt || ''); if (!m) return 0; const u = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824 }[m[2]] || 1; return Math.round(Number(m[1]) * u); };

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
  memoryMb: r.memory_mb, status: r.status, error: r.error, notes: r.notes, createdBy: r.created_by, createdAt: r.created_at, ownerId: r.owner_id ?? null,
  target: r.target || 'main', serverId: r.server_id ?? null, serverName: r.server_id ? customerServers.get(r.server_id)?.name || '(removed)' : null,
  state: live?.State || null, dockerStatus: live?.Status || null,
});

// Super admins manage every database; plain admins read them; users see and manage only their own (owner_id).
export function createDatabases({ billing = null } = {}) {
  const router = express.Router();
  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });
  const rows = () => db.prepare('SELECT * FROM databases ORDER BY name').all();
  const getRow = (id) => { const r = db.prepare('SELECT * FROM databases WHERE id = ?').get(Number(id)); if (!r) throw notFound('No such database'); return r; };
  // Row the session may READ (admins: all; users: own, others look missing)
  const readable = (req, id) => {
    const r = getRow(id);
    if (!isAdmin(req.session) && r.owner_id !== req.session.id) throw notFound('No such database');
    return r;
  };
  // Row the session may CHANGE (super admin, or its owner)
  const writable = (req, id) => {
    const r = readable(req, id);
    if (isAdmin(req.session) && !isSuperAdmin(req.session)) throw forbidden('Only a super admin can do this');
    return r;
  };
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
          cmd: e.cmd,
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

  router.get('/options', wrap(async (_req, res) => {
    const bridge = await bridgeAddress();
    res.json({
      engines: Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, { label: e.label, port: e.port, versions: Object.keys(e.versions).sort((a, b) => Number(b) - Number(a)), restore: !!RESTORE[k] }])),
      access: [{ id: 'local', label: 'This server only (127.0.0.1)' }, ...(bridge ? [{ id: 'containers', label: `This server and LXD containers (${bridge.ip})` }] : [])],
      plans: plans.list({ kind: 'database', activeOnly: true }).map((p) => ({ id: p.id, name: p.name, memoryMb: p.memory_mb, priceDay: p.price_day, description: p.description })),
      ports: portRange(),
    });
  }));

  router.get('/', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let live = {};
    let dockerError = null;
    try { live = await liveContainers(); } catch (e) { dockerError = e.message; }
    const list = isAdmin(req.session) ? rows() : rows().filter((r) => r.owner_id === req.session.id);
    res.json({ databases: list.map((r) => view(r, r.target === 'vps' ? { State: r.status === 'ready' ? 'running' : null } : live[r.name])), dockerError: isAdmin(req.session) ? dockerError : (dockerError ? 'Databases are not available right now' : null) });
  }));

  // Super admin: any size. Users: an active database plan (sets memory + daily price), reachable from their LXD servers.
  router.post('/', wrap(async (req, res) => {
    const b = { ...(req.body || {}) };
    if (b.target === 'vps') return createOnVps(req, res, b);
    if (b.target && b.target !== 'main') throw bad('Target must be main or vps');
    const self = !isAdmin(req.session);
    if (!self && !isSuperAdmin(req.session)) throw forbidden('Only a super admin can do this');
    let plan = null;
    if (b.planId !== undefined && b.planId !== null && b.planId !== '') {
      plan = plans.get(int(b.planId, { min: 1, max: 1e9, name: 'Plan' }));
      if (!plan || plan.kind !== 'database' || (self && !plan.active)) throw bad('Pick an available database plan');
      b.memoryMb = plan.memory_mb;
    }
    if (self) {
      if (!plan) throw bad('Pick a plan');
      b.access = 'containers';
      b.ownerId = req.session.id;
    }
    const owner = b.ownerId ? db.prepare("SELECT id, role FROM users WHERE id = ? AND role = 'user'").get(int(b.ownerId, { min: 1, max: 1e9, name: 'Owner' })) : null;
    if (b.ownerId && !owner) throw bad('Owner must be a user account');
    const priceDay = plan ? plan.price_day : null;
    const name = str(b.name, { max: 32, name: 'Name', re: NAME_RE });
    const e = ENGINES[b.engine];
    if (!e) throw bad('Engine must be postgres, mysql, mongo or redis');
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

    if (self && priceDay != null) billing?.assertCanAfford(owner.id, priceDay);
    const secrets = { password: password(), rootPassword: b.engine === 'mysql' ? password() : undefined };
    const port = await freePort();
    if (b.engine === 'redis') { b.dbName = '0'; }
    const now = Date.now();
    const id = db.prepare(`INSERT INTO databases (name, engine, version, image, container, volume, port, bind_ip, db_name, db_user, password_enc,
      root_password_enc, memory_mb, status, notes, created_by, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(name, b.engine, version, image, container, `kdb-${name}-data`, port, bindIp, b.engine === 'redis' ? '0' : dbName, b.engine === 'redis' ? 'default' : user, seal(secrets.password),
        secrets.rootPassword ? seal(secrets.rootPassword) : null, memoryMb, b.notes ? str(b.notes, { max: 300, name: 'Notes', re: /^[^<>]*$/ }) : null,
        req.session.username, now, now, owner?.id ?? null).lastInsertRowid;
    if (owner && priceDay != null) billing?.start({ userId: owner.id, kind: 'database', name, planId: plan.id, priceDay, by: req.session.username });
    log(req, 'database_create', name, `${image} ${bindIp}:${port}`);
    const row = getRow(id);
    build(row, secrets).catch(() => {});
    res.status(202).json({ database: view(row) });
  }));

  // Connection details incl. password: super admin only, and every look is audited
  router.get('/:id/credentials', (req, res) => {
    const r = writable(req, req.params.id);
    const d = { user: r.db_user, password: unseal(r.password_enc), host: r.bind_ip, port: r.port, dbName: r.db_name };
    log(req, 'database_credentials_view', r.name);
    res.set('Cache-Control', 'no-store');
    res.json({
      ...d, url: ENGINES[r.engine].url(d),
      rootPassword: r.root_password_enc ? unseal(r.root_password_enc) : null,
      note: r.target === 'vps' ? `On your VPS ${customerServers.get(r.server_id)?.name || ''}: apps on that server connect to 127.0.0.1:${r.port}. It is not open to the internet.`
        : r.bind_ip === '127.0.0.1' ? 'Reachable from this server only. Apps in LXD containers need "LXD containers" access.' : `Reachable from this server and LXD containers via ${r.bind_ip}.`,
    });
  });

  for (const action of ['start', 'stop', 'restart']) {
    router.post(`/:id/${action}`, wrap(async (req, res) => {
      const r = writable(req, req.params.id);
      if (action !== 'stop') billing?.assertCanRun(req.session);
      if (!['ready', 'error'].includes(r.status)) throw conflict(`${r.name} is still being created`);
      if (r.target === 'vps') {
        const out = await onVps(r, { DB_OP: action });
        if (out.code !== 0) throw conflict(`${action} failed on your VPS: ${out.output.slice(-200)}`);
        log(req, `database_${action}`, r.name);
        return res.json({ ok: true });
      }
      await locks.with(`db:${r.name}`, `${action} ${r.name}`, () => dockerRequest('POST', `/containers/${r.container}/${action}`, { query: action === 'start' ? undefined : { t: 30 }, timeout: 90_000 })
        .catch((err) => { if (err.status !== 304) throw err; }));
      log(req, `database_${action}`, r.name);
      return res.json({ ok: true });
    }));
  }

  router.get('/:id/logs', wrap(async (req, res) => {
    const r = readable(req, req.params.id);
    if (r.target === 'vps') { res.set('Cache-Control', 'no-store'); return res.json({ logs: (await onVps(r, { DB_OP: 'logs' })).output }); }
    const buf = await dockerRequest('GET', `/containers/${r.container}/logs`, { query: { stdout: true, stderr: true, tail: 300, timestamps: true }, raw: true });
    res.set('Cache-Control', 'no-store');
    return res.json({ logs: demux(buf) });
  }));

  // Live CPU / RAM of one database
  router.get('/:id/stats', wrap(async (req, res) => {
    const r = readable(req, req.params.id);
    res.set('Cache-Control', 'no-store');
    if (r.status !== 'ready') return res.json({ running: false });
    if (r.target === 'vps') {
      const out = await onVps(r, { DB_OP: 'stats' }).catch(() => null);
      if (!out) return res.json({ running: false, error: 'VPS not reachable' });
      const [cpu, mem] = (out.output.split('\n').find((l) => l.includes('|')) || '').split('|');
      const state = /@@STATE (\S+)/.exec(out.output)?.[1] || null;
      const [used, limit] = String(mem || '').split('/');
      return res.json({ running: state === 'running', state, cpu: Number(String(cpu || '').replace('%', '')) || 0, memory: toBytes(used), memoryLimit: toBytes(limit) });
    }
    const st = await containerStats(r.container).catch(() => null);
    return res.json(st ? { running: true, cpu: st.cpu, memory: st.memory, memoryLimit: st.memoryLimit } : { running: false });
  }));

  // Download a fresh dump (gzip) of a main-server database, made right now with the engine's own tool
  router.get('/:id/dump', wrap(async (req, res) => {
    const r = writable(req, req.params.id);
    if (r.target === 'vps') throw bad('This database is on your own VPS: make dumps there (docker exec …).');
    if (r.status !== 'ready') throw conflict(`${r.name} is not ready`);
    const d = DUMP[r.engine];
    const child = spawn(DOCKER_CLI, ['exec', r.container, 'sh', '-c', d.script], { env: dockerCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let started = false;
    child.stderr.on('data', (x) => { if (err.length < 4000) err += x; });
    const gz = zlib.createGzip();
    child.stdout.once('data', () => {
      started = true;
      res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${r.name}-${new Date().toISOString().slice(0, 10)}.${d.ext}.gz"`, 'Cache-Control': 'no-store' });
    });
    child.stdout.pipe(gz).pipe(res);
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      log(req, 'database_dump', r.name, code === 0 ? null : err.slice(-300), code === 0 ? 'success' : 'failure');
      if (code !== 0 && !started && !res.headersSent) { gz.unpipe(res); res.status(500).json({ error: `Dump failed: ${err.slice(-300) || `exit ${code}`}` }); }
    });
  }));

  // Restore: request body = a dump (.sql / .sql.gz / .archive(.gz)) streamed into the engine's restore tool.
  // ?confirm=<name> must match: a restore overwrites data. Postgres/MySQL/MongoDB on the main server.
  router.post('/:id/restore', (req, res, next) => {
    let r;
    try { r = writable(req, req.params.id); } catch (e) { return next(e); }
    if (req.query.confirm !== r.name) return res.status(400).json({ error: `Add ?confirm=${r.name}: a restore overwrites data` });
    if (r.target === 'vps') return res.status(400).json({ error: 'Restore on your own VPS with the database tools there' });
    if (!RESTORE[r.engine]) return res.status(400).json({ error: `${ENGINES[r.engine].label} restore is not supported from the panel` });
    if (r.status !== 'ready') return res.status(409).json({ error: `${r.name} is not ready` });
    const child = spawn(DOCKER_CLI, ['exec', '-i', r.container, 'sh', '-c', RESTORE[r.engine]], { env: dockerCliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const keep = (x) => { out = (out + x).slice(-20_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let first = true;
    let bytes = 0;
    const MAX = Number(process.env.DB_RESTORE_MAX_BYTES) || 4 * 1024 ** 3;
    const sink = new PassThrough();
    // gunzip only if the upload starts with the gzip magic bytes
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX) { req.destroy(); child.kill(); return; }
      if (first) {
        first = false;
        const gz = chunk[0] === 0x1f && chunk[1] === 0x8b;
        (gz ? sink.pipe(zlib.createGunzip()) : sink).on('error', (e) => { keep(`\n${e.message}`); child.stdin.end(); }).pipe(child.stdin).on('error', () => {});
      }
      sink.write(chunk);
    });
    req.on('end', () => { if (first) child.stdin.end(); else sink.end(); });
    child.on('error', (e) => keep(e.message));
    child.on('close', (code) => {
      log(req, 'database_restore', r.name, `${bytes} bytes${code === 0 ? '' : `, exit ${code}: ${out.slice(-200)}`}`, code === 0 ? 'success' : 'failure');
      res.status(code === 0 ? 200 : 500).json({ ok: code === 0, bytes, output: out.slice(-4000) });
    });
    return undefined;
  });

  // ---------- on the customer's own VPS ----------
  const onVps = (r, env, opts = {}) => {
    const srv = customerServers.get(r.server_id);
    if (!srv) return Promise.reject(notFound('The VPS of this database was removed from the panel'));
    return sshRun(customerServers.creds(srv), VPS_DB_SCRIPT, {
      timeoutMs: opts.timeoutMs || 60_000,
      env: { DB_CONTAINER: r.container, DB_VOLUME: r.volume, DB_NAME: r.name, DB_DELETE_DATA: '0', ...env },
    });
  };

  async function createOnVps(req, res, b) {
    if (isAdmin(req.session)) throw forbidden('Databases on customer servers are created by the customer');
    const srv = customerServers.get(int(b.serverId, { min: 1, max: 1e9, name: 'VPS' }));
    if (!srv || srv.user_id !== req.session.id) throw notFound('Pick one of your connected VPS servers');
    const name = str(b.name, { max: 32, name: 'Name', re: NAME_RE });
    const e = ENGINES[b.engine];
    if (!e) throw bad('Engine must be postgres, mysql, mongo or redis');
    const version = String(b.version ?? Object.keys(e.versions).sort((x, y) => Number(y) - Number(x))[0]);
    const image = e.versions[version];
    if (!image) throw bad(`${e.label} version must be one of ${Object.keys(e.versions).join(', ')}`);
    const dbName = b.engine === 'redis' ? '0' : b.dbName ? str(b.dbName, { max: 31, name: 'Database name', re: IDENT_RE }) : 'app';
    const user = b.engine === 'redis' ? 'default' : b.user ? str(b.user, { max: 31, name: 'User', re: IDENT_RE }) : 'app';
    if (b.engine === 'mysql' && user === 'root') throw bad('Pick another user name: MySQL already has root');
    const memoryMb = int(b.memoryMb, { min: 128, max: 65536, name: 'Memory (MB)', optional: true }) || null;
    if (db.prepare('SELECT 1 FROM databases WHERE name = ?').get(name)) throw conflict(`A database named ${name} already exists`);
    // Port on that server: the engine's default, else the next one not used by another of our databases there
    const taken = new Set(db.prepare("SELECT port FROM databases WHERE target = 'vps' AND server_id = ?").all(srv.id).map((x) => x.port));
    let port = e.port;
    while (taken.has(port)) port += 1;
    const secrets = { password: password(), rootPassword: b.engine === 'mysql' ? password() : undefined };
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO databases (name, engine, version, image, container, volume, port, bind_ip, db_name, db_user, password_enc,
      root_password_enc, memory_mb, status, notes, created_by, created_at, updated_at, owner_id, target, server_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, '127.0.0.1', ?, ?, ?, ?, ?, 'creating', NULL, ?, ?, ?, ?, 'vps', ?)`)
      .run(name, b.engine, version, image, `kdb-${name}`, `kdb-${name}-data`, port, dbName, user, seal(secrets.password),
        secrets.rootPassword ? seal(secrets.rootPassword) : null, memoryMb, req.session.username, now, now, req.session.id, srv.id).lastInsertRowid);
    log(req, 'database_create', name, `${image} on my VPS ${srv.name} 127.0.0.1:${port}`);
    const row = getRow(id);
    const envFile = Object.entries(e.env({ user, dbName, ...secrets })).map(([k, v]) => `${k}=${v}`).join('\n');
    onVps(row, {
      DB_OP: 'create', DB_ENGINE: b.engine, DB_IMAGE: image, DB_PORT: String(port), DB_INNER_PORT: String(e.port), DB_MOUNT: e.mount,
      DB_ENV_B64: Buffer.from(`${envFile}\n`).toString('base64'), DB_MEMORY: memoryMb ? `${memoryMb}m` : '',
    }, { timeoutMs: 15 * 60_000 }).then((out) => {
      if (out.code === 0 && out.output.includes('@@READY')) setStatus(id, 'ready');
      else setStatus(id, 'error', out.output.slice(-400) || `exit ${out.code}`);
    }, (err) => setStatus(id, 'error', err.message.slice(0, 400)));
    res.status(202).json({ database: view(row) });
  }

  // Delete: typed name; the data volume is kept unless deleteData is set (then it is gone for good)
  router.delete('/:id', wrap(async (req, res) => {
    const r = writable(req, req.params.id);
    if (req.body?.confirm !== r.name) throw bad(`Type "${r.name}" exactly to confirm`);
    if (['queued', 'pulling', 'creating'].includes(r.status)) throw conflict(`${r.name} is still being created. Wait until it is ready or failed.`);
    const deleteData = req.body?.deleteData === true;
    if (r.target === 'vps') {
      const out = await onVps(r, { DB_OP: 'delete', DB_DELETE_DATA: deleteData ? '1' : '0' }).catch((err) => ({ code: -1, output: err.message }));
      db.prepare('DELETE FROM databases WHERE id = ?').run(r.id);
      log(req, 'database_delete', r.name, `on my VPS${out.code === 0 ? '' : ` (server not reached: ${out.output.slice(-120)})`}`);
      return res.json({ ok: true, keptVolume: deleteData ? null : r.volume, note: out.code === 0 ? null : 'Your VPS could not be reached; the container may still be there.' });
    }
    await locks.with(`db:${r.name}`, `delete ${r.name}`, async () => {
      await dockerRequest('DELETE', `/containers/${r.container}`, { query: { force: true } }).catch((err) => { if (err.status !== 404) throw err; });
      if (deleteData) await dockerRequest('DELETE', `/volumes/${r.volume}`).catch((err) => { if (err.status !== 404) throw err; });
      db.prepare('DELETE FROM databases WHERE id = ?').run(r.id);
    });
    billing?.end('database', r.name, req.session.username);
    log(req, 'database_delete', r.name, deleteData ? `container and volume ${r.volume} deleted` : `container deleted, volume ${r.volume} kept`);
    return res.json({ ok: true, keptVolume: deleteData ? null : r.volume });
  }));

  // Used by billing when a user's wallet runs out
  async function stopByName(name) {
    const r = db.prepare('SELECT * FROM databases WHERE name = ?').get(name);
    if (!r) return;
    await dockerRequest('POST', `/containers/${r.container}/stop`, { query: { t: 30 }, timeout: 90_000 }).catch((err) => { if (err.status !== 304 && err.status !== 404) throw err; });
  }

  return { router, stopByName };
}
