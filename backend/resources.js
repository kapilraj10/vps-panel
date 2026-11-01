// Resource allocation: what the host has, what containers were promised, and whether a new promise fits.
// A container without a limit can use the whole host, so it counts as the whole host here.
import { listStoragePools, poolResources, getProfile } from './lxd.js';
import { settings, users } from './db.js';

const POOL_CACHE_MS = 60_000;
const GiB = 1024 ** 3;

export function createAllocator({ containers, hostCores, hostMem }) {
  let pools = { at: 0, list: [], error: null };

  async function loadPools() {
    if (Date.now() - pools.at < POOL_CACHE_MS) return pools;
    try {
      const list = await listStoragePools();
      const out = [];
      for (const p of list) {
        let space = null;
        try { space = (await poolResources(p.name)).space; } catch { /* pool offline */ }
        out.push({ name: p.name, driver: p.driver, status: p.status, total: space?.total ?? null, used: space?.used ?? null });
      }
      pools = { at: Date.now(), list: out, error: null };
    } catch (err) {
      pools = { at: Date.now(), list: [], error: err.message };
    }
    return pools;
  }

  async function defaultPool() {
    try {
      const prof = await getProfile('default');
      return Object.values(prof.devices || {}).find((d) => d.type === 'disk' && d.path === '/')?.pool || null;
    } catch { return null; }
  }

  async function summary() {
    const cfg = settings.all();
    const cores = hostCores();
    const mem = hostMem();
    const { list: poolList, error: poolError } = await loadPools();
    const items = containers.names().map((name) => {
      const f = containers.facts(name) || { limits: {} };
      return {
        name,
        status: containers.snapshot(name)?.status,
        cpu: f.limits.cpu, memory: f.limits.memory, disk: f.limits.disk, pool: f.pool,
        owners: users.ownersOf(name).map((u) => u.username),
      };
    });
    const cpuAllocated = items.reduce((s, i) => s + (i.cpu ?? cores), 0);
    const memAllocated = items.reduce((s, i) => s + (i.memory ?? mem), 0);
    const cpuCapacity = cores * Number(cfg.cpu_overcommit || 1);
    const memCapacity = Math.max(0, mem - Number(cfg.host_memory_reserve || 0)) * Number(cfg.memory_overcommit || 1);
    const poolView = poolList.map((p) => {
      const allocated = items.filter((i) => i.pool === p.name).reduce((s, i) => s + (i.disk || 0), 0);
      const unlimited = items.filter((i) => i.pool === p.name && !i.disk).map((i) => i.name);
      const capacity = p.total != null ? Math.floor(p.total * (1 - Number(cfg.disk_reserve_percent || 0) / 100)) : null;
      return { ...p, allocated, capacity, unlimited };
    });
    const warnings = [];
    const unlimitedCpu = items.filter((i) => i.cpu == null).map((i) => i.name);
    const unlimitedMem = items.filter((i) => i.memory == null).map((i) => i.name);
    if (unlimitedCpu.length) warnings.push(`No CPU limit on: ${unlimitedCpu.join(', ')}. Each counts as all ${cores} cores until you set a limit.`);
    if (unlimitedMem.length) warnings.push(`No memory limit on: ${unlimitedMem.join(', ')}. Each counts as all host RAM until you set a limit.`);
    if (cpuAllocated > cpuCapacity) warnings.push(`CPU is already over-allocated: ${cpuAllocated} vCPUs promised, capacity ${cpuCapacity}.`);
    if (memAllocated > memCapacity) warnings.push(`Memory is already over-allocated (${(memAllocated / GiB).toFixed(1)} GiB promised, ${(memCapacity / GiB).toFixed(1)} GiB capacity).`);
    for (const p of poolView) {
      if (p.driver === 'dir') warnings.push(`Storage pool "${p.name}" uses the dir driver: disk size limits are only enforced if the filesystem has project quotas.`);
      if (p.capacity != null && p.allocated > p.capacity) warnings.push(`Storage pool "${p.name}" is over-allocated.`);
    }
    return {
      host: { cores, memory: mem },
      settings: {
        cpuOvercommit: cfg.cpu_overcommit, memoryOvercommit: cfg.memory_overcommit,
        hostMemoryReserve: cfg.host_memory_reserve, diskReservePercent: cfg.disk_reserve_percent,
      },
      cpu: { allocated: cpuAllocated, capacity: cpuCapacity, free: cpuCapacity - cpuAllocated },
      memory: { allocated: memAllocated, capacity: memCapacity, free: memCapacity - memAllocated },
      pools: poolView,
      poolError,
      defaultPool: await defaultPool(),
      containers: items,
      warnings,
    };
  }

  // Would giving `want` (cpu cores, memory bytes, disk bytes on pool) fit? `exclude` = container being resized.
  // `forUser` = also check that user's quota.
  async function check({ cpu, memory, disk, pool, exclude = null, forUser = null }) {
    const s = await summary();
    const errors = [];
    const warnings = [];
    const old = exclude ? s.containers.find((c) => c.name === exclude) : null;
    const cores = s.host.cores;
    const mem = s.host.memory;
    const cpuAfter = s.cpu.allocated - (old ? old.cpu ?? cores : 0) + cpu;
    const memAfter = s.memory.allocated - (old ? old.memory ?? mem : 0) + memory;
    if (cpu > cores) errors.push(`A container cannot have more than the host's ${cores} cores.`);
    if (memory > mem) errors.push('A container cannot have more memory than the host.');
    if (cpuAfter > s.cpu.capacity) {
      errors.push(`Not enough CPU: ${cpuAfter} vCPUs would be promised but capacity is ${s.cpu.capacity} (${cores} cores × overcommit ${s.settings.cpuOvercommit}). Lower the CPU, shrink another container, or raise the CPU overcommit ratio in Settings.`);
    } else if (cpuAfter > cores) {
      warnings.push(`CPU is overcommitted: ${cpuAfter} vCPUs on ${cores} cores. Containers will share cores under load.`);
    }
    if (memAfter > s.memory.capacity) {
      errors.push(`Not enough memory: ${(memAfter / GiB).toFixed(1)} GiB would be promised but capacity is ${(s.memory.capacity / GiB).toFixed(1)} GiB (host RAM minus ${(s.settings.hostMemoryReserve / GiB).toFixed(1)} GiB reserved for the host).`);
    } else if (memAfter > s.memory.capacity * 0.9) {
      warnings.push('Memory will be more than 90% allocated after this change.');
    }
    const p = s.pools.find((x) => x.name === (pool || s.defaultPool));
    if (disk) {
      if (!p) {
        warnings.push('Could not read the storage pool size, so disk space was not checked.');
      } else if (p.capacity != null) {
        const after = p.allocated - (old?.pool === p.name ? old.disk || 0 : 0) + disk;
        if (after > p.capacity) errors.push(`Not enough disk in pool "${p.name}": ${(after / GiB).toFixed(0)} GiB would be promised but only ${(p.capacity / GiB).toFixed(0)} GiB may be allocated.`);
        if (p.total != null && p.used != null && disk > p.total - p.used) warnings.push(`Pool "${p.name}" has only ${((p.total - p.used) / GiB).toFixed(0)} GiB actually free right now.`);
      }
    }
    if (forUser) {
      const u = users.byId(forUser);
      if (u) {
        const mine = s.containers.filter((c) => u.containers.includes(c.name) && c.name !== exclude);
        const add = exclude && u.containers.includes(exclude) ? 0 : 1;
        if (u.max_containers != null && mine.length + add > u.max_containers) errors.push(`${u.username} may have at most ${u.max_containers} server(s).`);
        const sum = (k, own) => mine.reduce((t, c) => t + (c[k] ?? own), 0);
        if (u.max_cpu != null && sum('cpu', cores) + cpu > u.max_cpu) errors.push(`${u.username}'s CPU quota is ${u.max_cpu} cores in total.`);
        if (u.max_memory != null && sum('memory', mem) + memory > u.max_memory) errors.push(`${u.username}'s memory quota is ${(u.max_memory / GiB).toFixed(1)} GiB in total.`);
        if (u.max_disk != null && disk && sum('disk', 0) + disk > u.max_disk) errors.push(`${u.username}'s disk quota is ${(u.max_disk / GiB).toFixed(0)} GiB in total.`);
      }
    }
    return { ok: errors.length === 0, errors, warnings, pool: p?.name || pool || s.defaultPool, summary: s };
  }

  return { summary, check, invalidate: () => { pools.at = 0; } };
}
