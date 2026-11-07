// Domains: users request hostnames for their apps/servers, an admin approves, and the panel adds the
// Cloudflare Tunnel route (hostname -> http://<container-ip>:<port>) and DNS record. Container IPs stay internal:
// users only ever see their public URL. SSL is terminated by Cloudflare; the panel checks the edge certificate.
import express from 'express';
import tls from 'node:tls';
import { db, audit, settings } from './db.js';
import { clientIp, isAdmin, ownsContainer, requireAdmin } from './auth.js';
import { cfConfigured, addRoute, removeRoute, tunnelRules, tunnelTarget } from './cloudflare.js';
import { wrap, bad, forbidden, notFound, conflict, int } from './http.js';

const HOST_RE = /^(?=.{4,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const RESERVED = ['panel', 'cloud', 'ssh', 'admin', 'api', 'mail', 'www', 'auth', 'login'];
const SSL_EVERY_MS = 6 * 3600_000;

export function checkCertificate(hostname) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 10_000 }, () => {
      const cert = sock.getPeerCertificate();
      const out = {
        status: sock.authorized ? 'valid' : `invalid: ${sock.authorizationError}`,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        expiresAt: cert?.valid_to ? Date.parse(cert.valid_to) : null,
      };
      sock.end();
      resolve(out);
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ status: 'unreachable: timed out', issuer: null, expiresAt: null }); });
    sock.on('error', (err) => resolve({ status: `unreachable: ${err.code || err.message}`, issuer: null, expiresAt: null }));
  });
}

const domainsDb = {
  get: (id) => db.prepare('SELECT * FROM domains WHERE id = ?').get(id),
  all: () => db.prepare(`SELECT d.*, u.username AS owner, a.name AS app_name FROM domains d LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN apps a ON a.id = d.app_id ORDER BY d.hostname`).all(),
  set: (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE domains SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...fields, updated_at: Date.now(), id });
  },
};

export function createDomains({ containers, monitoring }) {
  const router = express.Router();
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });

  const view = (d, admin) => {
    const out = {
      id: d.id, hostname: d.hostname, url: `https://${d.hostname}`, container: d.container, app: d.app_name || null, appId: d.app_id,
      port: d.port, status: d.status, error: d.error, owner: d.owner, ssl: { status: d.ssl_status, issuer: d.ssl_issuer, expiresAt: d.ssl_expires_at, checkedAt: d.ssl_checked_at },
      createdAt: d.created_at, approvedBy: d.approved_by, routeSynced: !!d.route_synced,
    };
    if (admin) out.target = targetFor(d);
    return out;
  };

  function targetFor(d) {
    const ip = containers.snapshot(d.container)?.ip;
    return ip ? `http://${ip}:${d.port}` : null;
  }

  function mine(req) {
    const d = /^\d+$/.test(req.params.id) ? domainsDb.get(Number(req.params.id)) : null;
    if (!d) throw notFound('No such domain');
    if (!ownsContainer(req.session, d.container)) throw forbidden('You can only manage your own domains');
    return d;
  }

  async function sync(d) {
    const target = targetFor(d);
    if (!target) throw conflict(`${d.container} has no IP address right now (is it running?)`);
    if (!cfConfigured()) {
      domainsDb.set(d.id, { status: 'manual', error: null });
      return { manual: true, target };
    }
    const dnsId = await addRoute(d.hostname.toLowerCase(), target, { managed: !!d.route_synced });
    domainsDb.set(d.id, { status: 'active', route_synced: 1, dns_record_id: dnsId, error: null });
    return { manual: false, target };
  }

  async function checkSsl(d) {
    const r = await checkCertificate(d.hostname);
    domainsDb.set(d.id, { ssl_status: r.status, ssl_issuer: r.issuer, ssl_expires_at: r.expiresAt, ssl_checked_at: Date.now() });
    if (d.status === 'active' && !r.status.startsWith('valid')) {
      monitoring.raise('ssl', `domain:${d.hostname}`, 'warning', `${d.hostname}: certificate ${r.status}`);
    } else if (r.expiresAt && r.expiresAt - Date.now() < 14 * 86400_000) {
      monitoring.raise('ssl', `domain:${d.hostname}`, 'warning', `${d.hostname}: certificate expires ${new Date(r.expiresAt).toISOString().slice(0, 10)}`);
    } else monitoring.clear('ssl', `domain:${d.hostname}`);
    return r;
  }

  // ---------- routes ----------
  router.get('/domains', (req, res) => {
    const admin = isAdmin(req.session);
    const list = domainsDb.all().filter((d) => ownsContainer(req.session, d.container));
    res.set('Cache-Control', 'no-store');
    res.json({
      domains: list.map((d) => view(d, admin)),
      cloudflare: { configured: cfConfigured(), tunnelTarget: cfConfigured() ? tunnelTarget() : null },
      suffixes: settings.get('allowed_domain_suffixes'),
    });
  });

  router.post('/domains', wrap(async (req, res) => {
    const b = req.body ?? {};
    const hostname = typeof b.hostname === 'string' ? b.hostname.trim().toLowerCase().replace(/\.$/, '') : '';
    if (!HOST_RE.test(hostname)) throw bad('Enter a hostname like app.example.com');
    const container = typeof b.container === 'string' ? b.container : '';
    if (!ownsContainer(req.session, container) || !containers.exists(container)) throw forbidden('Pick one of your servers');
    const admin = isAdmin(req.session);
    const suffixes = settings.get('allowed_domain_suffixes') || [];
    const sub = suffixes.find((s) => hostname.endsWith(`.${s}`));
    if (!admin && sub && RESERVED.includes(hostname.slice(0, -(sub.length + 1)).split('.').pop())) throw bad('That name is reserved');
    if (!admin && suffixes.includes(hostname)) throw bad('That is the main domain; pick a subdomain');
    let appId = null;
    let port;
    if (b.appId) {
      const a = db.prepare('SELECT id, port, container FROM apps WHERE id = ?').get(Number(b.appId));
      if (!a || a.container !== container) throw bad('That app is not on this server');
      appId = a.id;
      port = a.port;
    } else {
      port = int(b.port, { min: 1, max: 65535, name: 'Port' });
    }
    if (db.prepare('SELECT 1 FROM domains WHERE hostname = ?').get(hostname)) throw conflict(`${hostname} is already registered`);
    if (cfConfigured()) {
      const rules = await tunnelRules().catch(() => []);
      if (rules?.some((r) => r.hostname?.toLowerCase() === hostname)) throw conflict(`${hostname} is already routed by the tunnel`);
    }
    const now = Date.now();
    const ownerId = admin ? (db.prepare('SELECT user_id FROM user_containers WHERE container = ? LIMIT 1').get(container)?.user_id ?? req.session.id) : req.session.id;
    const id = Number(db.prepare(`INSERT INTO domains (hostname, user_id, container, app_id, port, status, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(hostname, ownerId, container, appId, port, req.session.username, now, now).lastInsertRowid);
    audit.log({ ...who(req), action: 'domain_request', target: hostname, result: 'success', detail: `${container}:${port}` });
    let d = domainsDb.get(id);
    if (admin) {
      try {
        await sync(d);
        domainsDb.set(id, { approved_by: req.session.username });
      } catch (err) {
        domainsDb.set(id, { status: 'error', error: err.message });
      }
      d = domainsDb.get(id);
    }
    res.status(201).json({ domain: view({ ...d, owner: req.session.username }, admin) });
  }));

  router.post('/domains/:id/approve', requireAdmin, wrap(async (req, res) => {
    const d = mine(req);
    if (!['pending', 'error', 'manual', 'rejected'].includes(d.status)) throw conflict(`Domain is ${d.status}`);
    try {
      const r = await sync(d);
      domainsDb.set(d.id, { approved_by: req.session.username });
      audit.log({ ...who(req), action: 'domain_approve', target: d.hostname, result: 'success', detail: r.manual ? `manual route needed -> ${r.target}` : r.target });
    } catch (err) {
      domainsDb.set(d.id, { status: 'error', error: err.message });
      audit.log({ ...who(req), action: 'domain_approve', target: d.hostname, result: 'failure', detail: err.message });
    }
    res.json({ domain: view(domainsDb.all().find((x) => x.id === d.id), true) });
  }));

  router.post('/domains/:id/reject', requireAdmin, wrap(async (req, res) => {
    const d = mine(req);
    if (d.route_synced) throw conflict('This domain is live. Remove it instead.');
    domainsDb.set(d.id, { status: 'rejected', error: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null });
    audit.log({ ...who(req), action: 'domain_reject', target: d.hostname, result: 'success' });
    res.json({ ok: true });
  }));

  // Re-points the route at the container's current IP (after an IP change)
  router.post('/domains/:id/resync', requireAdmin, wrap(async (req, res) => {
    const d = mine(req);
    if (d.status !== 'active' && d.status !== 'manual' && d.status !== 'error') throw conflict(`Domain is ${d.status}`);
    const r = await sync(d);
    audit.log({ ...who(req), action: 'domain_resync', target: d.hostname, result: 'success', detail: r.target });
    res.json({ domain: view(domainsDb.all().find((x) => x.id === d.id), true) });
  }));

  router.post('/domains/:id/check-ssl', wrap(async (req, res) => {
    const d = mine(req);
    res.json({ ssl: await checkSsl(d) });
  }));

  router.delete('/domains/:id', wrap(async (req, res) => {
    const d = mine(req);
    if (req.body?.confirm !== d.hostname) throw bad(`Type "${d.hostname}" to confirm`);
    if (d.route_synced) {
      if (!cfConfigured()) throw conflict('Cloudflare API is not configured, so the live route cannot be removed from here');
      await removeRoute(d.hostname.toLowerCase(), d.dns_record_id);
    }
    db.prepare('DELETE FROM domains WHERE id = ?').run(d.id);
    monitoring.clear('ssl', `domain:${d.hostname}`);
    audit.log({ ...who(req), action: 'domain_remove', target: d.hostname, result: 'success', detail: d.route_synced ? 'tunnel route + DNS removed' : null });
    res.json({ ok: true, manual: d.status === 'manual' });
  }));

  router.get('/domains-tunnel', requireAdmin, wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!cfConfigured()) return res.json({ configured: false, rules: [] });
    const managed = new Set(domainsDb.all().filter((d) => d.route_synced).map((d) => d.hostname.toLowerCase()));
    const rules = (await tunnelRules()).map((r) => ({ ...r, managed: !!r.hostname && managed.has(r.hostname.toLowerCase()) }));
    return res.json({ configured: true, tunnelTarget: tunnelTarget(), rules });
  }));

  // Periodic SSL checks and route drift repair (container IP changed)
  async function sweep() {
    for (const d of domainsDb.all().filter((x) => x.status === 'active' || x.status === 'manual')) {
      if (!d.ssl_checked_at || Date.now() - d.ssl_checked_at > SSL_EVERY_MS) await checkSsl(d).catch(() => {});
    }
    if (!cfConfigured()) return;
    const rules = await tunnelRules().catch(() => null);
    if (!rules) return;
    for (const d of domainsDb.all().filter((x) => x.status === 'active' && x.route_synced)) {
      const want = targetFor(d);
      const have = rules.find((r) => r.hostname?.toLowerCase() === d.hostname.toLowerCase())?.service;
      if (want && have !== want) {
        try {
          await sync(d);
          audit.log({ username: 'system', action: 'domain_resync', target: d.hostname, result: 'success', detail: `${have} -> ${want}` });
        } catch (err) {
          monitoring.raise('domain_route', `domain:${d.hostname}`, 'warning', `${d.hostname}: route could not be updated: ${err.message}`);
        }
      }
    }
  }
  const start = () => { const loop = () => sweep().catch(() => {}).finally(() => setTimeout(loop, 15 * 60_000).unref()); setTimeout(loop, 30_000).unref(); };

  return { router, start };
}
