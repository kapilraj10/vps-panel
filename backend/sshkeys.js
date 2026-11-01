// SSH public keys. Stored per user and written into their servers' authorized_keys between marker lines,
// so keys that were already there (added by hand) are never removed.
import express from 'express';
import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { readFile, writeFile } from './lxd.js';
import { clientIp, ownsContainer } from './auth.js';
import { wrap, bad, forbidden, notFound, conflict, str } from './http.js';

const BEGIN = '# BEGIN KAPIL CLOUD MANAGED KEYS (edit in the panel)';
const END = '# END KAPIL CLOUD MANAGED KEYS';
const TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
const LOGIN_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

// Validates an OpenSSH public key line; returns { type, blob, fingerprint, comment }
export function parseKey(line) {
  const parts = String(line || '').trim().split(/\s+/);
  if (parts.length < 2 || !TYPES.includes(parts[0])) throw bad(`Key must start with one of: ${TYPES.slice(0, 3).join(', ')}…`);
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(parts[1])) throw bad('The key data is not valid base64');
  const blob = Buffer.from(parts[1], 'base64');
  // The blob starts with its own type name (length-prefixed); it must match the declared type
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  if (len < 1 || len > 64 || blob.subarray(4, 4 + len).toString() !== parts[0]) throw bad('The key data does not match its type');
  if (parts[0] === 'ssh-rsa' && blob.length < 270) throw bad('RSA keys must be at least 2048 bits');
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { type: parts[0], data: parts[1], fingerprint, comment: parts.slice(2).join(' ').slice(0, 100) };
}

// Replaces only the managed block of an authorized_keys file
export function mergeAuthorizedKeys(existing, lines) {
  const text = existing || '';
  const block = `${BEGIN}\n${lines.join('\n')}${lines.length ? '\n' : ''}${END}\n`;
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + END.length).replace(/^\n/, '');
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}`;
}

export function createSshKeys({ containers }) {
  const router = express.Router();
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });

  const list = (userId) => db.prepare('SELECT id, name, fingerprint, public_key, created_at FROM ssh_keys WHERE user_id = ? ORDER BY created_at').all(userId);

  router.get('/ssh-keys', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ keys: list(req.session.id).map((k) => ({ ...k, type: k.public_key.split(' ')[0] })) });
  });

  router.post('/ssh-keys', wrap(async (req, res) => {
    const name = str(req.body?.name, { max: 60, name: 'Name' });
    const k = parseKey(req.body?.publicKey);
    if (list(req.session.id).length >= 30) throw bad('At most 30 keys');
    if (db.prepare('SELECT 1 FROM ssh_keys WHERE user_id = ? AND fingerprint = ?').get(req.session.id, k.fingerprint)) throw conflict('You already added this key');
    const line = `${k.type} ${k.data} ${k.comment || name}`.replace(/[\r\n]/g, '');
    db.prepare('INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)').run(req.session.id, name, line, k.fingerprint, Date.now());
    audit.log({ ...who(req), action: 'ssh_key_add', target: name, result: 'success', detail: k.fingerprint });
    res.status(201).json({ ok: true, fingerprint: k.fingerprint });
  }));

  router.delete('/ssh-keys/:id', wrap(async (req, res) => {
    const k = db.prepare('SELECT * FROM ssh_keys WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.session.id);
    if (!k) throw notFound('No such key');
    db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(k.id);
    audit.log({ ...who(req), action: 'ssh_key_remove', target: k.name, result: 'success', detail: `${k.fingerprint}. Run "Sync to server" to remove it from servers.` });
    res.json({ ok: true });
  }));

  // Writes the user's keys into <login>'s authorized_keys on one of their servers
  router.post('/ssh-keys/sync', wrap(async (req, res) => {
    const container = typeof req.body?.container === 'string' ? req.body.container : '';
    if (!ownsContainer(req.session, container) || !containers.exists(container)) throw forbidden('Pick one of your servers');
    const login = typeof req.body?.login === 'string' && req.body.login ? req.body.login : 'root';
    if (!LOGIN_RE.test(login)) throw bad('Invalid login name');
    const passwd = await readFile(container, '/etc/passwd');
    if (!passwd) throw conflict('Could not read /etc/passwd in the server');
    const entry = passwd.content.toString('utf8').split('\n').map((l) => l.split(':')).find((f) => f[0] === login);
    if (!entry) throw bad(`There is no user "${login}" in ${container}`);
    const uid = Number(entry[2]);
    const gid = Number(entry[3]);
    const home = entry[5];
    if (!/^\/[A-Za-z0-9._/-]*$/.test(home) || home.includes('..')) throw conflict(`Unusual home folder for ${login}`);
    const dir = `${home.replace(/\/$/, '')}/.ssh`;
    const file = `${dir}/authorized_keys`;
    const dirInfo = await readFile(container, dir).catch(() => null);
    if (!dirInfo) await writeFile(container, dir, '', { uid, gid, mode: '0700', type: 'directory' });
    else if (dirInfo.type && dirInfo.type !== 'directory') throw conflict(`${dir} exists but is not a folder`);
    const cur = await readFile(container, file);
    const lines = list(req.session.id).map((k) => k.public_key);
    const next = mergeAuthorizedKeys(cur?.content.toString('utf8') || '', lines);
    await writeFile(container, file, next, { uid, gid, mode: '0600' });
    audit.log({ ...who(req), action: 'ssh_key_sync', target: container, result: 'success', detail: `${lines.length} key(s) for ${login}` });
    res.json({ ok: true, count: lines.length, file });
  }));

  return { router };
}
