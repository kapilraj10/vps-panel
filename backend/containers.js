// Polls LXD for every instance, keeps 1 hour of CPU/memory history, and runs start/stop/restart.
import crypto from 'node:crypto';
import { listInstances, getState, changeState, parseSize } from './lxd.js';

const SSH_HOST_TEMPLATE = process.env.SSH_HOST_TEMPLATE || '{name}.gyannportal.com';

export const roomFor = (name) => `ct:${name}`;

function cpuLimit(config, hostCores) {
  const v = config['limits.cpu'];
  if (!v) return hostCores;
  if (/^\d+$/.test(v)) return Math.max(1, Number(v));
  // CPU pinning like "0-1,3" -> count the cores
  let n = 0;
  for (const part of v.split(',')) {
    const [a, b] = part.split('-').map(Number);
    n += Number.isFinite(b) ? b - a + 1 : 1;
  }
  return n || hostCores;
}

function memLimit(config, state, hostMem) {
  const v = config['limits.memory'];
  if (v && v.endsWith('%')) return Math.round((hostMem * parseFloat(v)) / 100);
  return parseSize(v) || state.memory?.total || hostMem;
}

function ipv4(state, iface) {
  const addrs = state.network?.[iface]?.addresses || [];
  return addrs.find((a) => a.family === 'inet' && a.scope === 'global')?.address || null;
}

export function createContainerMonitor({ io, sampleMs, maxPoints, hostCores, hostMem }) {
  const live = new Map(); // name -> { snapshot, history, prev }
  const running = new Map(); // name -> current action
  let lxdError = null;

  const emitTo = (name, event, data) => io.to(['admin', roomFor(name)]).emit(event, data);

  async function poll() {
    let instances;
    try {
      instances = await listInstances();
      lxdError = null;
    } catch (err) {
      lxdError = err.message;
      return;
    }

    const seen = new Set();
    await Promise.all(instances.map(async (inst) => {
      const { name } = inst;
      seen.add(name);
      let state;
      try { state = await getState(name); } catch { return; }

      const now = Date.now();
      const config = inst.expanded_config || inst.config || {};
      const devices = inst.expanded_devices || inst.devices || {};
      const cores = cpuLimit(config, hostCores());
      const entry = live.get(name) || { history: [], prev: null };
      const isRunning = state.status === 'Running';

      const cpuNs = state.cpu?.usage || 0;
      const eth = state.network?.eth0?.counters || {};
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

      const memTotal = memLimit(config, state, hostMem());
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
      entry.snapshot = {
        name,
        status: state.status,
        startedAt: startedAt && startedAt > 0 ? startedAt : null,
        cpu: point.cpu,
        cores,
        memUsed,
        memTotal,
        diskUsed: root.usage || 0,
        diskTotal: root.total > 0 ? root.total : parseSize(devices.root?.size) || 0,
        rx: Math.round(rx),
        tx: Math.round(tx),
        ip: ipv4(state, 'eth0') || devices.eth0?.['ipv4.address'] || null,
        ssh: SSH_HOST_TEMPLATE.replace('{name}', name),
      };
      live.set(name, entry);
      emitTo(name, 'container:sample', { snapshot: entry.snapshot, point, action: running.get(name) || null });
    }));

    for (const name of live.keys()) if (!seen.has(name)) live.delete(name);
  }

  async function loop() {
    try { await poll(); } catch (err) { console.error('Container poll failed:', err.message); }
    setTimeout(loop, sampleMs);
  }

  return {
    start: loop,
    error: () => lxdError,
    // Allowlist: only names LXD reported on the last poll
    exists: (name) => live.has(name),
    names: () => [...live.keys()].sort(),
    view(name) {
      const e = live.get(name);
      return e && { ...e.snapshot, history: e.history, action: running.get(name) || null };
    },
    busy: (name) => running.has(name),

    // Starts the action in the background; result arrives through 'container:action' socket events
    run(name, action, username, onDone) {
      const job = { id: crypto.randomUUID(), container: name, action, by: username, startedAt: Date.now(), status: 'running', message: '' };
      running.set(name, job);
      emitTo(name, 'container:action', job);
      changeState(name, action, (opStatus) => {
        job.message = opStatus;
        emitTo(name, 'container:action', job);
      })
        .then(() => { job.status = 'success'; job.message = ''; })
        .catch((err) => { job.status = 'failure'; job.message = err.message; })
        // Refresh the status first so the result and the new state arrive together
        .then(() => poll().catch(() => {}))
        .finally(() => {
          running.delete(name);
          job.finishedAt = Date.now();
          emitTo(name, 'container:action', job);
          onDone(job);
        });
      return job;
    },
  };
}
