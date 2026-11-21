// Domains: users request hostnames for their apps/servers, an admin approves, and the panel adds the
// Cloudflare Tunnel route and DNS record. cloudflared runs on the host, so an APP's route is http://localhost:<port>,
// reached through the LXD proxy device port<PORT> the panel keeps on the app's container (portforward.js). A domain for
// a bare server port (no app) still goes to http://<container-ip>:<port>. Container IPs stay internal: users only ever
// see their public URL. SSL is terminated by Cloudflare; the panel checks the edge certificate.
import express from 'express';
import tls from 'node:tls';
import crypto from 'node:crypto';
import dnsp from 'node:dns/promises';

// Resolver for domain checks; DNS_SERVER=ip:port points it elsewhere (tests, or a resolver that is not cached)
const resolver = new dnsp.Resolver({ timeout: 5000, tries: 2 });
if (process.env.DNS_SERVER) resolver.setServers([process.env.DNS_SERVER]);
import { customerServers } from './myservers.js';
import { db, audit, settings } from './db.js';
import { clientIp, isAdmin, ownsContainer, requireAdmin } from './auth.js';
import { cfConfigured, addRoute, removeRoute, tunnelRules, tunnelTarget } from './cloudflare.js';
import { wrap, bad, forbidden, notFound, conflict, int } from './http.js';
import { forwardingEnabled, ensureForward, forwardStatus, localTarget } from './portforward.js';

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

  // Custom domain = not under one of the platform's suffixes: the owner proves control with a TXT record first
  const suffixOf = (hostname) => (settings.get('allowed_domain_suffixes') || []).find((sfx) => hostname === sfx || hostname.endsWith(`.${sfx}`)) || null;
  const isCustom = (hostname) => !suffixOf(hostname);
  const vpsOf = (d) => (/^vps-\d+$/.test(d.container) ? customerServers.get(Number(d.container.slice(4))) : null);
  function instructions(d) {
    const out = [];
    if (d.verify_token && !d.verified_at) out.push({ type: 'TXT', name: `_sampanna-verify.${d.hostname}`, value: `sampanna-verify=${d.verify_token}`, why: 'Proves you control the domain' });
    const vps = vpsOf(d);
    if (vps) {
      out.push({ type: 'A', name: d.hostname, value: vps.host, why: `Points the domain at your VPS ${vps.name}. Serve port ${d.port} there (e.g. Nginx + Let's Encrypt: certbot --nginx -d ${d.hostname})` });
    } else if (isCustom(d.hostname)) {
      out.push({ type: 'CNAME', name: d.hostname, value: cfConfigured() ? tunnelTarget() : '(the administrator gives you the target)', why: 'Sends traffic to Sampanna Cloud. Works when the domain is on Cloudflare; SSL is by Cloudflare' });
    }
    return out;
  }

  const view = (d, admin) => {
    const out = {
      id: d.id, hostname: d.hostname, url: `https://${d.hostname}`, container: d.container, app: d.app_name || null, appId: d.app_id,
      port: d.port, status: d.status, error: d.error, owner: d.owner, ssl: { status: d.ssl_status, issuer: d.ssl_issuer, expiresAt: d.ssl_expires_at, checkedAt: d.ssl_checked_at },
      createdAt: d.created_at, approvedBy: d.approved_by, routeSynced: !!d.route_synced,
      custom: isCustom(d.hostname), verified: !d.verify_token || !!d.verified_at, verifiedAt: d.verified_at || null,
      onVps: !!vpsOf(d), dns: instructions(d),
    };
    if (admin) out.target = targetFor(d);
    return out;
  };

  // The app behind an app domain in an LXD container (null for VPS apps and bare server ports)
  const lxdAppOf = (d) => (d.app_id && !/^vps-\d+$/.test(d.container) ? db.prepare('SELECT id, container, port, forwarded_port FROM apps WHERE id = ?').get(d.app_id) : null);
  function targetFor(d) {
    const app = forwardingEnabled() ? lxdAppOf(d) : null;
    if (app) return localTarget(app.port);
    const ip = containers.snapshot(d.container)?.ip;
    return ip ? `http://${ip}:${d.port}` : null;
  }

  function mine(req) {
    const d = /^\d+$/.test(req.params.id) ? domainsDb.get(Number(req.params.id)) : null;
    if (!d) throw notFound('No such domain');
    if (!ownsContainer(req.session, d.container) && d.user_id !== req.session.id) throw forbidden('You can only manage your own domains');
    return d;
  }

  async function sync(d) {
    const app = forwardingEnabled() ? lxdAppOf(d) : null;
    if (app) {
      // The route relies on the proxy device: make sure it is there before pointing the hostname at localhost
      if (d.port !== app.port) { domainsDb.set(d.id, { port: app.port }); d = { ...d, port: app.port }; }
      await ensureForward(app.container, app.port);
      if (!app.forwarded_port) db.prepare('UPDATE apps SET forwarded_port = ? WHERE id = ?').run(app.port, app.id);
    }
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
    const list = domainsDb.all().filter((d) => ownsContainer(req.session, d.container) || d.user_id === req.session.id);
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
    const admin = isAdmin(req.session);
    // Either for an app (any target, incl. the customer's VPS) or for a port of one of their servers
    const forApp = b.appId ? db.prepare('SELECT id, port, container, user_id, target FROM apps WHERE id = ?').get(Number(b.appId)) : null;
    if (b.appId && (!forApp || (!ownsContainer(req.session, forApp.container) && forApp.user_id !== req.session.id))) throw forbidden('Pick one of your apps');
    const container = forApp ? forApp.container : typeof b.container === 'string' ? b.container : '';
    if (!forApp && (!ownsContainer(req.session, container) || !containers.exists(container))) throw forbidden('Pick one of your servers');
    const suffixes = settings.get('allowed_domain_suffixes') || [];
    const sub = suffixes.find((s) => hostname.endsWith(`.${s}`));
    if (!admin && sub && RESERVED.includes(hostname.slice(0, -(sub.length + 1)).split('.').pop())) throw bad('That name is reserved');
    if (!admin && suffixes.includes(hostname)) throw bad('That is the main domain; pick a subdomain');
    let appId = null;
    let port;
    if (forApp) {
      appId = forApp.id;
      port = forApp.port;
    } else {
      port = int(b.port, { min: 1, max: 65535, name: 'Port' });
    }
    if (db.prepare('SELECT 1 FROM domains WHERE hostname = ?').get(hostname)) throw conflict(`${hostname} is already registered`);
    if (cfConfigured()) {
      const rules = await tunnelRules().catch(() => []);
      if (rules?.some((r) => r.hostname?.toLowerCase() === hostname)) throw conflict(`${hostname} is already routed by the tunnel`);
    }
    const now = Date.now();
    const ownerId = forApp ? forApp.user_id : admin ? (db.prepare('SELECT user_id FROM user_containers WHERE container = ? LIMIT 1').get(container)?.user_id ?? req.session.id) : req.session.id;
    // Customers prove control of a custom domain first; platform subdomains and admins skip it
    const token = !admin && isCustom(hostname) ? crypto.randomBytes(12).toString('hex') : null;
    const onVps = /^vps-\d+$/.test(container);
    const id = Number(db.prepare(`INSERT INTO domains (hostname, user_id, container, app_id, port, status, requested_by, created_at, updated_at, verify_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hostname, ownerId, container, appId, port, token ? 'unverified' : onVps ? 'dns' : 'pending', req.session.username, now, now, token).lastInsertRowid);
    audit.log({ ...who(req), action: 'domain_request', target: hostname, result: 'success', detail: `${container}:${port}` });
    let d = domainsDb.get(id);
    if (admin && !onVps) {
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
    if (/^vps-\d+$/.test(d.container)) throw conflict('This domain points at the customer\'s own VPS; there is nothing to route here');
    if (d.verify_token && !d.verified_at) throw conflict('The owner has not verified this domain yet (TXT record)');
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

  // Check the DNS records the owner was asked to add. TXT for ownership; for a VPS app also the A record.
  router.post('/domains/:id/verify', wrap(async (req, res) => {
    const d = mine(req);
    const txt = d.verify_token ? (await resolver.resolveTxt(`_sampanna-verify.${d.hostname}`).catch(() => [])).map((r) => r.join('')) : [];
    const ok = !d.verify_token || d.verified_at || txt.includes(`sampanna-verify=${d.verify_token}`);
    const fields = {};
    if (ok && d.verify_token && !d.verified_at) fields.verified_at = Date.now();
    const vps = vpsOf(d);
    let pointsHere = null;
    if (vps) {
      const want = vps.host;
      const got = await resolver.resolve4(d.hostname).catch(() => []);
      pointsHere = got.includes(want) || (!/^[\d.]+$/.test(want) && (await resolver.resolve4(want).catch(() => [])).some((ip) => got.includes(ip)));
    }
    if (ok) fields.status = vps ? (pointsHere ? 'active' : 'dns') : d.status === 'unverified' ? 'pending' : d.status;
    if (Object.keys(fields).length) domainsDb.set(d.id, fields);
    audit.log({ ...who(req), action: 'domain_verify', target: d.hostname, result: ok ? 'success' : 'failure', detail: ok ? (vps ? `A record ${pointsHere ? 'ok' : 'not yet pointing at the VPS'}` : 'TXT ok') : `TXT not found (${txt.length} TXT record(s))` });
    const fresh = domainsDb.all().find((x) => x.id === d.id);
    res.json({ verified: !!ok, pointsHere, domain: view(fresh, isAdmin(req.session)),
      message: ok ? (vps ? (pointsHere ? 'Verified and pointing at your VPS.' : 'Verified. Now add the A record (DNS changes can take a few minutes).') : 'Verified. An administrator connects it next.') : 'The TXT record was not found yet. DNS changes can take a few minutes.' });
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
        // Never move a live route to localhost while the proxy device is missing: that is exactly the 502 case
        const app = forwardingEnabled() ? lxdAppOf(d) : null;
        if (app) {
          const st = await forwardStatus(app.container, app.port).catch(() => null);
          if (st?.status !== 'ok' && st?.status !== 'other') {
            monitoring.raise('domain_route', `domain:${d.hostname}`, 'warning', `${d.hostname}: port ${app.port} is not forwarded from ${app.container}. Use "Fix port forwarding" on the app.`);
            continue;
          }
        }
        try {
          await sync(d);
          audit.log({ username: 'system', action: 'domain_resync', target: d.hostname, result: 'success', detail: `${have} -> ${want}` });
        } catch (err) {
          monitoring.raise('domain_route', `domain:${d.hostname}`, 'warning', `${d.hostname}: route could not be updated: ${err.message}`);
        }
      }
    }
  }
  // Automatic subdomain after an app's first good deploy: <app>-<user>.<suffix> (one label, so Cloudflare's free
  // *.suffix certificate covers it). Only names the panel builds itself are auto-approved; nothing a user typed.
  async function autoForApp(appId) {
    if (settings.get('auto_app_domains') === false) return null;
    const a = db.prepare('SELECT a.*, u.username FROM apps a JOIN users u ON u.id = a.user_id WHERE a.id = ?').get(appId);
    if (!a || a.target === 'vps') return null; // apps on a customer's VPS are reached at their own address
    if (db.prepare("SELECT 1 FROM domains WHERE app_id = ? AND status NOT IN ('removed', 'rejected')").get(a.id)) return null;
    const suffix = (settings.get('auto_app_domain_suffix') || (settings.get('allowed_domain_suffixes') || [])[0] || '').toLowerCase();
    if (!suffix || !HOST_RE.test(`x.${suffix}`)) return null;
    const base = `${a.name}-${a.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 55).replace(/^-|-$/g, '');
    const rules = cfConfigured() ? await tunnelRules().catch(() => []) : [];
    const taken = (h) => db.prepare('SELECT 1 FROM domains WHERE hostname = ?').get(h) || rules?.some((r) => r.hostname?.toLowerCase() === h);
    let hostname = null;
    for (let i = 1; i < 50 && !hostname; i += 1) {
      const h = `${i === 1 ? base : `${base}-${i}`}.${suffix}`;
      if (!RESERVED.includes(h.split('.')[0]) && HOST_RE.test(h) && !taken(h)) hostname = h;
    }
    if (!hostname) return null;
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO domains (hostname, user_id, container, app_id, port, status, requested_by, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'auto', 'auto', ?, ?)`).run(hostname, a.user_id, a.container, a.id, a.port, now, now).lastInsertRowid);
    let result = 'success';
    let detail = `${a.container}:${a.port}`;
    try {
      const r = await sync(domainsDb.get(id));
      if (r.manual) detail += `; Cloudflare API not configured, add the route by hand -> ${r.target}`;
    } catch (err) {
      domainsDb.set(id, { status: 'error', error: err.message });
      result = 'failure';
      detail = err.message;
    }
    audit.log({ username: 'system', action: 'domain_auto', target: hostname, result, detail: `${a.username}/${a.name}: ${detail}` });
    return domainsDb.get(id);
  }

  // After a deploy (or "Fix port forwarding"): give the app its automatic subdomain, or re-point the ones it has, and
  // say in the deploy log which hostname goes where. A domain problem never fails the deploy itself.
  async function publishApp(appId, say = () => {}) {
    const a = db.prepare('SELECT id, target FROM apps WHERE id = ?').get(appId);
    if (!a || a.target === 'vps') return null;
    const report = (d) => {
      const target = targetFor(d);
      say(`==> Public hostname: https://${d.hostname} -> ${target || '(no target)'}`);
      if (d.status === 'active') say(`DNS: CNAME ${d.hostname} -> ${tunnelTarget()} (proxied by Cloudflare)`);
      else if (d.status === 'manual') say(`Cloudflare API is not configured on this panel: add the public hostname ${d.hostname} -> ${target} in the tunnel and a proxied CNAME to the tunnel by hand.`);
      else if (d.status === 'error') say(`Route not set: ${d.error}`);
      else say(`Status: ${d.status}${d.status === 'pending' ? ' (waiting for an administrator to approve it)' : ''}`);
    };
    const have = db.prepare("SELECT * FROM domains WHERE app_id = ? AND status NOT IN ('removed', 'rejected')").all(a.id);
    if (!have.length) {
      const d = await autoForApp(a.id);
      if (d) report(d);
      else say('==> Public hostname: none (automatic subdomains are off or no domain suffix is set). Add a domain on the Domains page.');
      return d;
    }
    for (const d of have) {
      if (['active', 'manual', 'error'].includes(d.status) && (!d.verify_token || d.verified_at)) {
        try { await sync(d); } catch (err) { domainsDb.set(d.id, { status: 'error', error: err.message }); }
      }
      report(domainsDb.get(d.id));
    }
    return have[0];
  }

  const start = () => { const loop = () => sweep().catch(() => {}).finally(() => setTimeout(loop, 15 * 60_000).unref()); setTimeout(loop, 30_000).unref(); };

  return { router, start, autoForApp, publishApp };
}
