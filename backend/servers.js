// Cloud servers (LXD containers). Users reach only containers assigned to them; every lifecycle change
// that can lose data is admin-only, needs a typed confirmation, and refuses protected containers.
import express from 'express';
import net from 'node:net';
import {
  IMAGES, createInstance, deleteInstance, copyInstance, renameInstance, rebuildInstance, updateInstance,
  listSnapshots, createSnapshot, deleteSnapshot, restoreSnapshot, validSnapshotName, instanceLog, consoleLog,
  getNetwork, networkLeases, hasExtension, getProfile, toMiB, toGiB, changeState,
} from './lxd.js';
import { users, audit, containerMeta, settings, db, NEW_CONTAINER_RE, CONTAINER_RE } from './db.js';
import { clientIp, isAdmin, ownsContainer, requireAdmin, requireSuperAdmin } from './auth.js';
import { wrap, bad, forbidden, notFound, conflict, int, str, MiB, GiB, HttpError } from './http.js';

const USER_ACTIONS = new Set(['start', 'stop', 'restart']);
const ADMIN_ACTIONS = new Set(['start', 'stop', 'restart', 'freeze', 'unfreeze']);
const DEFAULT_USER_SNAPSHOTS = 5;

// ---------- IPv4 helpers ----------
const ip2n = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
function inSubnet(ip, cidr) {
  const [base, bits] = String(cidr).split('/');
  if (!net.isIPv4(base) || !/^\d+$/.test(bits || '')) return false;
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ip2n(base) / size) * size;
  const n = ip2n(ip);
  return n > start && n < start + size - 1; // not the network or broadcast address
}

export function createServers({ io, containers, allocator }) {
  const router = express.Router();
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });

  // Resolves the container a request may touch. Users: only their own (403 for anything else, existing or not).
  function allowed(req, name = req.params.name) {
    if (!ownsContainer(req.session, name)) throw forbidden('You can only access your own servers');
    if (!CONTAINER_RE.test(name) || !containers.exists(name)) {
      throw notFound(containers.error() ? `LXD is not reachable: ${containers.error()}` : 'No such server');
    }
    return name;
  }
  const notBusy = (name) => { if (containers.busy(name)) throw conflict('Another task is still running on this server'); };
  const meta = (name) => containerMeta.get(name) || {};
  function confirmName(body, expected) {
    if (body?.confirm !== expected) throw bad(`Type "${expected}" exactly to confirm`);
  }

  // Starts a tracked job and writes requested + result to the audit log
  function job(req, name, action, work, detail = null, opts = {}) {
    const { username, ip } = who(req);
    audit.log({ username, ip, action: `server_${action}`, target: name, result: 'requested', detail });
    return containers.run(name, action, username, (done) => {
      audit.log({ username, ip, action: `server_${action}`, target: name, result: done.status, detail: done.message || detail });
    }, work, opts);
  }

  // ---------- read ----------
  router.get('/containers', (req, res) => {
    const s = req.session;
    const names = containers.names().filter((n) => ownsContainer(s, n));
    res.set('Cache-Control', 'no-store');
    res.json({ containers: names.map(containers.view), error: containers.error() });
  });

  router.get('/containers/:name', wrap(async (req, res) => {
    const name = allowed(req);
    const view = containers.view(name);
    const facts = containers.facts(name);
    let snapshots = [];
    try { snapshots = (await listSnapshots(name)).map((s) => ({ name: s.name, createdAt: Date.parse(s.created_at), stateful: s.stateful })); } catch { /* shown as empty */ }
    const m = meta(name);
    const out = { ...view, facts, snapshots, meta: { protected: !!m.protected, origin: m.origin || 'existing', notes: m.notes || '', createdBy: m.created_by || null } };
    if (!isAdmin(req.session)) {
      // Users see their own server's facts but not host-side details
      delete out.facts.rawLxc;
      delete out.facts.profiles;
      delete out.facts.pool;
    }
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  // ---------- power ----------
  router.post('/containers/:name/action', wrap(async (req, res) => {
    const name = allowed(req);
    const action = req.body?.action;
    const set = isAdmin(req.session) ? ADMIN_ACTIONS : USER_ACTIONS;
    if (!set.has(action)) throw bad(`action must be one of: ${[...set].join(', ')}`);
    notBusy(name);
    res.status(202).json(job(req, name, action, null));
  }));

  // ---------- snapshots (owners too) ----------
  router.get('/containers/:name/snapshots', wrap(async (req, res) => {
    const name = allowed(req);
    const list = await listSnapshots(name);
    res.set('Cache-Control', 'no-store');
    res.json({ snapshots: list.map((s) => ({ name: s.name, createdAt: Date.parse(s.created_at), size: s.size ?? null })) });
  }));

  router.post('/containers/:name/snapshots', wrap(async (req, res) => {
    const name = allowed(req);
    notBusy(name);
    const snap = req.body?.name ? str(req.body.name, { max: 63, name: 'Snapshot name' }) : `snap-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    if (!validSnapshotName(snap)) throw bad('Snapshot names: letters, digits, dot, dash, underscore (starting with a letter or digit)');
    if (!isAdmin(req.session)) {
      const u = users.byId(req.session.id);
      const max = u.max_snapshots ?? DEFAULT_USER_SNAPSHOTS;
      const count = (await listSnapshots(name)).length;
      if (count >= max) throw forbidden(`You can keep at most ${max} snapshots per server. Delete an old one first.`);
    }
    res.status(202).json(job(req, name, 'snapshot', async (p) => { p(`Creating snapshot ${snap}`); await createSnapshot(name, snap); return `Snapshot ${snap} created`; }, snap));
  }));

  router.delete('/containers/:name/snapshots/:snap', wrap(async (req, res) => {
    const name = allowed(req);
    const { snap } = req.params;
    if (!validSnapshotName(snap)) throw bad('Invalid snapshot name');
    notBusy(name);
    res.status(202).json(job(req, name, 'snapshot-delete', async () => { await deleteSnapshot(name, snap); return `Snapshot ${snap} deleted`; }, snap));
  }));

  // Rolls back to a snapshot. A safety snapshot of the current state is taken first, so the rollback can be undone.
  router.post('/containers/:name/snapshots/:snap/restore', wrap(async (req, res) => {
    const name = allowed(req);
    const { snap } = req.params;
    if (!validSnapshotName(snap)) throw bad('Invalid snapshot name');
    confirmName(req.body, snap);
    notBusy(name);
    const existing = await listSnapshots(name);
    if (!existing.some((s) => s.name === snap)) throw notFound('No such snapshot');
    const wasRunning = containers.snapshot(name)?.status === 'Running';
    const safety = `before-restore-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    res.status(202).json(job(req, name, 'restore-snapshot', async (p) => {
      p(`Saving the current state as ${safety}`);
      await createSnapshot(name, safety);
      const after = await listSnapshots(name);
      if (!after.some((s) => s.name === safety)) throw new Error('Safety snapshot was not created; not restoring');
      if (wasRunning) { p('Stopping'); await changeState(name, 'stop'); }
      p(`Restoring ${snap}`);
      await restoreSnapshot(name, snap);
      if (wasRunning) { p('Starting'); await changeState(name, 'start'); }
      return `Restored ${snap}. The previous state was kept as snapshot ${safety}.`;
    }, `${snap} (safety snapshot ${safety})`));
  }));

  // ---------- logs ----------
  router.get('/containers/:name/logs', wrap(async (req, res) => {
    const name = allowed(req);
    const out = { console: (await consoleLog(name).catch(() => '')).slice(-200_000) };
    if (isAdmin(req.session)) out.lxc = (await instanceLog(name, 'lxc.log').catch(() => '')).slice(-200_000);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  // ================= admin only below =================
  router.get('/images', (_req, res) => res.json({ images: Object.entries(IMAGES).map(([id, i]) => ({ id, label: i.label })) }));

  router.get('/allocation', requireAdmin, wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await allocator.summary());
  }));

  function parseSpec(body, { needAll = true } = {}) {
    const o = {};
    o.cpu = int(body.cpu, { min: 1, max: 256, name: 'CPU cores', optional: !needAll });
    const memMiB = int(body.memoryMiB, { min: 128, max: 1024 * 1024, name: 'Memory (MiB)', optional: !needAll });
    o.memory = memMiB == null ? null : memMiB * MiB;
    const diskGiB = int(body.diskGiB, { min: 1, max: 100_000, name: 'Disk (GiB)', optional: !needAll });
    o.disk = diskGiB == null ? null : diskGiB * GiB;
    o.ingress = int(body.ingressMbit, { min: 1, max: 100_000, name: 'Download limit (Mbit/s)', optional: true });
    o.egress = int(body.egressMbit, { min: 1, max: 100_000, name: 'Upload limit (Mbit/s)', optional: true });
    return o;
  }

  router.post('/allocation/check', requireAdmin, wrap(async (req, res) => {
    const spec = parseSpec(req.body ?? {});
    const ownerId = req.body?.ownerId ? int(req.body.ownerId, { min: 1, max: 1e9, name: 'Owner' }) : null;
    const exclude = typeof req.body?.exclude === 'string' && containers.exists(req.body.exclude) ? req.body.exclude : null;
    const r = await allocator.check({ ...spec, pool: req.body?.pool, exclude, forUser: ownerId });
    res.json({ ok: r.ok, errors: r.errors, warnings: r.warnings, pool: r.pool });
  }));

  // Network devices: the profile's NIC plus the bridge's subnet (for fixed IPs)
  async function nicInfo(name) {
    const facts = name ? containers.facts(name) : null;
    let nicName = facts?.nic?.name;
    let network = facts?.nic?.network;
    if (!network) {
      const prof = await getProfile('default');
      const nic = Object.entries(prof.devices || {}).find(([, d]) => d.type === 'nic');
      nicName = nic?.[0];
      network = nic?.[1]?.network || nic?.[1]?.parent;
    }
    if (!network) return { nicName, network: null, subnet: null, managed: false };
    try {
      const n = await getNetwork(network);
      return { nicName, network, subnet: n.config?.['ipv4.address'] || null, managed: !!n.managed };
    } catch {
      return { nicName, network, subnet: null, managed: false };
    }
  }

  async function usedIps(network) {
    const used = new Set();
    for (const s of containers.all()) if (s?.ip) used.add(s.ip);
    for (const n of containers.names()) { const f = containers.facts(n); if (f?.nic?.fixedIp) used.add(f.nic.fixedIp); }
    try { for (const l of await networkLeases(network)) if (l.address && net.isIPv4(l.address)) used.add(l.address); } catch { /* unmanaged */ }
    return used;
  }

  async function checkIp(ip, exceptName = null) {
    if (!net.isIPv4(ip)) throw bad('Enter an IPv4 address like 10.10.10.30');
    const info = await nicInfo(exceptName);
    if (!info.managed || !info.subnet) throw bad('Fixed IPs need a LXD-managed bridge network with an IPv4 subnet');
    if (!inSubnet(ip, info.subnet)) throw bad(`${ip} is not inside ${info.subnet}`);
    if (ip === info.subnet.split('/')[0]) throw bad(`${ip} is the bridge's own address`);
    const mine = exceptName ? [containers.snapshot(exceptName)?.ip, containers.facts(exceptName)?.nic?.fixedIp] : [];
    if ((await usedIps(info.network)).has(ip) && !mine.includes(ip)) throw conflict(`${ip} is already in use`);
    return info;
  }

  router.get('/networks', requireAdmin, wrap(async (_req, res) => {
    const info = await nicInfo(null).catch(() => ({}));
    const used = info.network ? [...(await usedIps(info.network))].sort((a, b) => ip2n(a) - ip2n(b)) : [];
    res.set('Cache-Control', 'no-store');
    res.json({ ...info, used, assignments: containers.names().map((n) => ({ name: n, ip: containers.snapshot(n)?.ip || null, fixedIp: containers.facts(n)?.nic?.fixedIp || null })) });
  }));

  // Sets the LXD config/devices for a spec (used by create, clone and resize)
  async function nicDevice(name, info) {
    const inst = containers.facts(name);
    if (inst?.nic) return inst.nic.name;
    return info.nicName || 'eth0';
  }

  // ---------- create ----------
  router.post('/containers', requireAdmin, wrap(async (req, res) => {
    const b = req.body ?? {};
    const name = str(b.name, { max: 63, name: 'Name' }).toLowerCase();
    if (!NEW_CONTAINER_RE.test(name)) throw bad('Name: 2-63 lowercase letters, digits or dashes, starting with a letter, not ending with a dash');
    if (containers.exists(name) || containerMeta.get(name)) throw conflict(`A server named ${name} already exists`);
    if (!IMAGES[b.image]) throw bad('Pick an image');
    const spec = parseSpec(b);
    const ownerId = b.ownerId ? int(b.ownerId, { min: 1, max: 1e9, name: 'Owner' }) : null;
    const owner = ownerId ? users.byId(ownerId) : null;
    if (ownerId && !owner) throw bad('That owner does not exist');
    if (owner && owner.role !== 'user') throw bad('Servers are assigned to users; admins already see every server');
    // The owner's default network limit applies unless the admin set one for this server
    if (owner?.net_limit_mbit && !spec.ingress) spec.ingress = owner.net_limit_mbit;
    if (owner?.net_limit_mbit && !spec.egress) spec.egress = owner.net_limit_mbit;
    const fixedIp = b.ip ? String(b.ip).trim() : null;
    const info = fixedIp ? await checkIp(fixedIp) : await nicInfo(null).catch(() => ({}));
    const check = await allocator.check({ ...spec, pool: b.pool, forUser: ownerId });
    if (!check.ok) return res.status(409).json({ error: check.errors.join(' '), errors: check.errors, warnings: check.warnings });
    if (check.warnings.length && b.acceptWarnings !== true) {
      return res.status(409).json({ error: 'Review the warnings and confirm', needsConfirm: true, warnings: check.warnings });
    }
    const config = {
      'limits.cpu': String(spec.cpu),
      'limits.memory': toMiB(spec.memory),
      'security.privileged': 'false',
      'security.nesting': 'false',
      'boot.autostart': 'true',
      'user.kapilcloud.owner': owner?.username || '',
    };
    const devices = { root: { type: 'disk', path: '/', pool: check.pool, size: toGiB(spec.disk) } };
    if (info.nicName && (fixedIp || spec.ingress || spec.egress)) {
      const nic = { type: 'nic', name: info.nicName, network: info.network };
      if (fixedIp) nic['ipv4.address'] = fixedIp;
      if (spec.ingress) nic['limits.ingress'] = `${spec.ingress}Mbit`;
      if (spec.egress) nic['limits.egress'] = `${spec.egress}Mbit`;
      devices[info.nicName] = nic;
    }
    containerMeta.createdByPanel(name, { image: b.image, by: req.session.username });
    if (owner) users.assign(owner.id, name);
    const detail = `${IMAGES[b.image].label}, ${spec.cpu} CPU, ${toMiB(spec.memory)}, ${toGiB(spec.disk)}${owner ? `, owner ${owner.username}` : ''}${fixedIp ? `, IP ${fixedIp}` : ''}`;
    allocator.invalidate();
    const j = job(req, name, 'create', async (p) => {
      p('Downloading image and creating (first time for an image can take a few minutes)');
      try {
        await createInstance({ name, image: b.image, config, devices, description: `Kapil Cloud server${owner ? ` for ${owner.username}` : ''}` },
          (m) => { const d = m.download_progress || m.create_instance_from_image_unpack_progress; if (d) p(d); });
      } catch (err) {
        if (owner) db.prepare('DELETE FROM user_containers WHERE user_id = ? AND container = ?').run(owner.id, name);
        containerMeta.remove(name);
        throw err;
      }
      if (b.start !== false) { p('Starting'); await changeState(name, 'start'); }
      return `Created ${name}`;
    }, detail);
    return res.status(202).json(j);
  }));

  // ---------- delete (super admin) ----------
  router.delete('/containers/:name', requireSuperAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    confirmName(req.body, name);
    notBusy(name);
    if (meta(name).protected) throw forbidden(`${name} is protected. Remove the protection first (Settings tab of the server).`);
    if (containers.facts(name)?.deleteProtection) throw forbidden(`${name} has LXD delete protection (security.protection.delete).`);
    const doms = db.prepare("SELECT hostname FROM domains WHERE container = ? AND status != 'removed'").all(name);
    if (doms.length) throw conflict(`Remove its domains first: ${doms.map((d) => d.hostname).join(', ')}`);
    const wasRunning = containers.snapshot(name)?.status === 'Running';
    if (wasRunning && req.body?.stopFirst !== true) throw conflict('The server is running. Stop it first, or tick "stop it first".');
    allocator.invalidate();
    res.status(202).json(job(req, name, 'delete', async (p) => {
      if (wasRunning) { p('Stopping'); await changeState(name, 'stop', () => {}, { force: true }); }
      p('Deleting');
      await deleteInstance(name);
      db.transaction(() => {
        users.unassignContainer(name);
        db.prepare('DELETE FROM apps WHERE container = ?').run(name);
        containerMeta.remove(name);
      })();
      return `Deleted ${name}`;
    }));
  }));

  // ---------- rebuild (super admin): fresh OS, same name/limits ----------
  router.post('/containers/:name/rebuild', requireSuperAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    confirmName(req.body, name);
    notBusy(name);
    if (!IMAGES[req.body?.image]) throw bad('Pick an image');
    if (meta(name).protected) throw forbidden(`${name} is protected. Remove the protection first.`);
    if (!(await hasExtension('instance_rebuild'))) throw new HttpError(501, 'This LXD version cannot rebuild instances (needs LXD 5.19 or newer). Delete and create instead.');
    const wasRunning = containers.snapshot(name)?.status === 'Running';
    const safety = `before-rebuild-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    res.status(202).json(job(req, name, 'rebuild', async (p) => {
      p(`Saving the current state as snapshot ${safety}`);
      await createSnapshot(name, safety);
      if (wasRunning) { p('Stopping'); await changeState(name, 'stop', () => {}, { force: true }); }
      p('Rebuilding from a fresh image');
      await rebuildInstance(name, req.body.image, (m) => { if (m.download_progress) p(m.download_progress); });
      containerMeta.createdByPanel(name, { image: req.body.image, by: req.session.username });
      if (wasRunning) { p('Starting'); await changeState(name, 'start'); }
      return `Rebuilt ${name} with ${IMAGES[req.body.image].label}`;
    }, IMAGES[req.body.image].label));
  }));

  // ---------- clone ----------
  router.post('/containers/:name/clone', requireAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    const newName = str(req.body?.newName, { max: 63, name: 'New name' }).toLowerCase();
    if (!NEW_CONTAINER_RE.test(newName)) throw bad('New name: 2-63 lowercase letters, digits or dashes, starting with a letter');
    if (containers.exists(newName) || containerMeta.get(newName)) throw conflict(`A server named ${newName} already exists`);
    notBusy(name);
    const f = containers.facts(name);
    const ownerId = req.body?.ownerId ? int(req.body.ownerId, { min: 1, max: 1e9, name: 'Owner' }) : null;
    const owner = ownerId ? users.byId(ownerId) : null;
    if (ownerId && (!owner || owner.role !== 'user')) throw bad('Owner must be an existing user');
    if (f.limits.cpu == null || f.limits.memory == null) throw bad(`${name} has no CPU/memory limit. Set limits on it before cloning.`);
    const check = await allocator.check({ cpu: f.limits.cpu, memory: f.limits.memory, disk: f.limits.disk ?? 0, pool: f.pool, forUser: ownerId });
    if (!check.ok) return res.status(409).json({ error: check.errors.join(' '), errors: check.errors, warnings: check.warnings });
    containerMeta.createdByPanel(newName, { image: `clone of ${name}`, by: req.session.username });
    if (owner) users.assign(owner.id, newName);
    allocator.invalidate();
    return res.status(202).json(job(req, newName, 'clone', async (p) => {
      p(`Copying ${name}`);
      try {
        await copyInstance(name, newName, {}, (m) => { if (m.fs_progress) p(m.fs_progress); });
      } catch (err) {
        containerMeta.remove(newName);
        if (owner) db.prepare('DELETE FROM user_containers WHERE user_id = ? AND container = ?').run(owner.id, newName);
        throw err;
      }
      // A fixed IP would clash with the original: drop it from the copy, and never autostart the copy
      await updateInstance(newName, (next) => {
        for (const d of Object.values(next.devices)) if (d.type === 'nic') delete d['ipv4.address'];
        next.config['boot.autostart'] = 'false';
        next.config['user.kapilcloud.owner'] = owner?.username || '';
      });
      return `Cloned ${name} to ${newName} (stopped, fixed IP removed)`;
    }, `from ${name}`));
  }));

  // ---------- resources ----------
  router.put('/containers/:name/resources', requireAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    notBusy(name);
    const spec = parseSpec(req.body ?? {});
    const f = containers.facts(name);
    const snap = containers.snapshot(name);
    if (f.limits.disk && spec.disk < f.limits.disk) throw bad('Shrinking a disk is not supported (it can destroy data). Pick the same or a larger size.');
    if (snap?.diskUsed && spec.disk < snap.diskUsed) throw bad('The disk size is smaller than what the server already uses.');
    const ownerIds = users.ownersOf(name).map((u) => u.id);
    const check = await allocator.check({ ...spec, pool: f.pool, exclude: name, forUser: ownerIds[0] || null });
    if (!check.ok) return res.status(409).json({ error: check.errors.join(' '), errors: check.errors, warnings: check.warnings });
    if (check.warnings.length && req.body?.acceptWarnings !== true) {
      return res.status(409).json({ error: 'Review the warnings and confirm', needsConfirm: true, warnings: check.warnings });
    }
    const info = await nicInfo(name).catch(() => ({}));
    const nicName = await nicDevice(name, info);
    const detail = `${spec.cpu} CPU, ${toMiB(spec.memory)}, ${toGiB(spec.disk)}, net ${spec.ingress || '∞'}/${spec.egress || '∞'} Mbit`;
    allocator.invalidate();
    return res.status(202).json(job(req, name, 'resources', async () => {
      await updateInstance(name, (next, cur) => {
        next.config['limits.cpu'] = String(spec.cpu);
        next.config['limits.memory'] = toMiB(spec.memory);
        const expanded = cur.expanded_devices || {};
        const rootKey = Object.keys(next.devices).find((k) => next.devices[k].type === 'disk' && next.devices[k].path === '/')
          || Object.keys(expanded).find((k) => expanded[k].type === 'disk' && expanded[k].path === '/') || 'root';
        next.devices[rootKey] = { ...(expanded[rootKey] || { type: 'disk', path: '/', pool: f.pool }), ...(next.devices[rootKey] || {}), size: toGiB(spec.disk) };
        if (nicName && (expanded[nicName] || next.devices[nicName])) {
          const nic = { ...(expanded[nicName] || {}), ...(next.devices[nicName] || {}) };
          if (spec.ingress) nic['limits.ingress'] = `${spec.ingress}Mbit`; else delete nic['limits.ingress'];
          if (spec.egress) nic['limits.egress'] = `${spec.egress}Mbit`; else delete nic['limits.egress'];
          next.devices[nicName] = nic;
        }
      });
      return 'Resources updated';
    }, detail));
  }));

  // ---------- fixed IP ----------
  router.put('/containers/:name/ip', requireAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    notBusy(name);
    const ip = req.body?.ip ? String(req.body.ip).trim() : null;
    const info = ip ? await checkIp(ip, name) : await nicInfo(name);
    if (!info.nicName) throw bad('This server has no network device');
    return res.status(202).json(job(req, name, 'set-ip', async () => {
      await updateInstance(name, (next, cur) => {
        const nic = { ...(cur.expanded_devices?.[info.nicName] || {}), ...(next.devices[info.nicName] || {}) };
        if (ip) nic['ipv4.address'] = ip; else delete nic['ipv4.address'];
        next.devices[info.nicName] = nic;
      });
      return ip ? `IP set to ${ip}. It takes effect after the next restart.` : 'Fixed IP removed (DHCP after the next restart)';
    }, ip || 'dhcp'));
  }));

  // ---------- rename (changes the hostname) ----------
  router.post('/containers/:name/rename', requireSuperAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    confirmName(req.body, name);
    notBusy(name);
    const newName = str(req.body?.newName, { max: 63, name: 'New name' }).toLowerCase();
    if (!NEW_CONTAINER_RE.test(newName)) throw bad('New name: 2-63 lowercase letters, digits or dashes, starting with a letter');
    if (containers.exists(newName)) throw conflict(`${newName} already exists`);
    if (containers.snapshot(name)?.status !== 'Stopped') throw conflict('Stop the server before renaming it');
    return res.status(202).json(job(req, name, 'rename', async () => {
      await renameInstance(name, newName);
      db.transaction(() => {
        db.prepare('DELETE FROM container_meta WHERE name = ?').run(newName);
        containerMeta.rename(name, newName);
        users.renameContainer(name, newName);
        db.prepare('UPDATE apps SET container = ? WHERE container = ?').run(newName, name);
        db.prepare('UPDATE domains SET container = ? WHERE container = ?').run(newName, name);
      })();
      return `Renamed to ${newName}. Older backups stay under the old name.`;
    }, `to ${newName}`));
  }));

  // ---------- protection, owners, notes ----------
  router.put('/containers/:name/protection', requireSuperAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    const on = req.body?.protected === true;
    if (!on) confirmName(req.body, name);
    containerMeta.setProtected(name, on);
    audit.log({ ...who(req), action: on ? 'server_protect' : 'server_unprotect', target: name, result: 'success' });
    await containers.poll();
    res.json({ ok: true, protected: on });
  }));

  router.put('/containers/:name/owners', requireAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds : null;
    if (!ids || ids.length > 20) throw bad('userIds must be a list');
    const list = ids.map((id) => users.byId(Number(id)));
    if (list.some((u) => !u || u.role !== 'user')) throw bad('Owners must be existing users');
    const before = users.ownersOf(name).map((u) => u.username);
    db.transaction(() => {
      db.prepare('DELETE FROM user_containers WHERE container = ?').run(name);
      for (const u of list) users.assign(u.id, name);
    })();
    const after = list.map((u) => u.username);
    audit.log({ ...who(req), action: 'server_owners', target: name, result: 'success', detail: `${before.join(', ') || 'none'} -> ${after.join(', ') || 'none'}` });
    // Owners' live sockets pick up the change on their next connect; kick removed owners off the room now
    for (const u of before.filter((x) => !after.includes(x))) {
      const id = users.byName(u)?.id;
      if (id) io.in(`user:${id}`).socketsLeave(`ct:${name}`);
    }
    for (const u of list) io.in(`user:${u.id}`).socketsJoin(`ct:${name}`);
    res.json({ ok: true, owners: after });
  }));

  router.put('/containers/:name/notes', requireAdmin, wrap(async (req, res) => {
    const name = allowed(req);
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : '';
    if (!containerMeta.get(name)) containerMeta.adoptExisting(name);
    containerMeta.setNotes(name, notes);
    res.json({ ok: true });
  }));

  // ---------- settings (allocation + alert thresholds) ----------
  router.get('/settings', requireAdmin, (_req, res) => res.json({ settings: settings.all() }));
  router.put('/settings', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body ?? {};
    const num = (k, min, max, isInt = false) => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < min || v > max || (isInt && !Number.isInteger(v))) throw bad(`${k} must be between ${min} and ${max}`);
      settings.set(k, v, req.session.username);
    };
    num('cpu_overcommit', 1, 8);
    num('memory_overcommit', 1, 2);
    num('host_memory_reserve', 256 * MiB, 64 * GiB, true);
    num('disk_reserve_percent', 0, 50, true);
    for (const k of ['alert_cpu', 'alert_memory', 'alert_disk', 'alert_backup_disk_free']) num(k, 1, 100, true);
    num('alert_temp', 40, 110, true);
    num('alert_sustain_minutes', 1, 60, true);
    num('terminal_idle_minutes', 1, 240, true);
    num('terminal_max_minutes', 5, 1440, true);
    if (b.allowed_domain_suffixes !== undefined) {
      const list = Array.isArray(b.allowed_domain_suffixes) ? b.allowed_domain_suffixes.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : null;
      if (!list || list.length > 20 || !list.every((s) => /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s))) throw bad('Domain suffixes must be domain names like gyannportal.com');
      settings.set('allowed_domain_suffixes', list, req.session.username);
    }
    allocator.invalidate();
    audit.log({ ...who(req), action: 'settings_update', result: 'success', detail: Object.keys(b).join(', ') });
    res.json({ settings: settings.all() });
  }));

  return { router };
}
