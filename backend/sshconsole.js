// SSHService + TerminalService for VPS nodes: browser console (xterm.js over the authenticated Socket.IO connection)
// relayed to an SSH session that the CONTROL PLANE opens with its own key. The browser never sees a key or password.
//
// Keys: one panel key pair (ed25519), generated on first use; the private key is stored AES-256-GCM encrypted in
// settings and never leaves the server. Install its public key in ~<ssh user>/.ssh/authorized_keys on each node.
// A node can instead have its own private key (uploaded once, encrypted, never shown again).
// Host keys: trust on first use. "Test SSH" pins the server's host key fingerprint; afterwards a different key is
// refused (possible man-in-the-middle) until a super admin explicitly forgets the pinned key.
// Console sessions: super admin only; idle + max timeouts; survive a short browser disconnect (reattach within 2 min,
// recent output replayed). Typed command lines are recorded (best effort) in terminal_commands, EXCEPT after a
// password prompt, so sudo passwords are not stored.
import express from 'express';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { db, audit, settings, sessions } from './db.js';
import { seal, open as unseal } from './secrets.js';
import { requireSuperAdmin, requireAdmin, clientIp, isSuperAdmin } from './auth.js';
import { wrap, bad, notFound, HttpError } from './http.js';
import { nodesDb } from './nodes.js';

const { Client, utils } = ssh2;
const MAX_PER_USER = 8;
const DETACH_MS = 2 * 60_000;
const REPLAY_BYTES = 64 * 1024;
const PASSWORD_PROMPT = /(pass(word|phrase)|PIN|token|secret)[^\n]{0,40}:\s*$/i;

function panelKey() {
  let k = settings.get('ssh_panel_key');
  if (!k) {
    const pair = utils.generateKeyPairSync('ed25519', { comment: 'kapil-cloud-panel' });
    k = { private: seal(pair.private), public: pair.public.trim(), createdAt: Date.now() };
    db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('ssh_panel_key', ?, ?, 'system')
      ON CONFLICT(key) DO NOTHING`).run(JSON.stringify(k), Date.now());
    k = settings.get('ssh_panel_key') || k; // another request may have won the race
  }
  return k;
}
const fingerprint = (keyBuf) => `SHA256:${crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')}`;

function privateKeyFor(n) {
  if (n.ssh_key_enc) {
    const k = JSON.parse(unseal(n.ssh_key_enc));
    return { privateKey: k.key, passphrase: k.passphrase || undefined };
  }
  return { privateKey: unseal(panelKey().private) };
}

// Opens an SSH connection with host-key pinning. pin=true stores the key on first use (Test SSH only).
function connect(n, { pin = false, timeout = 10_000 } = {}) {
  if (!n.public_ip) throw new HttpError(400, `${n.name} has no public IP / hostname`);
  if (!n.ssh_user) throw new HttpError(400, `${n.name} has no SSH user`);
  if (!pin && !n.ssh_host_key) throw new HttpError(409, `Run "Test SSH" on ${n.name} first, to check and pin its host key`);
  return new Promise((resolve, reject) => {
    const c = new Client();
    let seen = null;
    let mismatch = false;
    c.on('ready', () => resolve({ conn: c, hostKey: seen }));
    c.on('error', (e) => reject(new HttpError(mismatch ? 409 : 502, mismatch
      ? `Host key of ${n.name} changed (now ${seen}, pinned ${n.ssh_host_key}). Possible man-in-the-middle. If you reinstalled the server, forget the pinned key and test again.`
      : `SSH to ${n.name} failed: ${e.level === 'client-authentication' ? `the server refused the key for user ${n.ssh_user} (is the panel key in authorized_keys?)` : e.message}`)));
    try {
      c.connect({
        host: n.public_ip, port: n.ssh_port, username: n.ssh_user, readyTimeout: timeout, keepaliveInterval: 15_000, keepaliveCountMax: 4,
        ...privateKeyFor(n),
        hostVerifier: (key) => {
          seen = fingerprint(key);
          if (n.ssh_host_key && n.ssh_host_key !== seen) { mismatch = true; return false; }
          return true;
        },
      });
    } catch (e) {
      reject(new HttpError(400, `SSH key problem: ${e.message}`));
    }
  });
}

function execOnce(conn, command, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('command timed out')), timeout);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(t); return reject(err); }
      let out = '';
      stream.on('data', (d) => { if (out.length < 20_000) out += d; });
      stream.stderr.on('data', (d) => { if (out.length < 20_000) out += d; });
      stream.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
      return undefined;
    });
  });
}

export function createSshConsole() {
  const router = express.Router();
  const open = new Map(); // id -> session

  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });
  const getNode = (id) => { const n = nodesDb.get(Number(id)); if (!n) throw notFound('No such server'); return n; };

  router.get('/ssh/public-key', requireAdmin, (_req, res) => {
    const k = panelKey();
    res.json({ publicKey: k.public, fingerprint: fingerprint(utils.parseKey(k.public).getPublicSSH()) });
  });

  // Test SSH: connect, pin the host key (first time), run a fixed read-only command
  router.post('/nodes/:id/ssh/test', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    const t0 = Date.now();
    let conn;
    try {
      const r = await connect(n, { pin: true });
      conn = r.conn;
      const first = !n.ssh_host_key;
      if (first) db.prepare('UPDATE nodes SET ssh_host_key = ? WHERE id = ?').run(r.hostKey, n.id);
      const out = await execOnce(conn, 'uname -srm; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uptime');
      log(req, 'node_ssh_test', n.name, first ? `host key pinned ${r.hostKey}` : 'ok');
      res.json({ ok: true, ms: Date.now() - t0, hostKey: r.hostKey, pinnedNow: first, output: out.out.trim() });
    } catch (e) {
      log(req, 'node_ssh_test', n.name, e.message, 'failure');
      throw e;
    } finally {
      conn?.end();
    }
  }));

  router.post('/nodes/:id/ssh/forget-host-key', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    if (req.body?.confirm !== n.name) throw bad(`Type "${n.name}" exactly to confirm`);
    db.prepare('UPDATE nodes SET ssh_host_key = NULL WHERE id = ?').run(n.id);
    log(req, 'node_ssh_forget_host_key', n.name, n.ssh_host_key);
    res.json({ ok: true });
  }));

  // Per-node private key (optional). Stored encrypted; never returned. Empty = go back to the panel key.
  router.put('/nodes/:id/ssh/key', requireSuperAdmin, wrap(async (req, res) => {
    const n = getNode(req.params.id);
    const key = typeof req.body?.privateKey === 'string' ? req.body.privateKey.trim() : '';
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
    if (!key) {
      db.prepare('UPDATE nodes SET ssh_key_enc = NULL WHERE id = ?').run(n.id);
      log(req, 'node_ssh_key', n.name, 'uses the panel key again');
      return res.json({ ok: true });
    }
    if (key.length > 16_000) throw bad('Key is too large');
    const parsed = utils.parseKey(key, passphrase || undefined);
    if (parsed instanceof Error || !parsed.isPrivateKey?.()) throw bad(`Not a usable private key${parsed instanceof Error ? `: ${parsed.message}` : ''}`);
    db.prepare('UPDATE nodes SET ssh_key_enc = ? WHERE id = ?').run(seal(JSON.stringify({ key, passphrase })), n.id);
    log(req, 'node_ssh_key', n.name, `own ${parsed.type} key`);
    return res.json({ ok: true });
  }));

  router.get('/terminal-sessions', requireAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const rows = db.prepare('SELECT s.*, (SELECT COUNT(*) FROM terminal_commands c WHERE c.session_id = s.id) AS commands FROM terminal_sessions s ORDER BY started_at DESC LIMIT 100').all();
    res.json({ sessions: rows.map((r) => ({ ...r, live: open.has(r.id) })) });
  });
  router.get('/terminal-sessions/:id/commands', requireSuperAdmin, (req, res) => {
    res.json({ commands: db.prepare('SELECT ts, line FROM terminal_commands WHERE session_id = ? ORDER BY id').all(String(req.params.id).slice(0, 64)) });
  });

  // ---------- live sessions over Socket.IO ----------
  function finish(t, reason) {
    if (!open.has(t.id)) return;
    open.delete(t.id);
    clearTimeout(t.idleTimer); clearTimeout(t.maxTimer); clearTimeout(t.detachTimer);
    try { t.stream?.close(); } catch { /* gone */ }
    try { t.conn.end(); } catch { /* gone */ }
    db.prepare('UPDATE terminal_sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(Date.now(), reason, t.id);
    t.socket?.emit('ssh:exit', { id: t.id, reason });
    audit.log({ username: t.username, ip: t.ip, action: 'ssh_close', target: t.nodeName, result: 'success', detail: `${reason}; ${Math.round((Date.now() - t.startedAt) / 1000)}s` });
  }
  function armIdle(t) {
    clearTimeout(t.idleTimer);
    const mins = Number(settings.get('terminal_idle_minutes')) || 15;
    t.idleTimer = setTimeout(() => finish(t, `idle for ${mins} minutes`), mins * 60_000);
  }
  // Command line capture: printable input up to Enter; skipped while the output just asked for a password
  function captureInput(t, data) {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = t.line.trim();
        if (line && !t.secretPrompt) db.prepare('INSERT INTO terminal_commands (session_id, ts, line) VALUES (?, ?, ?)').run(t.id, Date.now(), line.slice(0, 1000));
        t.line = '';
        t.secretPrompt = false;
      } else if (ch === '\x7f' || ch === '\b') t.line = t.line.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') t.line = '';
      else if (ch >= ' ' && t.line.length < 2000 && !data.startsWith('\x1b')) t.line += ch;
    }
  }

  function attach(socket, ip) {
    const fresh = () => sessions.find(socket.data.session.token_hash);
    const bind = (t) => {
      t.socket = socket;
      clearTimeout(t.detachTimer);
      t.detachTimer = null;
    };

    socket.on('ssh:open', async (msg, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const s = fresh();
      if (!s) return reply({ error: 'Your session ended. Log in again.' });
      if (!isSuperAdmin(s)) return reply({ error: 'Only a super admin can open a server console' });
      const n = nodesDb.get(Number(msg?.nodeId));
      if (!n) return reply({ error: 'No such server' });
      if ([...open.values()].filter((t) => t.userId === s.id).length >= MAX_PER_USER) return reply({ error: `At most ${MAX_PER_USER} consoles at once` });
      const cols = Math.min(500, Math.max(20, Number(msg?.cols) || 80));
      const rows = Math.min(200, Math.max(5, Number(msg?.rows) || 24));
      let conn;
      try {
        ({ conn } = await connect(n));
      } catch (e) {
        audit.log({ username: s.username, ip, action: 'ssh_open', target: n.name, result: 'failure', detail: e.message });
        return reply({ error: e.message });
      }
      const id = crypto.randomUUID();
      const t = { id, conn, stream: null, socket, userId: s.id, username: s.username, ip, nodeId: n.id, nodeName: n.name, startedAt: Date.now(), replay: [], replayBytes: 0, line: '', secretPrompt: false };
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) { conn.end(); return reply({ error: `Could not start a shell: ${err.message}` }); }
        t.stream = stream;
        open.set(id, t);
        db.prepare('INSERT INTO terminal_sessions (id, user_id, username, node_id, node_name, ip, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.id, s.username, n.id, n.name, ip, t.startedAt);
        const out = (d) => {
          t.replay.push(d); t.replayBytes += d.length;
          while (t.replayBytes > REPLAY_BYTES && t.replay.length > 1) t.replayBytes -= t.replay.shift().length;
          const tailText = d.toString('utf8').slice(-80);
          if (PASSWORD_PROMPT.test(tailText)) t.secretPrompt = true;
          t.socket?.emit('ssh:data', { id, data: d });
        };
        stream.on('data', out);
        stream.stderr.on('data', out);
        stream.on('close', () => finish(t, 'shell exited'));
        conn.on('close', () => finish(t, 'connection closed'));
        armIdle(t);
        const maxMins = Number(settings.get('terminal_max_minutes')) || 240;
        t.maxTimer = setTimeout(() => finish(t, `session limit of ${maxMins} minutes reached`), maxMins * 60_000);
        audit.log({ username: s.username, ip, action: 'ssh_open', target: n.name, result: 'success', detail: `${n.ssh_user}@${n.public_ip}:${n.ssh_port}` });
        return reply({ id, node: { id: n.id, name: n.name } });
      });
      return undefined;
    });

    // Re-attach after a browser reconnect (same user only); recent output is replayed
    socket.on('ssh:attach', (msg, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const s = fresh();
      const t = open.get(msg?.id);
      if (!s || !t || t.userId !== s.id) return reply({ error: 'That console is gone' });
      bind(t);
      armIdle(t);
      reply({ id: t.id, node: { id: t.nodeId, name: t.nodeName } });
      socket.emit('ssh:data', { id: t.id, data: Buffer.concat(t.replay) });
      return undefined;
    });

    const mine = (id) => { const t = open.get(id); return t && t.socket === socket ? t : null; };
    socket.on('ssh:input', (msg) => {
      const t = mine(msg?.id);
      if (!t || typeof msg.data !== 'string' || msg.data.length > 64 * 1024) return;
      armIdle(t);
      captureInput(t, msg.data);
      t.stream.write(msg.data);
    });
    socket.on('ssh:resize', (msg) => {
      const t = mine(msg?.id);
      const c = Number(msg?.cols);
      const r = Number(msg?.rows);
      if (t && Number.isInteger(c) && Number.isInteger(r) && c >= 20 && c <= 500 && r >= 5 && r <= 200) t.stream.setWindow(r, c, 0, 0);
    });
    socket.on('ssh:close', (msg) => { const t = mine(msg?.id); if (t) finish(t, 'closed by user'); });
    socket.on('disconnect', () => {
      for (const t of open.values()) {
        if (t.socket !== socket) continue;
        t.socket = null;
        t.detachTimer = setTimeout(() => finish(t, 'browser did not come back'), DETACH_MS);
      }
    });
  }

  const closeForUser = (userId, reason) => { for (const t of [...open.values()]) if (t.userId === userId) finish(t, reason); };
  const list = () => [...open.values()].map((t) => ({ id: t.id, node: t.nodeName, username: t.username, startedAt: t.startedAt, attached: !!t.socket }));

  return { router, attach, closeForUser, list };
}
