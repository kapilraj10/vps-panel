// Master server: registers the machine the panel runs on as the primary fleet server, and makes the SSH console able to
// open a shell on it (host terminal for super admins).
//
// The panel already runs as this machine's user (in the lxd and docker groups, so root-equivalent), so letting the panel's
// own SSH key log in as that same user adds no new power. The key goes into a marked block of the user's
// ~/.ssh/authorized_keys. The console then runs through the existing SSH console (super admin only, sessions + commands audited).
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { requireSuperAdmin, clientIp } from './auth.js';
import { wrap, bad, int, str } from './http.js';
import { nodesDb } from './nodes.js';

const BEGIN = '# >>> kapil-cloud panel console (managed by the panel; remove these lines to revoke) >>>';
const END = '# <<< kapil-cloud panel console <<<';
const TEXT_RE = /^[^\u0000-\u001f<>]{0,80}$/;

// Writes `publicKey` into the marked block of ~/.ssh/authorized_keys. Other lines are kept as they are.
export function installPanelKey(publicKey, home = os.homedir()) {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [\w.@-]+)?$/.test(publicKey)) throw bad('The panel key does not look like an ed25519 public key');
  const dir = path.join(home, '.ssh');
  const file = path.join(dir, 'authorized_keys');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = old.split('\n');
  const a = lines.indexOf(BEGIN);
  const b = lines.indexOf(END);
  const rest = a >= 0 && b > a ? [...lines.slice(0, a), ...lines.slice(b + 1)] : lines;
  while (rest.length && rest.at(-1) === '') rest.pop();
  const next = `${[...rest, BEGIN, publicKey, END].join('\n')}\n`;
  if (next === old) return { file, changed: false };
  const tmp = `${file}.kapil-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { file, changed: true };
}

export function createMaster({ sshConsole, nodes }) {
  const router = express.Router();
  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });

  // One click: primary node (name, location), SSH to 127.0.0.1 as the panel user with the panel key, host key pinned
  router.post('/fleet/master/setup', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const location = b.location !== undefined ? (b.location ? str(b.location, { max: 80, name: 'Location', re: TEXT_RE }) : null) : 'Kathmandu';
    const sshPort = int(b.sshPort ?? 22, { min: 1, max: 65535, name: 'SSH port' });
    const user = os.userInfo().username;
    const now = Date.now();
    let n = db.prepare('SELECT * FROM nodes WHERE is_primary = 1').get();
    if (!n) {
      const name = (b.name ? str(b.name, { max: 63, name: 'Name', re: /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/ }) : os.hostname().slice(0, 63)) || 'master';
      if (db.prepare('SELECT 1 FROM nodes WHERE name = ?').get(name)) throw bad(`A server named ${name} already exists. Make it primary on its page, then run this again.`);
      db.prepare(`INSERT INTO nodes (uid, name, provider, location, public_ip, ssh_port, ssh_user, notes, is_primary, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?, ?, 1, ?, ?, ?)`).run(crypto.randomUUID(), name, 'self-hosted', location, sshPort, user,
        'The server this panel runs on', req.session.username, now, now);
      n = db.prepare('SELECT * FROM nodes WHERE is_primary = 1').get();
    } else {
      // keep an address the admin set; the console only needs one that reaches this machine's sshd
      db.prepare(`UPDATE nodes SET location = COALESCE(?, location), public_ip = COALESCE(public_ip, '127.0.0.1'), ssh_user = COALESCE(ssh_user, ?),
        ssh_port = CASE WHEN public_ip IS NULL THEN ? ELSE ssh_port END, updated_at = ? WHERE id = ?`).run(location, user, sshPort, now, n.id);
      n = nodesDb.get(n.id);
    }
    const key = installPanelKey(sshConsole.publicKey());
    let ssh;
    try {
      ssh = await sshConsole.test(n.id);
    } catch (e) {
      ssh = { ok: false, error: e.message };
    }
    log(req, 'master_setup', n.name, `${location || '-'}; key ${key.changed ? 'added to' : 'already in'} ${key.file}; ssh ${ssh.ok ? 'ok' : `failed: ${ssh.error}`}`, ssh.ok ? 'success' : 'failure');
    nodes.emitNode?.(nodesDb.get(n.id));
    res.json({
      node: nodes.view(nodesDb.get(n.id)), keyFile: key.file, keyAdded: key.changed, ssh,
      agentCommand: `curl -fsSL http://127.0.0.1:${process.env.PORT || 4000}/agent/v1/install.sh | sudo bash -s -- --master http://127.0.0.1:${process.env.PORT || 4000} --token <token from "Install agent">`,
    });
  }));

  return { router };
}
