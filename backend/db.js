// SQLite storage for panel users, login sessions and the audit log.
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
`);

export const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;
// LXD instance names: letters, digits, dashes; must start with a letter
export const CONTAINER_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
export const MIN_PASSWORD = 10;

const userCols = 'id, username, role, container_name, created_at';

export const users = {
  list: () => db.prepare(`SELECT ${userCols} FROM users ORDER BY username`).all(),
  byId: (id) => db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id),
  withHash: (username) => db.prepare(`SELECT ${userCols}, password_hash FROM users WHERE username = ?`).get(username),
  hashById: (id) => db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash,
  create: ({ username, passwordHash, role, container }) =>
    db.prepare('INSERT INTO users (username, password_hash, role, container_name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, passwordHash, role, role === 'admin' ? null : container, Date.now()).lastInsertRowid,
  setPassword: (id, passwordHash) => db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id),
  remove: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
  adminCount: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n,
};

export const sessions = {
  create: (tokenHash, userId, csrf, ttlMs) => {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, userId, csrf, now, now + ttlMs);
  },
  // Joins the users table so role/container always come from the current DB record
  find: (tokenHash) => db.prepare(`
    SELECT s.token_hash, s.csrf, s.expires_at, u.id, u.username, u.role, u.container_name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, Date.now()),
  remove: (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash),
  removeForUser: (userId, exceptHash = '') =>
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptHash),
  purgeExpired: () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()),
};

export const audit = {
  log: ({ username = null, ip = null, action, target = null, result, detail = null }) =>
    db.prepare('INSERT INTO audit (ts, username, ip, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), username, ip, action, target, result, detail),
  recent: (limit, before) => db.prepare(`
    SELECT * FROM audit WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`).all(before ?? null, before ?? null, limit),
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
