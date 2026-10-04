// Sessions, login rate limiting and CSRF checks.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { sessions } from './db.js';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set in backend/.env (at least 32 characters). Generate one with: openssl rand -hex 32');
  process.exit(1);
}

export const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
// __Host- cookies must be Secure, so only use the prefix when they are
export const COOKIE_NAME = COOKIE_SECURE ? '__Host-panel_sid' : 'panel_sid';
const SESSION_MS = (Number(process.env.SESSION_HOURS) || 12) * 3600_000;
const BCRYPT_ROUNDS = 12;

// Only the HMAC of the cookie token is stored, so a leaked DB gives no usable sessions
const hashToken = (token) => crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);
// Compared against when the username does not exist, so timing does not reveal valid usernames
export const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

// The panel only listens on 127.0.0.1 behind Cloudflare Tunnel, so CF-Connecting-IP is set by Cloudflare
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  return (typeof cf === 'string' && cf.length < 64 && cf) || req.socket.remoteAddress || 'unknown';
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie: ignore */ }
  }
  return out;
}

export function sessionFromHeader(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return sessions.find(hashToken(token)) || null;
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  sessions.create(tokenHash, userId, csrf, SESSION_MS);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: SESSION_MS,
  });
  return tokenHash;
}

export function endSession(res, tokenHash) {
  sessions.remove(tokenHash);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', path: '/' });
}

// ---------- middleware ----------
export function loadSession(req, _res, next) {
  req.session = sessionFromHeader(req.headers.cookie);
  next();
}

export function requireAuth(req, res, next) {
  if (req.session) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in' });
  return res.redirect(302, '/login');
}

export function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  return res.status(403).json({ error: 'Admins only' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Requests that change something must come from our own pages: same Origin, and
// (once logged in) the per-session CSRF token in the X-CSRF-Token header.
export function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  if (!req.session) return next(); // requireAuth will reject it (login has its own path)
  const sent = req.get('x-csrf-token') || '';
  const ok = sent.length === req.session.csrf.length
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
  if (!ok) return res.status(403).json({ error: 'Missing or wrong CSRF token. Reload the page.' });
  return next();
}

// ---------- login rate limit: failed attempts per IP ----------
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const failures = new Map(); // ip -> [timestamps]

function recent(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) failures.set(ip, list); else failures.delete(ip);
  return list;
}

export const loginLimit = {
  // Seconds until the IP may try again, or 0 if it may try now
  retryAfter(ip) {
    const list = recent(ip);
    return list.length >= LOGIN_MAX ? Math.ceil((list[0] + LOGIN_WINDOW_MS - Date.now()) / 1000) : 0;
  },
  fail(ip) { failures.set(ip, [...recent(ip), Date.now()]); },
};

setInterval(() => {
  for (const ip of failures.keys()) recent(ip);
  sessions.purgeExpired();
}, 10 * 60_000).unref();
