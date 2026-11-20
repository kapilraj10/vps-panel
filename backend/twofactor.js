// Two-factor login (TOTP, RFC 6238: 6 digits, 30 s, SHA-1, as Google Authenticator / Authy / 1Password use).
// The secret is stored AES-256-GCM encrypted; a code is accepted once (replays within the window are refused).
// Ten single-use recovery codes are shown once and stored only as SHA-256 hashes.
// Login: password OK -> short-lived ticket (5 min, 5 tries) -> code -> session.
import express from 'express';
import crypto from 'node:crypto';
import { users, sessions, audit, settings } from './db.js';
import { seal, open as unseal } from './secrets.js';
import { checkPassword, clientIp, requireSuperAdmin, isAdmin, loginLimit } from './auth.js';
import { wrap, bad, forbidden, notFound } from './http.js';
import { toBase32, verifyTotp } from './totp.js';

const ISSUER = 'Kapil Cloud';

const hash = (c) => crypto.createHash('sha256').update(c.replace(/[^a-z0-9]/gi, '').toLowerCase()).digest('hex');
const newRecovery = () => Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/^(.{5})/, '$1-'));

const pending = new Map(); // userId -> { secret, expires } (setup not confirmed yet)
const tickets = new Map(); // sha256(ticket) -> { userId, ip, expires, tries }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}, 60_000).unref();

export const twoFactorOn = (userId) => !!users.twoFactor(userId)?.totp_enabled_at;

// Checks a TOTP or recovery code for a user and consumes it. Returns 'totp' | 'recovery' | null.
export function checkCode(userId, code) {
  const t = users.twoFactor(userId);
  if (!t?.totp_enabled_at) return null;
  const c = String(code || '').trim();
  if (/^\d{6}$/.test(c)) {
    const step = verifyTotp(Buffer.from(unseal(t.totp_secret_enc), 'base64'), c, t.totp_last_step);
    if (step == null) return null;
    users.setTwoFactor(userId, { secretEnc: t.totp_secret_enc, enabledAt: t.totp_enabled_at, lastStep: step, recovery: t.totp_recovery });
    return 'totp';
  }
  const list = JSON.parse(t.totp_recovery || '[]');
  const h = hash(c);
  if (c.length < 8 || !list.includes(h)) return null;
  users.setTwoFactor(userId, { secretEnc: t.totp_secret_enc, enabledAt: t.totp_enabled_at, lastStep: t.totp_last_step, recovery: JSON.stringify(list.filter((x) => x !== h)) });
  return 'recovery';
}

export const loginTickets = {
  issue(userId, ip) {
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(hash(ticket), { userId, ip, expires: Date.now() + 5 * 60_000, tries: 0 });
    return ticket;
  },
  // -> { userId, method } on success; throws with a user-facing message otherwise
  redeem(ticket, code, ip) {
    const k = typeof ticket === 'string' && ticket.length < 100 ? hash(ticket) : '';
    const t = tickets.get(k);
    if (!t || t.expires < Date.now()) { tickets.delete(k); throw Object.assign(new Error('The login step expired. Enter your password again.'), { status: 401 }); }
    const method = checkCode(t.userId, code);
    if (!method) {
      t.tries += 1;
      loginLimit.fail(ip);
      if (t.tries >= 5) tickets.delete(k);
      throw Object.assign(new Error(t.tries >= 5 ? 'Too many wrong codes. Enter your password again.' : 'Wrong code'), { status: 401, userId: t.userId });
    }
    tickets.delete(k);
    return { userId: t.userId, method };
  },
};

// Admins must have 2FA when require_2fa_admins is on. Until they do, only these paths work.
const SETUP_PATHS = /^\/api\/(me(\/2fa.*)?|password|logout)$/;
export const mustSetup = (s) => !!s && isAdmin(s) && settings.get('require_2fa_admins') === true && !twoFactorOn(s.id);
export function enforceTwoFactor(req, res, next) {
  if (!req.path.startsWith('/api/') || SETUP_PATHS.test(req.path) || !mustSetup(req.session)) return next();
  return res.status(403).json({ error: 'Two-factor login is required for admins. Set it up on the Security page first.', code: '2fa_required' });
}

export function createTwoFactor({ kickUser }) {
  const router = express.Router();
  const log = (req, action, target = null, detail = null, result = 'success') => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });
  const passwordOk = async (req) => {
    const h = users.hashById(req.session.id);
    return typeof req.body?.password === 'string' && req.body.password.length <= 200 && h && checkPassword(req.body.password, h);
  };

  router.get('/me/2fa', (req, res) => {
    const t = users.twoFactor(req.session.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: !!t?.totp_enabled_at, enabledAt: t?.totp_enabled_at || null, recoveryLeft: t?.totp_enabled_at ? JSON.parse(t.totp_recovery || '[]').length : 0,
      required: isAdmin(req.session) && settings.get('require_2fa_admins') === true,
    });
  });

  router.post('/me/2fa/setup', wrap(async (req, res) => {
    if (twoFactorOn(req.session.id)) throw bad('Two-factor login is already on. Turn it off first to change the app.');
    if (!(await passwordOk(req))) throw bad('Wrong password');
    const secret = crypto.randomBytes(20);
    pending.set(req.session.id, { secret, expires: Date.now() + 10 * 60_000 });
    const b32 = toBase32(secret);
    const label = encodeURIComponent(`${ISSUER}:${req.session.username}`);
    res.set('Cache-Control', 'no-store');
    res.json({ secret: b32.match(/.{1,4}/g).join(' '), uri: `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30` });
  }));

  router.post('/me/2fa/enable', (req, res) => {
    const p = pending.get(req.session.id);
    if (!p || p.expires < Date.now()) throw bad('Setup expired. Start again.');
    const step = verifyTotp(p.secret, req.body?.code);
    if (step == null) { log(req, '2fa_enable', null, 'wrong code', 'failure'); throw bad('That code is not right. Check the time on your phone and try the next code.'); }
    const codes = newRecovery();
    users.setTwoFactor(req.session.id, { secretEnc: seal(p.secret.toString('base64')), enabledAt: Date.now(), lastStep: step, recovery: JSON.stringify(codes.map(hash)) });
    pending.delete(req.session.id);
    sessions.removeForUser(req.session.id, req.session.token_hash); // other devices must log in again, with the code
    kickUser(req.session.id, req.session.token_hash);
    log(req, '2fa_enable');
    res.json({ ok: true, recoveryCodes: codes });
  });

  router.post('/me/2fa/recovery', wrap(async (req, res) => {
    if (!twoFactorOn(req.session.id)) throw bad('Two-factor login is off');
    if (!(await passwordOk(req)) || checkCode(req.session.id, req.body?.code) !== 'totp') throw bad('Wrong password or code');
    const t = users.twoFactor(req.session.id);
    const codes = newRecovery();
    users.setTwoFactor(req.session.id, { secretEnc: t.totp_secret_enc, enabledAt: t.totp_enabled_at, lastStep: t.totp_last_step, recovery: JSON.stringify(codes.map(hash)) });
    log(req, '2fa_recovery_codes');
    res.json({ ok: true, recoveryCodes: codes });
  }));

  router.post('/me/2fa/disable', wrap(async (req, res) => {
    if (!twoFactorOn(req.session.id)) throw bad('Two-factor login is already off');
    if (isAdmin(req.session) && settings.get('require_2fa_admins') === true) throw forbidden('Two-factor login is required for admins (Settings)');
    if (!(await passwordOk(req)) || !checkCode(req.session.id, req.body?.code)) { log(req, '2fa_disable', null, 'wrong password or code', 'failure'); throw bad('Wrong password or code'); }
    users.setTwoFactor(req.session.id, {});
    log(req, '2fa_disable');
    res.json({ ok: true });
  }));

  // Lost phone: a super admin removes 2FA from another account (that account is logged out everywhere)
  router.post('/users/:id/2fa/reset', requireSuperAdmin, (req, res) => {
    const u = users.byId(Number(req.params.id));
    if (!u) throw notFound('No such user');
    if (u.id === req.session.id) throw bad('Use your own Security page for your account');
    if (req.body?.confirm !== u.username) throw bad(`Type "${u.username}" exactly to confirm`);
    users.setTwoFactor(u.id, {});
    sessions.removeForUser(u.id);
    kickUser(u.id);
    log(req, '2fa_reset', u.username);
    res.json({ ok: true });
  });

  // require_2fa_admins: only a super admin, and only once they use 2FA themselves (no locking yourself out)
  router.put('/settings/require-2fa', requireSuperAdmin, (req, res) => {
    const on = req.body?.enabled === true;
    if (on && !twoFactorOn(req.session.id)) throw bad('Turn on two-factor login for your own account first');
    settings.set('require_2fa_admins', on, req.session.username);
    log(req, 'settings_update', 'require_2fa_admins', String(on));
    res.json({ ok: true, enabled: on });
  });

  return { router };
}
