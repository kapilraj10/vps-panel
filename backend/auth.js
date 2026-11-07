// Sessions, login rate limiting and CSRF checks.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { sessions, isAdminRole } from './db.js';

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
  const s = sessions.find(hashToken(token)) || null;
  // "Last active" for the Security page; written at most once a minute per session
  if (s && (!s.last_seen_at || Date.now() - s.last_seen_at > 60_000)) sessions.touch(s.token_hash);
  return s;
}

// Short, non-secret id for a session (shown on the Security page instead of the token hash)
export const sessionId = (tokenHash) => tokenHash.slice(0, 16);

export function startSession(res, userId, meta = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  sessions.create(tokenHash, userId, csrf, SESSION_MS, meta);
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

// ---------- role checks (RBAC). The role always comes from the DB via the session join. ----------
export const isAdmin = (s) => !!s && isAdminRole(s.role);
export const isSuperAdmin = (s) => s?.role === 'super_admin';
// Containers this session may touch: admins all, users only those assigned to them
export const ownsContainer = (s, name) => isAdmin(s) || (!!s && s.containers.includes(name));

export function requireAdmin(req, res, next) {
  if (isAdmin(req.session)) return next();
  return res.status(403).json({ error: 'Admins only' });
}

export function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req.session)) return next();
  return res.status(403).json({ error: 'Only a super admin can do this' });
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
  // IPs with recent failures (for the Security center); blocked = at the limit right now
  list() {
    return [...failures.keys()].map((ip) => {
      const l = recent(ip);
      return l.length ? { ip, failures: l.length, last: l.at(-1), blocked: l.length >= LOGIN_MAX, retryAfter: this.retryAfter(ip) } : null;
    }).filter(Boolean).sort((a, b) => b.last - a.last);
  },
  clear(ip) { return failures.delete(ip); },
};

// ---------- general API rate limit: requests per minute per session (or IP before login) ----------
const buckets = new Map(); // key -> { start, n }
export function rateLimit({ perMinute, key = (req) => req.session?.token_hash || clientIp(req), name = 'api' }) {
  return (req, res, next) => {
    const k = `${name}:${key(req)}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || now - b.start >= 60_000) { b = { start: now, n: 0 }; buckets.set(k, b); }
    b.n += 1;
    if (b.n > perMinute) {
      res.set('Retry-After', String(Math.ceil((b.start + 60_000 - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Slow down and try again in a minute.' });
    }
    return next();
  };
}

export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start >= 60_000) buckets.delete(k);
  for (const ip of failures.keys()) recent(ip);
  sessions.purgeExpired();
}, 10 * 60_000).unref();
