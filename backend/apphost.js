// "Main server" deploy target: users without a VPS of their own deploy apps straight from the panel.
//
// Each such user gets ONE panel-managed LXD container on the main server, apps-<username>. The user never has to set it
// up: the panel creates it on the first app, installs the runtime, grows its limits by each app's plan and deletes it
// when the last app is gone. Apps still run isolated in an unprivileged container (never on the host itself), so
// deploys, domains, backups and billing work exactly like apps on a user's own server.
import { createInstance, changeState, updateInstance, deleteInstance, toMiB, toGiB } from './lxd.js';
import { db, users, containerMeta, audit } from './db.js';
import { plans } from './billing.js';

export const HOST_IMAGE = 'ubuntu-24.04';
export const MANAGED_BY = 'kapil-cloud'; // container_meta.created_by of app hosts (users cannot delete them as "their own")
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
// Minimum size of an app host, even for tiny plans (the OS + PM2 need room)
const FLOOR = { cpu: 1, memoryMb: 512, diskGb: 5 };

export const hostNameFor = (username) => `apps-${String(username).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 60).replace(/-+$/, '');
export const isAppHost = (name) => containerMeta.get(name)?.created_by === MANAGED_BY;

export function createAppHost({ containers, allocator }) {
  const locks = new Map(); // host name -> promise chain, so two apps never resize/create one host at the same time
  const serial = (name, fn) => {
    const next = (locks.get(name) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(name, next);
    return next;
  };

  // Size the host needs for its apps (+ one more plan when adding)
  function wanted(host, extraPlan = null) {
    const rows = db.prepare("SELECT plan_id FROM apps WHERE container = ? AND target = 'main'").all(host);
    const list = rows.map((r) => plans.get(r.plan_id)).filter(Boolean);
    if (extraPlan) list.push(extraPlan);
    const sum = (k) => list.reduce((t, p) => t + (p[k] || 0), 0);
    return {
      cpu: Math.max(FLOOR.cpu, ...list.map((p) => p.cpu || 0)), // cores are shared by the apps, the biggest one decides
      memoryMb: Math.max(FLOOR.memoryMb, sum('memory_mb')),
      diskGb: Math.max(FLOOR.diskGb, sum('disk_gb')),
    };
  }

  // Is there room on the main server for this plan? Returns error text or null.
  async function checkRoom(user, plan) {
    const host = hostNameFor(user.username);
    const exists = containers.exists(host);
    const w = wanted(host, plan);
    const r = await allocator.check({ cpu: w.cpu, memory: w.memoryMb * MiB, disk: w.diskGb * GiB, exclude: exists ? host : null });
    return r.ok ? null : r.errors.join(' ');
  }

  async function waitRunning(name, ms = 120_000) {
    const end = Date.now() + ms;
    for (;;) {
      await containers.poll();
      if (containers.snapshot(name)?.status === 'Running') return;
      if (Date.now() > end) throw new Error(`${name} did not start`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Creates or grows the user's app host so it fits all its apps (rows already saved). Resolves with the host name once running.
  function ensure(user, progress = () => {}) {
    const host = hostNameFor(user.username);
    return serial(host, async () => {
      const w = wanted(host);
      if (!containers.exists(host)) {
        progress(`Creating your app host ${host} on the main server`);
        containerMeta.createdByPanel(host, { image: HOST_IMAGE, by: MANAGED_BY });
        try {
          await createInstance({
            name: host, image: HOST_IMAGE, description: `Kapil Cloud app host for ${user.username}`,
            config: {
              'limits.cpu': String(w.cpu), 'limits.memory': `${w.memoryMb}MiB`, 'limits.memory.enforce': 'hard',
              'security.privileged': 'false', 'security.nesting': 'false', 'boot.autostart': 'true',
              'user.kapilcloud.owner': user.username, 'user.kapilcloud.app-host': 'true',
            },
            devices: { root: { type: 'disk', path: '/', pool: (await allocator.summary()).defaultPool || 'default', size: `${w.diskGb}GiB` } },
          });
        } catch (err) {
          if (!/already exists/i.test(err.message)) containerMeta.remove(host);
          throw err;
        }
        users.assign(user.id, host);
        audit.log({ username: user.username, action: 'apphost_create', target: host, result: 'success', detail: `${w.cpu} CPU, ${w.memoryMb} MB, ${w.diskGb} GB` });
      } else {
        await resize(host, w);
      }
      if (containers.snapshot(host)?.status !== 'Running') { progress('Starting the app host'); await changeState(host, 'start').catch(() => {}); }
      await waitRunning(host);
      return host;
    });
  }

  async function resize(host, w = wanted(host)) {
    await updateInstance(host, (next, cur) => {
      next.config['limits.cpu'] = String(w.cpu);
      next.config['limits.memory'] = `${w.memoryMb}MiB`;
      const exp = cur.expanded_devices || {};
      const key = Object.keys(next.devices).find((k) => next.devices[k].type === 'disk' && next.devices[k].path === '/') || 'root';
      const curSize = Number(String(next.devices[key]?.size || exp[key]?.size || '0').replace(/GiB$/, '')) || 0;
      // disks only grow (shrinking can destroy data)
      next.devices[key] = { ...(exp[key] || { type: 'disk', path: '/' }), ...(next.devices[key] || {}), size: `${Math.max(curSize, w.diskGb)}GiB` };
    });
  }

  // After an app is deleted: shrink the host, or delete it when no app is left
  function release(host) {
    return serial(host, async () => {
      if (!isAppHost(host)) return;
      const left = db.prepare('SELECT COUNT(*) AS n FROM apps WHERE container = ?').get(host).n;
      if (left) { await resize(host).catch(() => {}); return; }
      if (containers.snapshot(host)?.status === 'Running') await changeState(host, 'stop', () => {}, { force: true }).catch(() => {});
      await deleteInstance(host);
      db.transaction(() => { users.unassignContainer(host); containerMeta.remove(host); })();
      audit.log({ username: MANAGED_BY, action: 'apphost_delete', target: host, result: 'success', detail: 'last app removed' });
      await containers.poll();
    });
  }

  return { ensure, release, checkRoom, hostNameFor, isAppHost, toMiB, toGiB };
}
