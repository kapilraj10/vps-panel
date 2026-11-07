// User management (admins) and the user's own account/security pages.
// Rules: admins manage role "user" accounts only; super admins manage everyone. Nobody can demote, suspend or
// delete themselves, and the last active super admin can never be demoted, suspended or deleted.
import express from 'express';
import { users, sessions, audit, db, USERNAME_RE, CONTAINER_RE, MIN_PASSWORD, ROLES } from './db.js';
import { clientIp, hashPassword, checkPassword, isSuperAdmin, requireAdmin, sessionId } from './auth.js';
import { wrap, bad, forbidden, notFound, conflict, int, MiB, GiB } from './http.js';

export const passwordProblem = (pw) => {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (Buffer.byteLength(pw) > 72) return 'Password must be at most 72 bytes';
  return null;
};
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,20}$/;

export function createUsers({ io, containers, terminal }) {
  const router = express.Router();
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });
  const kick = (id) => { io.in(`user:${id}`).disconnectSockets(true); terminal.closeForUser(id, 'account changed'); };

  function quotas(q = {}) {
    const n = (v, max, name, scale = 1) => (v === undefined || v === null || v === '' ? null : int(v, { min: 0, max, name }) * scale);
    return {
      max_containers: n(q.maxContainers, 100, 'Max servers'),
      max_cpu: n(q.maxCpu, 256, 'Max CPU cores'),
      max_memory: n(q.maxMemoryMiB, 1024 * 1024, 'Max memory (MiB)', MiB),
      max_disk: n(q.maxDiskGiB, 100_000, 'Max disk (GiB)', GiB),
      max_snapshots: n(q.maxSnapshots, 100, 'Max snapshots'),
      net_limit_mbit: n(q.netLimitMbit, 100_000, 'Network limit'),
    };
  }
  function containerList(list) {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.length > 50) throw bad('containers must be a list');
    for (const c of list) if (typeof c !== 'string' || !CONTAINER_RE.test(c) || !containers.exists(c)) throw bad(`Server ${String(c).slice(0, 40)} does not exist`);
    return [...new Set(list)];
  }
  // May the acting session manage this target account?
  function canManage(req, target) {
    if (isSuperAdmin(req.session)) return;
    if (target.role !== 'user') throw forbidden('Only a super admin can manage admin accounts');
  }
  const lastSuper = (t) => t.role === 'super_admin' && t.status === 'active' && users.countRole('super_admin') <= 1;
  function target(req) {
    const t = /^\d+$/.test(req.params.id) ? users.byId(Number(req.params.id)) : null;
    if (!t) throw notFound('No such user');
    return t;
  }

  function usage(u) {
    const list = u.containers.map((c) => containers.snapshot(c)).filter(Boolean);
    return {
      servers: u.containers.length,
      running: list.filter((s) => s.status === 'Running').length,
      cpuCores: list.reduce((s, c) => s + (c.limits?.cpu || 0), 0),
      memUsed: list.reduce((s, c) => s + (c.memUsed || 0), 0),
      memLimit: list.reduce((s, c) => s + (c.limits?.memory || 0), 0),
      diskUsed: list.reduce((s, c) => s + (c.diskUsed || 0), 0),
      diskLimit: list.reduce((s, c) => s + (c.limits?.disk || 0), 0),
      apps: db.prepare('SELECT COUNT(*) AS n FROM apps WHERE user_id = ?').get(u.id).n,
      domains: db.prepare('SELECT COUNT(*) AS n FROM domains WHERE user_id = ?').get(u.id).n,
    };
  }

  // ---------- admin ----------
  router.get('/users', requireAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ users: users.list().map((u) => ({ ...u, usage: usage(u) })), containers: containers.names() });
  });

  router.get('/users/:id', requireAdmin, wrap(async (req, res) => {
    const t = target(req);
    res.set('Cache-Control', 'no-store');
    res.json({
      user: { ...t, usage: usage(t) },
      activity: audit.forUser(t.username, t.containers, 100),
      sessions: sessions.listForUser(t.id).map((s) => ({ id: sessionId(s.token_hash), createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent })),
    });
  }));

  router.post('/users', requireAdmin, wrap(async (req, res) => {
    const b = req.body ?? {};
    const name = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(name)) throw bad('Username: 2-32 lowercase letters, digits, _ or -, starting with a letter');
    const role = b.role || 'user';
    if (!ROLES.includes(role)) throw bad('Role must be super_admin, admin or user');
    if (role !== 'user' && !isSuperAdmin(req.session)) throw forbidden('Only a super admin can create admins');
    const problem = passwordProblem(b.password);
    if (problem) throw bad(problem);
    if (b.email && !EMAIL_RE.test(b.email)) throw bad('Email address looks wrong');
    if (users.withHash(name)) throw conflict('That username is taken');
    const list = role === 'user' ? containerList(b.containers || []) : [];
    const id = users.create({
      username: name, passwordHash: await hashPassword(b.password), role,
      fullName: typeof b.fullName === 'string' ? b.fullName.trim().slice(0, 100) || null : null,
      email: b.email || null, containers: list, quotas: quotas(b.quotas),
    });
    for (const c of list) io.in(`user:${id}`).socketsJoin(`ct:${c}`);
    audit.log({ ...who(req), action: 'user_create', target: name, result: 'success', detail: `${role}${list.length ? `; servers ${list.join(', ')}` : ''}` });
    res.status(201).json({ user: users.byId(id) });
  }));

  router.put('/users/:id', requireAdmin, wrap(async (req, res) => {
    const t = target(req);
    canManage(req, t);
    const b = req.body ?? {};
    const fields = {};
    const changes = [];
    if (b.role !== undefined && b.role !== t.role) {
      if (!isSuperAdmin(req.session)) throw forbidden('Only a super admin can change roles');
      if (!ROLES.includes(b.role)) throw bad('Invalid role');
      if (t.id === req.session.id) throw bad('You cannot change your own role');
      if (lastSuper(t)) throw bad('This is the last super admin');
      fields.role = b.role;
      changes.push(`role ${t.role} -> ${b.role}`);
    }
    if (b.fullName !== undefined) fields.full_name = String(b.fullName).trim().slice(0, 100) || null;
    if (b.email !== undefined) {
      if (b.email && !EMAIL_RE.test(b.email)) throw bad('Email address looks wrong');
      fields.email = b.email || null;
    }
    if (b.quotas !== undefined) { Object.assign(fields, quotas(b.quotas)); changes.push('quotas'); }
    const list = containerList(b.containers);
    db.transaction(() => {
      users.update(t.id, fields);
      if (list !== undefined) users.setContainers(t.id, (fields.role || t.role) === 'user' ? list : []);
    })();
    if (list !== undefined) {
      const before = t.containers;
      changes.push(`servers ${before.join(', ') || 'none'} -> ${list.join(', ') || 'none'}`);
      for (const c of before.filter((x) => !list.includes(x))) io.in(`user:${t.id}`).socketsLeave(`ct:${c}`);
      for (const c of list) io.in(`user:${t.id}`).socketsJoin(`ct:${c}`);
    }
    if (fields.role) kick(t.id); // new role: reconnect with the right rooms
    audit.log({ ...who(req), action: 'user_update', target: t.username, result: 'success', detail: changes.join('; ') || 'profile' });
    res.json({ user: users.byId(t.id) });
  }));

  router.post('/users/:id/:op(suspend|activate)', requireAdmin, wrap(async (req, res) => {
    const t = target(req);
    canManage(req, t);
    const op = req.params.op;
    if (t.id === req.session.id) throw bad('You cannot suspend yourself');
    if (op === 'suspend' && lastSuper(t)) throw bad('This is the last super admin');
    users.update(t.id, { status: op === 'suspend' ? 'suspended' : 'active' });
    if (op === 'suspend') { sessions.removeForUser(t.id); kick(t.id); }
    audit.log({ ...who(req), action: `user_${op}`, target: t.username, result: 'success' });
    res.json({ user: users.byId(t.id) });
  }));

  router.post('/users/:id/password', requireAdmin, wrap(async (req, res) => {
    const t = target(req);
    canManage(req, t);
    const problem = passwordProblem(req.body?.password);
    if (problem) throw bad(problem);
    users.setPassword(t.id, await hashPassword(req.body.password));
    sessions.removeForUser(t.id, t.id === req.session.id ? req.session.token_hash : '');
    if (t.id !== req.session.id) kick(t.id);
    audit.log({ ...who(req), action: 'user_password_reset', target: t.username, result: 'success' });
    res.json({ ok: true });
  }));

  router.delete('/users/:id', requireAdmin, wrap(async (req, res) => {
    const t = target(req);
    canManage(req, t);
    if (t.id === req.session.id) throw bad('You cannot delete yourself');
    if (lastSuper(t)) throw bad('Cannot delete the last super admin');
    if (req.body?.confirm !== t.username) throw bad(`Type "${t.username}" to confirm`);
    const doms = db.prepare('SELECT hostname FROM domains WHERE user_id = ?').all(t.id);
    if (doms.length) throw conflict(`Remove their domains first: ${doms.map((d) => d.hostname).join(', ')}`);
    const apps = db.prepare('SELECT COUNT(*) AS n FROM apps WHERE user_id = ?').get(t.id).n;
    users.remove(t.id); // sessions, keys, server assignments, app records go with it (ON DELETE CASCADE)
    kick(t.id);
    audit.log({ ...who(req), action: 'user_delete', target: t.username, result: 'success', detail: `servers kept: ${t.containers.join(', ') || 'none'}; ${apps} app record(s) removed` });
    res.json({ ok: true, serversKept: t.containers });
  }));

  // ---------- own account ----------
  router.put('/me/profile', wrap(async (req, res) => {
    const b = req.body ?? {};
    if (b.email && !EMAIL_RE.test(b.email)) throw bad('Email address looks wrong');
    users.update(req.session.id, { full_name: String(b.fullName ?? '').trim().slice(0, 100) || null, email: b.email || null });
    audit.log({ ...who(req), action: 'profile_update', target: req.session.username, result: 'success' });
    res.json({ user: users.byId(req.session.id) });
  }));

  router.post('/password', wrap(async (req, res) => {
    const { current, next } = req.body ?? {};
    const s = req.session;
    if (typeof current !== 'string' || !(await checkPassword(current, users.hashById(s.id)))) {
      audit.log({ ...who(req), action: 'password_change', result: 'failure', detail: 'wrong current password' });
      throw bad('Current password is wrong');
    }
    const problem = passwordProblem(next);
    if (problem) throw bad(problem);
    users.setPassword(s.id, await hashPassword(next));
    sessions.removeForUser(s.id, s.token_hash); // log out other devices
    audit.log({ ...who(req), action: 'password_change', result: 'success' });
    res.json({ ok: true });
  }));

  router.get('/me/sessions', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      sessions: sessions.listForUser(req.session.id).map((s) => ({
        id: sessionId(s.token_hash), current: s.token_hash === req.session.token_hash,
        createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, ip: s.ip, userAgent: s.user_agent,
      })),
    });
  });

  router.delete('/me/sessions/:sid', wrap(async (req, res) => {
    const sid = req.params.sid;
    const s = sessions.listForUser(req.session.id).find((x) => sessionId(x.token_hash) === sid);
    if (!s) throw notFound('No such session');
    if (s.token_hash === req.session.token_hash) throw bad('Use "Log out" to end this session');
    sessions.remove(s.token_hash);
    io.in(`sess:${s.token_hash}`).disconnectSockets(true);
    audit.log({ ...who(req), action: 'session_revoke', target: req.session.username, result: 'success', detail: s.ip });
    res.json({ ok: true });
  }));

  router.post('/me/sessions/revoke-others', (req, res) => {
    const others = sessions.listForUser(req.session.id).filter((s) => s.token_hash !== req.session.token_hash);
    sessions.removeForUser(req.session.id, req.session.token_hash);
    for (const s of others) io.in(`sess:${s.token_hash}`).disconnectSockets(true);
    audit.log({ ...who(req), action: 'session_revoke', target: req.session.username, result: 'success', detail: `${others.length} other session(s)` });
    res.json({ ok: true, revoked: others.length });
  });

  router.get('/me/activity', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ entries: audit.forUser(req.session.username, req.session.containers, 100) });
  });

  return { router };
}
