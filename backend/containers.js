// Polls LXD for every instance, keeps 1 hour of live CPU/memory history, records configuration facts,
// notices unexpected stops, and runs long container tasks (start, create, snapshot...) as tracked jobs.
import crypto from 'node:crypto';
import { listInstances, getState, changeState, parseSize } from './lxd.js';
import { containerMeta, users } from './db.js';

const SSH_HOST_TEMPLATE = process.env.SSH_HOST_TEMPLATE || '{name}.gyannportal.com';

export const roomFor = (name) => `ct:${name}`;

export function cpuCount(v, hostCores) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.max(1, Number(v));
  // CPU pinning like "0-1,3" -> count the cores
  let n = 0;
  for (const part of String(v).split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isFinite(a)) continue;
    n += Number.isFinite(b) ? b - a + 1 : 1;
  }
  return n || hostCores;
}

export function memBytes(v, hostMem) {
  if (!v) return null;
  if (String(v).endsWith('%')) return Math.round((hostMem * parseFloat(v)) / 100);
  return parseSize(v);
}

function ipv4(state, iface) {
  const addrs = state.network?.[iface]?.addresses || [];
  return addrs.find((a) => a.family === 'inet' && a.scope === 'global')?.address || null;
}

// Configuration facts derived from an instance object (limits, image, security flags)
export function describe(inst, hostCores, hostMem) {
  const config = inst.expanded_config || inst.config || {};
  const devices = inst.expanded_devices || inst.devices || {};
  const nic = Object.entries(devices).find(([, d]) => d.type === 'nic');
  const root = Object.values(devices).find((d) => d.type === 'disk' && d.path === '/');
  const cpuSet = cpuCount(config['limits.cpu'], hostCores);
  const memSet = memBytes(config['limits.memory'], hostMem);
  return {
    type: inst.type,
    image: config['image.description'] || [config['image.os'], config['image.release']].filter(Boolean).join(' ') || null,
    createdAt: inst.created_at ? Date.parse(inst.created_at) : null,
    profiles: inst.profiles || [],
    limits: {
      cpu: cpuSet, // null = no limit (can use every host core)
      memory: memSet, // null = no limit
      disk: parseSize(root?.size), // null = no quota
      ingress: nic?.[1]?.['limits.ingress'] || null,
      egress: nic?.[1]?.['limits.egress'] || null,
    },
    nic: nic ? { name: nic[0], network: nic[1].network || nic[1].parent || null, fixedIp: nic[1]['ipv4.address'] || null } : null,
    pool: root?.pool || null,
    privileged: config['security.privileged'] === 'true',
    nesting: config['security.nesting'] === 'true',
    rawLxc: !!config['raw.lxc'],
    deleteProtection: config['security.protection.delete'] === 'true',
    autostart: config['boot.autostart'] === 'true',
    hostname: inst.name,
  };
}

export function createContainerMonitor({ io, sampleMs, maxPoints, hostCores, hostMem, onSample = () => {}, onUnexpectedStop = () => {}, onRecovered = () => {} }) {
  const live = new Map(); // name -> { snapshot, history, prev, facts }
  const running = new Map(); // name -> current job
  const expected = new Map(); // name -> until (ms): the panel itself is changing this container's state
  let lxdError = null;
  let firstPoll = true;

  const emitTo = (name, event, data) => io.to(['admin', roomFor(name)]).emit(event, data);
  const expect = (name, ms = 10 * 60_000) => expected.set(name, Date.now() + ms);

  async function poll() {
    let instances;
    try {
      instances = await listInstances();
      lxdError = null;
    } catch (err) {
      lxdError = err.message;
      return;
    }

    const metas = containerMeta.all();
    const seen = new Set();
    await Promise.all(instances.map(async (inst) => {
      const { name } = inst;
      seen.add(name);
      // Anything the panel did not create is recorded as pre-existing and protected from delete/rebuild
      if (!metas[name] && !running.has(name)) containerMeta.adoptExisting(name);
      let state;
      try { state = await getState(name); } catch { return; }

      const now = Date.now();
      const facts = describe(inst, hostCores(), hostMem());
      const cores = facts.limits.cpu || hostCores();
      const entry = live.get(name) || { history: [], prev: null };
      const isRunning = state.status === 'Running';
      const wasStatus = entry.snapshot?.status;

      const cpuNs = state.cpu?.usage || 0;
      const nicName = facts.nic?.name || 'eth0';
      const eth = state.network?.[nicName]?.counters || {};
      const prev = entry.prev;
      const dt = prev ? (now - prev.t) / 1000 : 0;
      let cpu = 0;
      let rx = 0;
      let tx = 0;
      if (prev && dt > 0 && isRunning) {
        cpu = Math.max(0, Math.min(100, ((cpuNs - prev.cpuNs) / (dt * 1e9 * cores)) * 100));
        rx = Math.max(0, ((eth.bytes_received || 0) - prev.rxBytes) / dt);
        tx = Math.max(0, ((eth.bytes_sent || 0) - prev.txBytes) / dt);
      }
      entry.prev = { t: now, cpuNs, rxBytes: eth.bytes_received || 0, txBytes: eth.bytes_sent || 0 };

      const memTotal = facts.limits.memory || state.memory?.total || hostMem();
      const memUsed = isRunning ? state.memory?.usage || 0 : 0;
      const root = state.disk?.root || {};
      const point = {
        t: now,
        cpu: Math.round(cpu * 10) / 10,
        mem: memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
      };
      entry.history.push(point);
      if (entry.history.length > maxPoints) entry.history.shift();

      const startedAt = isRunning && inst.last_used_at ? Date.parse(inst.last_used_at) : null;
      const meta = metas[name] || containerMeta.get(name) || {};
      entry.facts = facts;
      entry.snapshot = {
        name,
        status: state.status,
        startedAt: startedAt && startedAt > 0 ? startedAt : null,
        cpu: point.cpu,
        cores,
        memUsed,
        memTotal,
        diskUsed: root.usage || 0,
        diskTotal: root.total > 0 ? root.total : facts.limits.disk || 0,
        rx: Math.round(rx),
        tx: Math.round(tx),
        rxTotal: eth.bytes_received || 0,
        txTotal: eth.bytes_sent || 0,
        processes: state.processes ?? null,
        ip: ipv4(state, nicName) || facts.nic?.fixedIp || null,
        ssh: SSH_HOST_TEMPLATE.replace('{name}', name),
        image: facts.image,
        limits: facts.limits,
        protected: !!meta.protected,
        origin: meta.origin || 'existing',
        privileged: facts.privileged,
      };
      live.set(name, entry);
      onSample(name, entry.snapshot);
      emitTo(name, 'container:sample', { snapshot: entry.snapshot, point, action: running.get(name) || null });

      // Running -> Stopped without the panel asking for it (crash, OOM, someone ran `lxc stop` by hand)
      if (!firstPoll && wasStatus === 'Running' && state.status === 'Stopped') {
        const until = expected.get(name) || 0;
        if (until < now && !running.has(name)) onUnexpectedStop(name);
      }
      if (wasStatus && wasStatus !== 'Running' && isRunning) onRecovered(name);
    }));

    for (const name of live.keys()) if (!seen.has(name)) live.delete(name);
    for (const [name, until] of expected) if (until < Date.now()) expected.delete(name);
    firstPoll = false;
  }

  async function loop() {
    try { await poll(); } catch (err) { console.error('Container poll failed:', err.message); }
    setTimeout(loop, sampleMs).unref();
  }

  const mon = {
    start: loop,
    poll: () => poll().catch(() => {}),
    error: () => lxdError,
    // Allowlist: only names LXD reported on the last poll
    exists: (name) => live.has(name),
    names: () => [...live.keys()].sort(),
    facts: (name) => live.get(name)?.facts || null,
    snapshot: (name) => live.get(name)?.snapshot || null,
    all: () => [...live.values()].map((e) => e.snapshot),
    view(name) {
      const e = live.get(name);
      return e && { ...e.snapshot, history: e.history, action: running.get(name) || null, owners: users.ownersOf(name).map((u) => u.username) };
    },
    busy: (name) => running.has(name),
    expect,

    // Runs `work(progress)` in the background as the one job for this container.
    // Progress and the result arrive through 'container:action' socket events.
    run(name, action, username, onDone, work = null, { room = name } = {}) {
      const job = { id: crypto.randomUUID(), container: name, action, by: username, startedAt: Date.now(), status: 'running', message: '' };
      running.set(name, job);
      if (['stop', 'restart', 'freeze', 'delete', 'rebuild', 'rename', 'restore-snapshot', 'resources', 'set-ip'].includes(action)) expect(name);
      emitTo(room, 'container:action', job);
      const progress = (msg) => { job.message = String(msg || ''); emitTo(room, 'container:action', job); };
      Promise.resolve()
        .then(() => (work ? work(progress) : changeState(name, action, progress)))
        .then((result) => { job.status = 'success'; job.message = typeof result === 'string' ? result : ''; })
        .catch((err) => { job.status = 'failure'; job.message = err.message; })
        // Refresh the status first so the result and the new state arrive together
        .then(() => poll().catch(() => {}))
        .finally(() => {
          running.delete(name);
          job.finishedAt = Date.now();
          emitTo(room, 'container:action', job);
          onDone(job);
        });
      return job;
    },
  };
  return mon;
}
