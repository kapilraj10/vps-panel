// "My VPS servers": customers connect their own servers over SSH and deploy apps / databases there.
// Tenancy: a customer sees and uses only their own rows; admins see all (read + remove). Credentials are sealed on
// save, verified BEFORE saving, and never returned by any route. The panel's own fleet (nodes) is a separate table.
import express from 'express';
import { db, audit } from './db.js';
import { seal, open as unseal } from './secrets.js';
import { clientIp, isAdmin, isSuperAdmin } from './auth.js';
import { wrap, bad, forbidden, notFound, conflict, int, str } from './http.js';
import { sshRun, FACTS_SCRIPT, parseFacts } from './sshexec.js';
import { RUNTIME_SCRIPT } from './apps.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const HOST_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^[0-9a-fA-F:.]{2,45}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const CHECK_EVERY_MS = Number(process.env.CUSTOMER_SERVER_CHECK_MS) || 5 * 60_000;
const MAX_PER_USER = 20;

export const customerServers = {
  get: (id) => db.prepare('SELECT * FROM customer_servers WHERE id = ?').get(Number(id)),
  creds: (r) => ({ host: r.host, port: r.port, username: r.username, authType: r.auth_type, secret: unseal(r.secret_enc), hostKey: r.host_key }),
};

const view = (r, admin) => {
  let facts = null;
  try { facts = r.facts ? JSON.parse(r.facts) : null; } catch { facts = null; }
  return {
    id: r.id, name: r.name, host: r.host, port: r.port, username: r.username, authType: r.auth_type, hostKey: r.host_key,
    status: r.status, facts, lastCheckAt: r.last_check_at, lastError: r.last_error, createdAt: r.created_at,
    ...(admin ? { owner: r.owner, userId: r.user_id } : {}),
    apps: db.prepare("SELECT COUNT(*) AS n FROM apps WHERE target = 'vps' AND server_id = ?").get(r.id).n,
    databases: db.prepare("SELECT COUNT(*) AS n FROM databases WHERE target = 'vps' AND server_id = ?").get(r.id).n,
  };
};

export function createMyServers({ io }) {
  const router = express.Router();
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });
  const tasks = new Map(); // server id -> { kind, status, log, startedAt, finishedAt }

  // A row the session may use. Customers: own rows only (others look missing). Admins: all.
  function mine(req, id = req.params.id) {
    const r = customerServers.get(id);
    if (!r || (!isAdmin(req.session) && r.user_id !== req.session.id)) throw notFound('No such server');
    return r;
  }

  function parseCreds(b, old = null) {
    const host = str(b.host ?? old?.host, { max: 253, name: 'Host / IP', re: HOST_RE }).toLowerCase();
    const port = int(b.port ?? old?.port ?? 22, { min: 1, max: 65535, name: 'SSH port' });
    const username = str(b.username ?? old?.username ?? 'root', { max: 32, name: 'SSH user', re: USER_RE });
    const authType = b.authType ?? old?.auth_type ?? 'key';
    if (!['key', 'password'].includes(authType)) throw bad('Authentication must be key or password');
    let secret = authType === 'key' ? b.privateKey : b.password;
    if (secret == null && old && old.auth_type === authType) secret = unseal(old.secret_enc);
    if (typeof secret !== 'string' || !secret.trim()) throw bad(authType === 'key' ? 'Paste the private key' : 'Enter the SSH password');
    if (secret.length > 16_000) throw bad('That key is too long');
    if (authType === 'key' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret)) throw bad('That does not look like a private key (-----BEGIN … PRIVATE KEY-----)');
    if (authType === 'key' && /ENCRYPTED/.test(secret)) throw bad('Use a private key without a passphrase (create a separate deploy key)');
    return { host, port, username, authType, secret: authType === 'key' ? `${secret.trim()}\n` : secret };
  }

  async function probe(creds) {
    const r = await sshRun(creds, FACTS_SCRIPT, { timeoutMs: 30_000 });
    if (r.code !== 0) throw bad(`Connected, but the check script failed (exit ${r.code})`);
    return { facts: parseFacts(r.output), hostKey: r.hostKey };
  }

  router.get('/my-servers', (req, res) => {
    const admin = isAdmin(req.session);
    const rows = admin
      ? db.prepare('SELECT s.*, u.username AS owner FROM customer_servers s JOIN users u ON u.id = s.user_id ORDER BY u.username, s.name').all()
      : db.prepare('SELECT * FROM customer_servers WHERE user_id = ? ORDER BY name').all(req.session.id);
    res.set('Cache-Control', 'no-store');
    res.json({ servers: rows.map((r) => view(r, admin)) });
  });

  router.get('/my-servers/:id', (req, res) => {
    const r = mine(req);
    res.set('Cache-Control', 'no-store');
    res.json({ server: view(r, isAdmin(req.session)), task: tasks.get(r.id) || null });
  });

  // Verify first, save only if it works. The host key seen now is pinned.
  router.post('/my-servers', wrap(async (req, res) => {
    if (isAdmin(req.session)) throw forbidden('Admins add servers in the VPS fleet. This page is for customers.');
    const b = req.body || {};
    const name = str(b.name, { max: 40, name: 'Name', re: NAME_RE });
    if (db.prepare('SELECT COUNT(*) AS n FROM customer_servers WHERE user_id = ?').get(req.session.id).n >= MAX_PER_USER) throw conflict(`At most ${MAX_PER_USER} servers`);
    if (db.prepare('SELECT 1 FROM customer_servers WHERE user_id = ? AND name = ?').get(req.session.id, name)) throw conflict('You already have a server with that name');
    const creds = parseCreds(b);
    let result;
    try {
      result = await probe(creds);
    } catch (err) {
      audit.log({ ...who(req), action: 'my_server_add', target: `${creds.username}@${creds.host}:${creds.port}`, result: 'failure', detail: err.message.slice(0, 200) });
      throw err.status ? err : bad(err.message);
    }
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO customer_servers (user_id, name, host, port, username, auth_type, secret_enc, host_key, status, facts, last_check_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)`).run(req.session.id, name, creds.host, creds.port, creds.username, creds.authType, seal(creds.secret),
      result.hostKey, JSON.stringify(result.facts), now, now, now).lastInsertRowid);
    audit.log({ ...who(req), action: 'my_server_add', target: `${name} (${creds.username}@${creds.host}:${creds.port})`, result: 'success', detail: `host key ${result.hostKey}` });
    res.status(201).json({ server: view(customerServers.get(id), false) });
  }));

  // Re-check now (status + facts). Uses the pinned host key.
  router.post('/my-servers/:id/check', wrap(async (req, res) => {
    const r = mine(req);
    await checkOne(r);
    res.json({ server: view(customerServers.get(r.id), isAdmin(req.session)) });
  }));

  // New credentials (e.g. a rotated key). Verified before they replace the old ones; the pinned host key must match.
  router.put('/my-servers/:id', wrap(async (req, res) => {
    const r = mine(req);
    if (r.user_id !== req.session.id) throw forbidden('Only the owner can change the credentials');
    const b = req.body || {};
    const name = b.name !== undefined ? str(b.name, { max: 40, name: 'Name', re: NAME_RE }) : r.name;
    const creds = parseCreds(b, r);
    if (creds.host !== r.host || creds.port !== r.port) throw bad('To move to another address, add it as a new server');
    const result = await probe({ ...creds, hostKey: r.host_key });
    db.prepare('UPDATE customer_servers SET name = ?, username = ?, auth_type = ?, secret_enc = ?, facts = ?, status = ?, last_error = NULL, last_check_at = ?, updated_at = ? WHERE id = ?')
      .run(name, creds.username, creds.authType, seal(creds.secret), JSON.stringify(result.facts), 'online', Date.now(), Date.now(), r.id);
    audit.log({ ...who(req), action: 'my_server_update', target: r.name, result: 'success' });
    res.json({ server: view(customerServers.get(r.id), false) });
  }));

  // Install git, Node.js and PM2 (needs root or passwordless sudo on the server). Runs in the background; poll GET.
  router.post('/my-servers/:id/prepare', wrap(async (req, res) => {
    const r = mine(req);
    if (r.user_id !== req.session.id && !isSuperAdmin(req.session)) throw forbidden('Only the owner can do this');
    if (tasks.get(r.id)?.status === 'running') throw conflict('A task is already running on this server');
    const docker = req.body?.docker === true;
    const t = { kind: 'prepare', status: 'running', log: '', startedAt: Date.now(), finishedAt: null };
    tasks.set(r.id, t);
    audit.log({ ...who(req), action: 'my_server_prepare', target: r.name, result: 'requested', detail: docker ? 'with Docker' : null });
    sshRun(customerServers.creds(r), RUNTIME_SCRIPT, {
      asRoot: true, env: { RUNTIMES: ['node', 'python', ...(docker ? ['docker'] : [])].join(',') }, timeoutMs: 25 * 60_000,
      onOutput: (x) => { t.log = (t.log + x).slice(-100_000); io?.to(`user:${r.user_id}`).emit('myserver:log', { id: r.id, text: x }); },
    }).then((out) => {
      t.status = out.code === 0 ? 'success' : 'failed';
      if (out.code !== 0 && /sudo: a password is required|sudo: .*not found/i.test(out.output)) t.log += '\nThe SSH user needs root or passwordless sudo to install software. Connect as root, or install git, Node.js and PM2 yourself.\n';
    }, (err) => { t.status = 'failed'; t.log += `\n[Sampanna Cloud] ${err.message}\n`; })
      .finally(async () => {
        t.finishedAt = Date.now();
        audit.log({ ...who(req), action: 'my_server_prepare', target: r.name, result: t.status === 'success' ? 'success' : 'failure' });
        await checkOne(customerServers.get(r.id)).catch(() => {});
      });
    res.status(202).json({ task: t });
  }));

  // Remove from the panel (nothing on the server is touched). Refused while apps/databases still point at it.
  router.delete('/my-servers/:id', wrap(async (req, res) => {
    const r = mine(req);
    if (r.user_id !== req.session.id && !isSuperAdmin(req.session)) throw forbidden('Only the owner or a super admin can remove it');
    if (req.body?.confirm !== r.name) throw bad(`Type "${r.name}" to confirm`);
    const v = view(r, false);
    if (v.apps || v.databases) throw conflict(`Delete its ${v.apps} app(s) and ${v.databases} database(s) in the panel first`);
    db.prepare('DELETE FROM customer_servers WHERE id = ?').run(r.id);
    tasks.delete(r.id);
    audit.log({ ...who(req), action: 'my_server_remove', target: `${r.name} (${r.host})`, result: 'success' });
    res.json({ ok: true });
  }));

  async function checkOne(r) {
    try {
      const { facts } = await probe(customerServers.creds(r));
      db.prepare("UPDATE customer_servers SET status = 'online', facts = ?, last_error = NULL, last_check_at = ? WHERE id = ?").run(JSON.stringify(facts), Date.now(), r.id);
    } catch (err) {
      const status = err.status === 409 ? 'host_key_changed' : 'offline';
      db.prepare('UPDATE customer_servers SET status = ?, last_error = ?, last_check_at = ? WHERE id = ?').run(status, err.message.slice(0, 300), Date.now(), r.id);
    }
  }

  // Health loop: every server, one at a time
  function start() {
    const loop = async () => {
      for (const r of db.prepare('SELECT * FROM customer_servers').all()) await checkOne(r).catch(() => {});
      setTimeout(loop, CHECK_EVERY_MS).unref();
    };
    setTimeout(loop, 30_000).unref();
  }

  return { router, start };
}
