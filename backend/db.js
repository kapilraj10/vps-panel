// SQLite storage: users, sessions, audit log, backups mirror, and the Kapil Cloud tables
// (container ownership, settings, metrics, alerts, SSH keys, apps, deployments, domains).
// Schema changes go through numbered migrations; the DB file is copied before any migration runs.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'panel.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
export const db = new Database(DB_PATH);
fs.chmodSync(DB_PATH, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- baseline (the schema before Kapil Cloud; unchanged so old databases match) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    container_name TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY,
    ts       INTEGER NOT NULL,
    username TEXT,
    ip       TEXT,
    action   TEXT NOT NULL,
    target   TEXT,
    result   TEXT NOT NULL,
    detail   TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
  CREATE TABLE IF NOT EXISTS backup_jobs (
    id            TEXT PRIMARY KEY,
    trigger_type  TEXT,
    by_user       TEXT,
    targets       TEXT,
    status        TEXT NOT NULL,
    phase         TEXT,
    progress      INTEGER,
    started_at    INTEGER,
    finished_at   INTEGER,
    size          INTEGER,
    error         TEXT,
    warning       TEXT,
    log_path      TEXT,
    verified_at   INTEGER,
    verify_result TEXT,
    audited       TEXT
  );
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`);

// ---------- migrations ----------
// Each runs once, inside a transaction, with foreign keys off (needed to rebuild a table SQLite cannot ALTER).
const MIGRATIONS = [
  {
    version: 1,
    name: 'kapil-cloud: roles, multi-container users, cloud tables',
    sql: `
      -- users: three roles + status + quotas. Existing admins become super_admin (same full power they had).
      CREATE TABLE users_new (
        id             INTEGER PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'user')),
        status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        full_name      TEXT,
        email          TEXT,
        max_containers INTEGER,
        max_cpu        INTEGER,
        max_memory     INTEGER,
        max_disk       INTEGER,
        max_snapshots  INTEGER,
        net_limit_mbit INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER,
        last_login_at  INTEGER,
        last_login_ip  TEXT
      );
      INSERT INTO users_new (id, username, password_hash, role, created_at)
        SELECT id, username, password_hash, CASE role WHEN 'admin' THEN 'super_admin' ELSE 'user' END, created_at FROM users;

      CREATE TABLE user_containers (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        container   TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, container)
      );
      INSERT INTO user_containers (user_id, container, assigned_at)
        SELECT id, container_name, created_at FROM users WHERE role = 'user' AND container_name IS NOT NULL AND container_name != '';

      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX user_containers_ct ON user_containers(container);

      ALTER TABLE sessions ADD COLUMN ip TEXT;
      ALTER TABLE sessions ADD COLUMN user_agent TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
      CREATE INDEX audit_user ON audit(username, ts);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );

      -- Panel-side facts about LXD instances. origin 'existing' = was there before Kapil Cloud (protected by default)
      CREATE TABLE container_meta (
        name       TEXT PRIMARY KEY,
        protected  INTEGER NOT NULL DEFAULT 0,
        origin     TEXT NOT NULL DEFAULT 'panel',
        image      TEXT,
        notes      TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );

      -- One row per scope per minute (scope: 'host' or 'ct:<name>')
      CREATE TABLE metrics (
        scope      TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        cpu        REAL,
        mem        REAL,
        mem_total  REAL,
        disk       REAL,
        disk_total REAL,
        rx         REAL,
        tx         REAL,
        load1      REAL,
        temp       REAL,
        io_read    REAL,
        io_write   REAL,
        PRIMARY KEY (scope, ts)
      ) WITHOUT ROWID;

      CREATE TABLE alerts (
        id              INTEGER PRIMARY KEY,
        kind            TEXT NOT NULL,
        target          TEXT NOT NULL DEFAULT '',
        level           TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
        message         TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        resolved_at     INTEGER,
        acknowledged_by TEXT,
        acknowledged_at INTEGER
      );
      CREATE INDEX alerts_open ON alerts(kind, target, resolved_at);
      CREATE INDEX alerts_created ON alerts(created_at);

      CREATE TABLE ssh_keys (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        public_key  TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE (user_id, fingerprint)
      );

      CREATE TABLE apps (
        id             INTEGER PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        container      TEXT NOT NULL,
        name           TEXT NOT NULL,
        type           TEXT NOT NULL,
        repo_url       TEXT,
        branch         TEXT,
        root_dir       TEXT,
        install_cmd    TEXT,
        build_cmd      TEXT,
        start_cmd      TEXT,
        port           INTEGER,
        env_enc        TEXT,
        git_token_enc  TEXT,
        status         TEXT NOT NULL DEFAULT 'new',
        last_deploy_at INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE (container, name)
      );

      CREATE TABLE deployments (
        id          INTEGER PRIMARY KEY,
        app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        by_user     TEXT,
        status      TEXT NOT NULL,
        commit_sha  TEXT,
        log         TEXT,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX deployments_app ON deployments(app_id, id);

      CREATE TABLE domains (
        id             INTEGER PRIMARY KEY,
        hostname       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        user_id        INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        container      TEXT NOT NULL,
        app_id         INTEGER REFERENCES apps(id) ON DELETE SET NULL,
        port           INTEGER NOT NULL,
        status         TEXT NOT NULL,
        route_synced   INTEGER NOT NULL DEFAULT 0,
        dns_record_id  TEXT,
        error          TEXT,
        ssl_status     TEXT,
        ssl_issuer     TEXT,
        ssl_expires_at INTEGER,
        ssl_checked_at INTEGER,
        requested_by   TEXT,
        approved_by    TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'apps: output folder for static sites',
    sql: 'ALTER TABLE apps ADD COLUMN output_dir TEXT;',
  },
];

function migrate() {
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const todo = MIGRATIONS.filter((m) => !done.has(m.version));
  if (!todo.length) return;
  // Copy of the DB before touching it (kept next to it; never deleted by the panel)
  const copy = `${DB_PATH}.pre-migration-${Date.now()}`;
  const hasData = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasData && DB_PATH !== ':memory:') {
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    fs.chmodSync(copy, 0o600);
    console.log(`Database copied to ${copy} before migrating`);
  }
  db.pragma('foreign_keys = OFF');
  try {
    for (const m of todo) {
      db.transaction(() => {
        db.exec(m.sql);
        const bad = db.pragma('foreign_key_check');
        if (bad.length) throw new Error(`Migration ${m.version} broke foreign keys: ${JSON.stringify(bad.slice(0, 3))}`);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
      })();
      console.log(`Applied migration ${m.version}: ${m.name}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
migrate();

// ---------- validation shared with routes ----------
export const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;
// LXD instance names: letters, digits, dashes; must start with a letter
export const CONTAINER_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
// Names Kapil Cloud gives new containers (also valid hostnames)
export const NEW_CONTAINER_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const MIN_PASSWORD = 10;
export const ROLES = ['super_admin', 'admin', 'user'];
export const isAdminRole = (role) => role === 'admin' || role === 'super_admin';

const userCols = `id, username, role, status, full_name, email, max_containers, max_cpu, max_memory, max_disk,
  max_snapshots, net_limit_mbit, created_at, updated_at, last_login_at, last_login_ip`;

const containersOf = (id) => db.prepare('SELECT container FROM user_containers WHERE user_id = ? ORDER BY container').all(id).map((r) => r.container);
const withContainers = (u) => (u ? { ...u, containers: containersOf(u.id) } : u);

export const users = {
  list: () => db.prepare(`SELECT ${userCols} FROM users ORDER BY username`).all().map(withContainers),
  byId: (id) => withContainers(db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id)),
  byName: (name) => withContainers(db.prepare(`SELECT ${userCols} FROM users WHERE username = ?`).get(name)),
  withHash: (username) => db.prepare(`SELECT ${userCols}, password_hash FROM users WHERE username = ?`).get(username),
  hashById: (id) => db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash,
  create: ({ username, passwordHash, role, fullName = null, email = null, containers = [], quotas = {} }) => db.transaction(() => {
    const now = Date.now();
    const id = db.prepare(`INSERT INTO users (username, password_hash, role, full_name, email, max_containers, max_cpu, max_memory,
        max_disk, max_snapshots, net_limit_mbit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(username, passwordHash, role, fullName, email, quotas.max_containers ?? null, quotas.max_cpu ?? null,
        quotas.max_memory ?? null, quotas.max_disk ?? null, quotas.max_snapshots ?? null, quotas.net_limit_mbit ?? null, now, now)
      .lastInsertRowid;
    for (const c of containers) db.prepare('INSERT INTO user_containers (user_id, container, assigned_at) VALUES (?, ?, ?)').run(id, c, now);
    return Number(id);
  })(),
  update: (id, fields) => {
    const allowed = ['role', 'status', 'full_name', 'email', 'max_containers', 'max_cpu', 'max_memory', 'max_disk', 'max_snapshots', 'net_limit_mbit'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...Object.fromEntries(keys.map((k) => [k, fields[k]])), updated_at: Date.now(), id });
  },
  setContainers: (id, list) => db.transaction(() => {
    const now = Date.now();
    db.prepare('DELETE FROM user_containers WHERE user_id = ?').run(id);
    for (const c of list) db.prepare('INSERT INTO user_containers (user_id, container, assigned_at) VALUES (?, ?, ?)').run(id, c, now);
  })(),
  assign: (id, container) => db.prepare('INSERT OR IGNORE INTO user_containers (user_id, container, assigned_at) VALUES (?, ?, ?)').run(id, container, Date.now()),
  renameContainer: (from, to) => db.prepare('UPDATE user_containers SET container = ? WHERE container = ?').run(to, from),
  unassignContainer: (container) => db.prepare('DELETE FROM user_containers WHERE container = ?').run(container),
  ownersOf: (container) => db.prepare(`SELECT u.id, u.username FROM user_containers uc JOIN users u ON u.id = uc.user_id
    WHERE uc.container = ? ORDER BY u.username`).all(container),
  containersOf,
  setPassword: (id, passwordHash) => db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, Date.now(), id),
  markLogin: (id, ip) => db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(Date.now(), ip, id),
  remove: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
  countRole: (role) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = 'active'").get(role).n,
};

export const sessions = {
  create: (tokenHash, userId, csrf, ttlMs, { ip = null, userAgent = null } = {}) => {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at, ip, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash, userId, csrf, now, now + ttlMs, ip, userAgent ? String(userAgent).slice(0, 200) : null, now);
  },
  // Joins users so role/status always come from the current DB record. Suspended users have no valid session.
  find: (tokenHash) => {
    const s = db.prepare(`
      SELECT s.token_hash, s.csrf, s.expires_at, s.created_at AS session_created_at, s.last_seen_at, u.id, u.username, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`).get(tokenHash, Date.now());
    if (s) s.containers = containersOf(s.id);
    return s;
  },
  touch: (tokenHash) => db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), tokenHash),
  listForUser: (userId) => db.prepare(`SELECT token_hash, created_at, expires_at, ip, user_agent, last_seen_at FROM sessions
    WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`).all(userId, Date.now()),
  remove: (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash),
  removeForUser: (userId, exceptHash = '') =>
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptHash),
  purgeExpired: () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()),
};

export const audit = {
  log: ({ username = null, ip = null, action, target = null, result, detail = null }) =>
    db.prepare('INSERT INTO audit (ts, username, ip, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), username, ip, action, target, result, detail == null ? null : String(detail).slice(0, 2000)),
  recent: (limit, before, { username = null, action = null, q = null } = {}) => db.prepare(`
    SELECT * FROM audit
    WHERE (@before IS NULL OR id < @before)
      AND (@username IS NULL OR username = @username)
      AND (@action IS NULL OR action = @action)
      AND (@q IS NULL OR action LIKE @q OR target LIKE @q OR detail LIKE @q OR username LIKE @q)
    ORDER BY id DESC LIMIT @limit`).all({ before: before ?? null, username, action, q: q ? `%${q}%` : null, limit }),
  // Entries about a user's own containers or by the user (for the user dashboard)
  forUser: (username, containers, limit) => {
    const list = containers.length ? containers : ['\u0000'];
    return db.prepare(`SELECT id, ts, username, ip, action, target, result, detail FROM audit
      WHERE username = ? OR target IN (${list.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(username, ...list, limit);
  },
};

// Mirror of the backup helper's job records (/var/lib/panel-backup/jobs/*.json), plus verify results.
// `audited` remembers the last status written to the audit log, so restarts never log twice.
export const backupJobs = {
  upsert: (j) => db.prepare(`
    INSERT INTO backup_jobs (id, trigger_type, by_user, targets, status, phase, progress, started_at, finished_at, size, error, warning, log_path)
    VALUES (@id, @trigger, @by, @targets, @status, @phase, @progress, @startedAt, @finishedAt, @size, @error, @warning, @log)
    ON CONFLICT(id) DO UPDATE SET trigger_type = excluded.trigger_type, by_user = excluded.by_user, targets = excluded.targets,
      status = excluded.status, phase = excluded.phase, progress = excluded.progress, started_at = excluded.started_at,
      finished_at = excluded.finished_at, size = excluded.size, error = excluded.error, warning = excluded.warning,
      log_path = excluded.log_path`).run(j),
  get: (id) => db.prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id),
  recent: (limit, before) => db.prepare(`
    SELECT * FROM backup_jobs WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`).all(before ?? null, before ?? null, limit),
  setAudited: (id, status) => db.prepare('UPDATE backup_jobs SET audited = ? WHERE id = ?').run(status, id),
  setVerify: (id, result) => db.prepare('UPDATE backup_jobs SET verified_at = ?, verify_result = ? WHERE id = ?')
    .run(Date.now(), JSON.stringify(result), id),
};

// ---------- settings (key -> JSON value) ----------
export const SETTING_DEFAULTS = {
  cpu_overcommit: 1, // 1 = never allocate more vCPUs than the host has
  memory_overcommit: 1,
  host_memory_reserve: 1536 * 1024 * 1024, // RAM kept for the host itself (bytes)
  disk_reserve_percent: 10, // storage pool space never handed out
  alert_cpu: 90,
  alert_memory: 90,
  alert_disk: 85,
  alert_temp: 85,
  alert_backup_disk_free: 15, // percent free on /mnt/backup
  alert_sustain_minutes: 5,
  allowed_domain_suffixes: ['gyannportal.com'], // users may request subdomains of these; others need admin approval anyway
  terminal_idle_minutes: 15,
  terminal_max_minutes: 240,
};

export const settings = {
  get(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return SETTING_DEFAULTS[key];
    try { return JSON.parse(row.value); } catch { return SETTING_DEFAULTS[key]; }
  },
  all() {
    const out = { ...SETTING_DEFAULTS };
    for (const r of db.prepare('SELECT key, value FROM settings').all()) {
      if (Object.hasOwn(SETTING_DEFAULTS, r.key)) { try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ } }
    }
    return out;
  },
  set(key, value, by) {
    db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(key, JSON.stringify(value), Date.now(), by);
  },
};

export const containerMeta = {
  get: (name) => db.prepare('SELECT * FROM container_meta WHERE name = ?').get(name),
  all: () => Object.fromEntries(db.prepare('SELECT * FROM container_meta').all().map((r) => [r.name, r])),
  // Instances the panel did not create are recorded once as 'existing' and protected
  adoptExisting: (name) => db.prepare(`INSERT OR IGNORE INTO container_meta (name, protected, origin, created_at) VALUES (?, 1, 'existing', ?)`).run(name, Date.now()),
  createdByPanel: (name, { image, by }) => db.prepare(`INSERT INTO container_meta (name, protected, origin, image, created_by, created_at)
    VALUES (?, 0, 'panel', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET origin = 'panel', image = excluded.image, created_by = excluded.created_by,
    created_at = excluded.created_at, protected = 0`).run(name, image, by, Date.now()),
  setProtected: (name, on) => db.prepare(`INSERT INTO container_meta (name, protected, origin, created_at) VALUES (?, ?, 'existing', ?)
    ON CONFLICT(name) DO UPDATE SET protected = excluded.protected`).run(name, on ? 1 : 0, Date.now()),
  setNotes: (name, notes) => db.prepare('UPDATE container_meta SET notes = ? WHERE name = ?').run(notes, name),
  rename: (from, to) => db.prepare('UPDATE container_meta SET name = ? WHERE name = ?').run(to, from),
  remove: (name) => db.prepare('DELETE FROM container_meta WHERE name = ?').run(name),
};
