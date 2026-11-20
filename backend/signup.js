// Public pages' API: self-registration and the facts the landing page shows (name, prices).
// Sign-up makes a normal "user" account with an empty wallet: it cannot run anything until it has balance,
// so an open sign-up costs nothing. Admins can turn it off, or make new accounts wait for approval.
import express from 'express';
import { db, users, audit, settings, USERNAME_RE } from './db.js';
import { clientIp, hashPassword } from './auth.js';
import { passwordProblem, EMAIL_RE } from './users.js';
import { plans } from './billing.js';

export const BRAND = 'Sampanna Cloud';
const RESERVED = new Set(['admin', 'root', 'administrator', 'support', 'system', 'sampanna', 'kapil', 'kapil-cloud', 'sampanna-cloud', 'auto', 'api', 'www']);
const HOUR = 3_600_000;
const PER_IP_PER_HOUR = 5;

export function createSignup({ startSession, addCredit = null }) {
  const router = express.Router();
  const recent = new Map(); // ip -> [timestamps]
  const hits = (ip) => (recent.get(ip) || []).filter((t) => Date.now() - t < HOUR);

  router.get('/api/public/info', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      name: BRAND,
      signup: { enabled: settings.get('signup_enabled') !== false, approval: settings.get('signup_requires_approval') === true, credit: settings.get('signup_credit') || 0 },
      currency: settings.get('billing_currency') || 'NPR',
      plans: plans.list({ activeOnly: true }).map((p) => ({ kind: p.kind, name: p.name, cpu: p.cpu, memoryMb: p.memory_mb, diskGb: p.disk_gb, priceDay: p.price_day, description: p.description })),
      domain: settings.get('auto_app_domain_suffix') || (settings.get('allowed_domain_suffixes') || [])[0] || null,
    });
  });

  router.post('/api/register', async (req, res) => {
    const ip = clientIp(req);
    if (settings.get('signup_enabled') === false) return res.status(403).json({ error: 'Sign-up is closed. Ask the administrator for an account.' });
    const b = req.body ?? {};
    // Bots fill every field; people never see this one
    if (b.website) { audit.log({ ip, action: 'user_register', result: 'failure', detail: 'honeypot' }); return res.status(400).json({ error: 'Sign-up failed' }); }
    if (hits(ip).length >= PER_IP_PER_HOUR) return res.status(429).json({ error: 'Too many sign-ups from your network. Try again in an hour.' });
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 2-32 lowercase letters, digits, _ or -, starting with a letter' });
    if (RESERVED.has(username)) return res.status(400).json({ error: 'That username is reserved' });
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const fullName = typeof b.fullName === 'string' ? b.fullName.trim().slice(0, 100) : '';
    if (!fullName) return res.status(400).json({ error: 'Enter your name' });
    const problem = passwordProblem(b.password);
    if (problem) return res.status(400).json({ error: problem });
    if (b.password.toLowerCase().includes(username)) return res.status(400).json({ error: 'The password must not contain your username' });
    if (users.withHash(username)) return res.status(409).json({ error: 'That username is taken' });
    if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email)) return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });

    recent.set(ip, [...hits(ip), Date.now()]);
    const approval = settings.get('signup_requires_approval') === true;
    const id = users.create({ username, passwordHash: await hashPassword(b.password), role: 'user', fullName, email });
    if (approval) users.update(id, { status: 'suspended' });
    const credit = Number(settings.get('signup_credit') || 0);
    if (credit > 0 && addCredit) addCredit(id, credit);
    audit.log({ username, ip, action: 'user_register', result: 'success', detail: `${email}${approval ? ', waiting for approval' : ''}${credit ? `, welcome credit ${credit}` : ''}` });
    if (approval) return res.status(201).json({ ok: true, pending: true });
    startSession(res, id, { ip, userAgent: req.get('user-agent') });
    users.markLogin(id, ip);
    return res.status(201).json({ ok: true });
  });

  return { router };
}
