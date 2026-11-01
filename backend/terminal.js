// Browser terminal: a PTY inside ONE container (LXD exec), relayed over the authenticated Socket.IO connection.
// It never runs anything on the host. Containers are unprivileged, so root inside is not root on the host;
// privileged containers are refused for non-admins because root inside one IS close to root on the host.
import crypto from 'node:crypto';
import { execInteractive } from './lxd.js';
import { sessions, audit, settings } from './db.js';
import { isAdmin, ownsContainer } from './auth.js';

const MAX_PER_USER = 3;
const MAX_INPUT = 64 * 1024;

export function createTerminal({ containers }) {
  const open = new Map(); // id -> term
  const countFor = (userId) => [...open.values()].filter((t) => t.userId === userId).length;

  function closeTerm(id, reason) {
    const t = open.get(id);
    if (!t) return;
    open.delete(id);
    clearTimeout(t.idleTimer);
    clearTimeout(t.maxTimer);
    try { t.handle.close(); } catch { /* already gone */ }
    if (t.socket.connected) t.socket.emit('term:exit', { id, reason });
    audit.log({
      username: t.username, ip: t.ip, action: 'terminal_close', target: t.container, result: 'success',
      detail: `${reason}; ${Math.round((Date.now() - t.startedAt) / 1000)}s`,
    });
  }

  function armIdle(t) {
    clearTimeout(t.idleTimer);
    const mins = Number(settings.get('terminal_idle_minutes')) || 15;
    t.idleTimer = setTimeout(() => closeTerm(t.id, `idle for ${mins} minutes`), mins * 60_000);
  }

  function attach(socket, ip) {
    socket.on('term:open', async (msg, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      // Re-read the session: it may have been revoked or the user suspended since the socket connected
      const s = sessions.find(socket.data.session.token_hash);
      if (!s) return reply({ error: 'Your session ended. Log in again.' });
      const name = typeof msg?.container === 'string' ? msg.container : '';
      if (!ownsContainer(s, name)) return reply({ error: 'You can only open a terminal on your own servers' });
      if (!containers.exists(name)) return reply({ error: 'No such server' });
      const snap = containers.snapshot(name);
      if (snap?.status !== 'Running') return reply({ error: 'Start the server first' });
      if (!isAdmin(s) && containers.facts(name)?.privileged) {
        audit.log({ username: s.username, ip, action: 'terminal_open', target: name, result: 'failure', detail: 'privileged container' });
        return reply({ error: 'This server runs privileged, so the web terminal is disabled for it. Ask the admin.' });
      }
      if (countFor(s.id) >= MAX_PER_USER) return reply({ error: `At most ${MAX_PER_USER} terminals at once. Close one first.` });
      const cols = Math.min(500, Math.max(20, Number(msg?.cols) || 80));
      const rows = Math.min(200, Math.max(5, Number(msg?.rows) || 24));
      let handle;
      try {
        handle = await execInteractive(name, {
          command: ['/bin/sh', '-c', 'if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi'],
          cols, rows,
        });
      } catch (err) {
        audit.log({ username: s.username, ip, action: 'terminal_open', target: name, result: 'failure', detail: err.message });
        return reply({ error: `Could not open a terminal: ${err.message}` });
      }
      const id = crypto.randomUUID();
      const t = { id, handle, socket, container: name, userId: s.id, username: s.username, ip, startedAt: Date.now() };
      open.set(id, t);
      handle.pty.on('message', (data) => socket.emit('term:data', { id, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));
      handle.pty.on('close', () => closeTerm(id, 'shell exited'));
      handle.done.then(() => closeTerm(id, 'shell exited'));
      armIdle(t);
      const maxMins = Number(settings.get('terminal_max_minutes')) || 240;
      t.maxTimer = setTimeout(() => closeTerm(id, `session limit of ${maxMins} minutes reached`), maxMins * 60_000);
      audit.log({ username: s.username, ip, action: 'terminal_open', target: name, result: 'success' });
      return reply({ id });
    });

    const mine = (id) => {
      const t = open.get(id);
      return t && t.socket === socket ? t : null;
    };

    socket.on('term:input', (msg) => {
      const t = mine(msg?.id);
      if (!t || typeof msg.data !== 'string' || msg.data.length > MAX_INPUT) return;
      armIdle(t);
      t.handle.write(msg.data);
    });

    socket.on('term:resize', (msg) => {
      const t = mine(msg?.id);
      const c = Number(msg?.cols);
      const r = Number(msg?.rows);
      if (t && Number.isInteger(c) && Number.isInteger(r) && c >= 20 && c <= 500 && r >= 5 && r <= 200) t.handle.resize(c, r);
    });

    socket.on('term:close', (msg) => { if (mine(msg?.id)) closeTerm(msg.id, 'closed by user'); });

    socket.on('disconnect', () => {
      for (const t of [...open.values()]) if (t.socket === socket) closeTerm(t.id, 'browser disconnected');
    });
  }

  // Closes every terminal of a user (suspend, delete, password reset)
  const closeForUser = (userId, reason) => { for (const t of [...open.values()]) if (t.userId === userId) closeTerm(t.id, reason); };
  const list = () => [...open.values()].map((t) => ({ id: t.id, container: t.container, username: t.username, startedAt: t.startedAt }));

  return { attach, closeForUser, list, closeTerm };
}
