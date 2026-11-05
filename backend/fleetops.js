// PM2 and Docker on every node, through each node's agent.
//   GET  /api/fleet/pm2            all nodes, from the latest heartbeats (cheap; at most ~30 s old)
//   GET  /api/fleet/docker         same for containers
//   GET  /api/nodes/:id/pm2        live list from that node
//   POST /api/nodes/:id/pm2/:pmId/:action      start|stop|restart|reload|delete|flush   (super admin; node must allow it)
//   POST /api/nodes/:id/pm2/save
//   GET  /api/nodes/:id/pm2/:pmId/logs
//   GET  /api/nodes/:id/docker, POST /api/nodes/:id/docker/:cid/:action (start|stop|restart), GET .../logs
// Each node's agent refuses management actions unless its own config enables them, so a read-only agent stays read-only
// even if the control plane is compromised.
import express from 'express';
import { audit } from './db.js';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { wrap, bad, int } from './http.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function createFleetOps({ nodes }) {
  const router = express.Router();
  const node = (id) => {
    const n = nodes.get(id);
    if (!n) { const e = new Error('No such server'); e.status = 404; throw e; }
    return n;
  };
  const id = (v) => { if (!ID_RE.test(String(v))) throw bad('Bad id'); return String(v); };
  const log = (req, action, target, detail = null) => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result: 'success', detail });

  // admin guard only for this router's own paths (it is mounted at /api next to user routes)
  router.use(['/fleet', '/nodes'], requireAdmin);

  const fleet = (key, listKey) => (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      nodes: nodes.list().map((n) => {
        const f = nodes.facts(n.id);
        return {
          id: n.id, name: n.name, location: n.location, connected: nodes.isConnected(n.id), at: f?.at || null,
          available: f?.[key]?.available ?? null, error: f?.[key]?.error || null, [listKey]: f?.[key]?.[listKey] || [],
        };
      }),
    });
  };
  router.get('/fleet/pm2', fleet('pm2', 'processes'));
  router.get('/fleet/docker', fleet('docker', 'containers'));

  router.get('/nodes/:id/pm2', wrap(async (req, res) => res.json(await nodes.call(node(req.params.id).id, 'pm2.list'))));
  router.get('/nodes/:id/pm2/:pmId/logs', wrap(async (req, res) => {
    res.json(await nodes.call(node(req.params.id).id, 'pm2.logs', { id: id(req.params.pmId), lines: int(req.query.lines ?? 200, { min: 10, max: 2000, name: 'lines' }) }));
  }));
  router.post('/nodes/:id/pm2/save', requireSuperAdmin, wrap(async (req, res) => {
    const n = node(req.params.id);
    await nodes.call(n.id, 'pm2.save', {}, 60_000);
    log(req, 'pm2_save', n.name);
    res.json({ ok: true });
  }));
  router.post('/nodes/:id/pm2/:pmId/:action(start|stop|restart|reload|delete|flush)', requireSuperAdmin, wrap(async (req, res) => {
    const n = node(req.params.id);
    const { action } = req.params;
    if (action === 'delete' && req.body?.confirm !== req.params.pmId) throw bad(`Type "${req.params.pmId}" exactly to confirm`);
    await nodes.call(n.id, 'pm2.action', { id: id(req.params.pmId), action }, 90_000);
    log(req, `pm2_${action}`, `${n.name}/${req.params.pmId}`);
    res.json({ ok: true });
  }));

  router.get('/nodes/:id/docker', wrap(async (req, res) => res.json(await nodes.call(node(req.params.id).id, 'docker.list'))));
  router.get('/nodes/:id/docker/:cid/logs', wrap(async (req, res) => {
    res.json(await nodes.call(node(req.params.id).id, 'docker.logs', { id: id(req.params.cid), tail: int(req.query.tail ?? 300, { min: 10, max: 5000, name: 'tail' }) }));
  }));
  router.post('/nodes/:id/docker/:cid/:action(start|stop|restart)', requireSuperAdmin, wrap(async (req, res) => {
    const n = node(req.params.id);
    await nodes.call(n.id, 'docker.action', { id: id(req.params.cid), action: req.params.action }, 90_000);
    log(req, `docker_${req.params.action}`, `${n.name}/${req.params.cid}`);
    res.json({ ok: true });
  }));

  return { router };
}
