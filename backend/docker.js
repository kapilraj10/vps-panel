// DockerService: the host's Docker Engine through its unix socket (DOCKER_SOCKET, default /var/run/docker.sock).
// Admins can look; only a super admin changes anything. Safety rules for containers created here:
//   * never privileged, no host network/PID, no extra capabilities
//   * published ports bind to 127.0.0.1 only (public traffic goes through Nginx / Cloudflare Tunnel)
//   * only named Docker volumes, never host bind mounts (a bind mount of / would be host root)
// Env values of existing containers are never sent to the browser (names only).
import express from 'express';
import http from 'node:http';
import { requireAdmin, requireSuperAdmin, clientIp } from './auth.js';
import { audit } from './db.js';
import { locks, parseEnv, allowedDir, hostRun } from './hostexec.js';
import { wrap, bad, notFound, int, str, HttpError } from './http.js';

const SOCKET = () => process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API = '/v1.41';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function dockerRequest(method, path, { body, query, timeout = 30_000, raw = false } = {}) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]))}` : '';
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath: SOCKET(), method, path: `${API}${path}${qs}`, timeout,
      headers: { host: 'docker', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = buf.toString('utf8');
          try { msg = JSON.parse(msg).message || msg; } catch { /* plain text */ }
          return reject(new HttpError(res.statusCode === 404 ? 404 : res.statusCode === 409 ? 409 : 502, `Docker: ${msg.trim().slice(0, 300)}`));
        }
        if (raw) return resolve(buf);
        const text = buf.toString('utf8');
        try { return resolve(text ? JSON.parse(text) : null); } catch { return resolve(text); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker did not answer in time')));
    req.on('error', (err) => reject(new HttpError(503, err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES'
      ? `Docker is not available (${err.code} on ${SOCKET()})` : `Docker: ${err.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

// Non-TTY logs come multiplexed: 8-byte header [stream, 0, 0, 0, size(4)] + payload
export function demux(buf) {
  const out = [];
  let i = 0;
  if (buf.length < 8 || ![0, 1, 2].includes(buf[0]) || buf[1] || buf[2] || buf[3]) return buf.toString('utf8');
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return out.join('');
}

function cpuPercent(s) {
  const cpu = s.cpu_stats || {};
  const pre = s.precpu_stats || {};
  const d = (cpu.cpu_usage?.total_usage || 0) - (pre.cpu_usage?.total_usage || 0);
  const sys = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const n = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  return d > 0 && sys > 0 ? Math.round((d / sys) * n * 1000) / 10 : 0;
}
const memUsed = (s) => {
  const m = s.memory_stats || {};
  return Math.max(0, (m.usage || 0) - (m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0));
};

export async function containerStats(id) {
  const s = await dockerRequest('GET', `/containers/${encodeURIComponent(id)}/stats`, { query: { stream: false, 'one-shot': false }, timeout: 8000 });
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
  return { cpu: cpuPercent(s), memory: memUsed(s), memoryLimit: s.memory_stats?.limit || 0, rx, tx, pids: s.pids_stats?.current || 0 };
}

const summary = (c) => ({
  id: c.Id.slice(0, 12), name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status,
  createdAt: c.Created * 1000, ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => ({ ip: p.IP, host: p.PublicPort, container: p.PrivatePort, proto: p.Type })),
  compose: c.Labels?.['com.docker.compose.project'] || null, service: c.Labels?.['com.docker.compose.service'] || null,
  managedApp: c.Labels?.['kapil.cloud.app'] || null, managedDb: c.Labels?.['kapil.cloud.db'] || null,
});

// Container create body with the safety rules above. Used by the router and by replicas.js.
export function safeCreateBody({ image, env = {}, ports = [], memoryMb, cpus, volumes = [], restart = 'unless-stopped', labels = {}, cmd }) {
  const PortBindings = {};
  const ExposedPorts = {};
  for (const p of ports) {
    const key = `${p.container}/tcp`;
    ExposedPorts[key] = {};
    // hostIp is only set by the panel itself (databases offered to LXD containers bind to the bridge address)
    PortBindings[key] = [{ HostIp: p.hostIp || '127.0.0.1', HostPort: String(p.host) }];
  }
  return {
    Image: image, Env: Object.entries(env).map(([k, v]) => `${k}=${v}`), ExposedPorts, Labels: labels,
    ...(cmd ? { Cmd: cmd } : {}),
    HostConfig: {
      PortBindings, Privileged: false, NetworkMode: 'bridge', CapAdd: [], SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: restart }, Binds: volumes.map((v) => `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`),
      ...(memoryMb ? { Memory: memoryMb * 1024 * 1024 } : {}), ...(cpus ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
}

export async function pullImage(image) {
  const [fromImage, tag] = image.includes('@') ? [image, undefined] : (() => {
    const i = image.lastIndexOf(':');
    return i > image.lastIndexOf('/') ? [image.slice(0, i), image.slice(i + 1)] : [image, 'latest'];
  })();
  const out = await dockerRequest('POST', '/images/create', { query: { fromImage, tag }, timeout: 15 * 60_000, raw: true });
  const errLine = out.toString('utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.error);
  if (errLine) throw new HttpError(502, `Pull failed: ${errLine.error}`);
}

export function createDocker() {
  const router = express.Router();
  const log = (req, action, target, detail = null) => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result: 'success', detail });
  const cid = (v) => { if (!ID_RE.test(v || '')) throw bad('Bad container id'); return v; };

  router.use(requireAdmin);

  router.get('/info', wrap(async (_req, res) => {
    const [info, version] = await Promise.all([dockerRequest('GET', '/info'), dockerRequest('GET', '/version')]);
    res.json({
      version: version.Version, api: version.ApiVersion, os: info.OperatingSystem, containers: info.Containers, running: info.ContainersRunning,
      images: info.Images, driver: info.Driver, cpus: info.NCPU, memory: info.MemTotal, swarm: info.Swarm?.LocalNodeState || 'inactive',
    });
  }));

  router.get('/containers', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const list = await dockerRequest('GET', '/containers/json', { query: { all: true } });
    res.json({ containers: list.map(summary) });
  }));

  // CPU / memory / network for running containers (separate call: Docker needs ~1 s per container)
  router.get('/stats', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const list = await dockerRequest('GET', '/containers/json');
    const out = {};
    await Promise.all(list.slice(0, 50).map(async (c) => { out[c.Id.slice(0, 12)] = await containerStats(c.Id).catch(() => null); }));
    res.json({ stats: out });
  }));

  router.get('/containers/:id', wrap(async (req, res) => {
    const c = await dockerRequest('GET', `/containers/${cid(req.params.id)}/json`);
    res.json({
      container: {
        id: c.Id.slice(0, 12), name: c.Name.replace(/^\//, ''), image: c.Config.Image, imageId: c.Image, state: c.State, createdAt: c.Created,
        restartCount: c.RestartCount, restartPolicy: c.HostConfig.RestartPolicy?.Name, privileged: c.HostConfig.Privileged,
        memoryLimit: c.HostConfig.Memory || 0, nanoCpus: c.HostConfig.NanoCpus || 0, cmd: c.Config.Cmd, entrypoint: c.Config.Entrypoint,
        envKeys: (c.Config.Env || []).map((e) => e.split('=')[0]), labels: c.Config.Labels, ports: c.NetworkSettings.Ports,
        networks: Object.keys(c.NetworkSettings.Networks || {}), mounts: (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Name || m.Source, target: m.Destination, rw: m.RW })),
        health: c.State?.Health?.Status || null,
      },
    });
  }));

  router.get('/containers/:id/logs', wrap(async (req, res) => {
    const tail = int(req.query.tail ?? 300, { min: 10, max: 5000, name: 'tail' });
    const buf = await dockerRequest('GET', `/containers/${cid(req.params.id)}/logs`, { query: { stdout: true, stderr: true, tail, timestamps: true }, raw: true });
    res.set('Cache-Control', 'no-store');
    res.json({ logs: demux(buf) });
  }));

  for (const action of ['start', 'stop', 'restart', 'pause', 'unpause']) {
    router.post(`/containers/:id/${action}`, requireSuperAdmin, wrap(async (req, res) => {
      const id = cid(req.params.id);
      await locks.with(`docker:${id}`, `${action} ${id}`, () => dockerRequest('POST', `/containers/${id}/${action}`, { query: action === 'stop' || action === 'restart' ? { t: 15 } : undefined, timeout: 60_000 }));
      log(req, `docker_${action}`, id);
      res.json({ ok: true });
    }));
  }

  router.delete('/containers/:id', requireSuperAdmin, wrap(async (req, res) => {
    const id = cid(req.params.id);
    const c = await dockerRequest('GET', `/containers/${id}/json`);
    const name = c.Name.replace(/^\//, '');
    if (req.body?.confirm !== name) throw bad(`Type "${name}" exactly to confirm`);
    if (c.Config.Labels?.['kapil.cloud.app']) throw bad('This container is a Kapil Cloud replica. Remove it from the Applications page.');
    if (c.Config.Labels?.['kapil.cloud.db']) throw bad('This container is a Kapil Cloud database. Remove it from the Databases page.');
    await locks.with(`docker:${id}`, `remove ${name}`, () => dockerRequest('DELETE', `/containers/${id}`, { query: { force: !!req.body.force, v: false } }));
    log(req, 'docker_remove', name, req.body.force ? 'force' : null);
    res.json({ ok: true });
  }));

  router.post('/containers', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 63, name: 'Name', re: NAME_RE });
    if (name.startsWith('kc-') || name.startsWith('kdb-')) throw bad('Names starting with kc- or kdb- are reserved for Kapil Cloud');
    const image = str(b.image, { max: 255, name: 'Image', re: IMAGE_RE });
    const ports = (Array.isArray(b.ports) ? b.ports : []).slice(0, 20).map((p) => ({
      host: int(p.host, { min: 1024, max: 65535, name: 'Host port' }), container: int(p.container, { min: 1, max: 65535, name: 'Container port' }),
    }));
    const volumes = (Array.isArray(b.volumes) ? b.volumes : []).slice(0, 20).map((v) => ({
      source: str(v.source, { max: 64, name: 'Volume name', re: NAME_RE }), target: str(v.target, { max: 200, name: 'Mount path', re: /^\/[\w./-]*$/ }),
    }));
    const memoryMb = int(b.memoryMb, { min: 16, max: 262144, name: 'Memory (MB)', optional: true });
    const cpus = b.cpus ? Number(b.cpus) : null;
    if (cpus != null && !(cpus > 0 && cpus <= 64)) throw bad('CPUs must be between 0.01 and 64');
    const restart = ['no', 'always', 'unless-stopped', 'on-failure'].includes(b.restart) ? b.restart : 'unless-stopped';
    const env = parseEnv(b.env);
    await locks.with(`docker:${name}`, `create ${name}`, async () => {
      if (b.pull !== false) await pullImage(image);
      const made = await dockerRequest('POST', '/containers/create', { query: { name }, body: safeCreateBody({ image, env, ports, memoryMb, cpus, volumes, restart }) });
      if (b.start !== false) await dockerRequest('POST', `/containers/${made.Id}/start`);
    });
    log(req, 'docker_create', name, `${image} ports=${ports.map((p) => `${p.host}:${p.container}`).join(',') || '-'}`);
    res.status(201).json({ ok: true });
  }));

  // ---------- images ----------
  router.get('/images', wrap(async (_req, res) => {
    const list = await dockerRequest('GET', '/images/json');
    res.json({ images: list.map((i) => ({ id: i.Id.replace('sha256:', '').slice(0, 12), tags: i.RepoTags?.filter((t) => t !== '<none>:<none>') || [], size: i.Size, createdAt: i.Created * 1000, containers: i.Containers ?? -1 })) });
  }));
  router.post('/images/pull', requireSuperAdmin, wrap(async (req, res) => {
    const image = str(req.body?.image, { max: 255, name: 'Image', re: IMAGE_RE });
    await locks.with(`image:${image}`, `pull ${image}`, () => pullImage(image));
    log(req, 'docker_pull', image);
    res.json({ ok: true });
  }));
  // docker build <folder> -t <tag> (folder inside HOST_APP_ROOTS)
  router.post('/images/build', requireSuperAdmin, wrap(async (req, res) => {
    const tag = str(req.body?.tag, { max: 200, name: 'Tag', re: IMAGE_RE });
    const dir = allowedDir(req.body?.context, 'Build folder');
    const r = await locks.with(`image:${tag}`, `build ${tag}`, () => hostRun('docker', ['build', '-t', tag, dir], { timeout: 30 * 60_000, maxBuffer: 32 * 1024 * 1024 }));
    log(req, 'docker_build', tag, dir);
    if (!r.ok) throw new HttpError(502, `Build failed: ${(r.error || r.stderr).trim().split('\n').slice(-5).join('\n').slice(0, 800)}`);
    res.json({ ok: true, log: `${r.stdout}\n${r.stderr}`.slice(-20_000) });
  }));
  router.delete('/images/:id', requireSuperAdmin, wrap(async (req, res) => {
    const id = req.params.id;
    if (!/^[\w.:/@-]{1,255}$/.test(id)) throw bad('Bad image id');
    if (req.body?.confirm !== id) throw bad(`Type "${id}" exactly to confirm`);
    await dockerRequest('DELETE', `/images/${encodeURIComponent(id)}`);
    log(req, 'docker_image_remove', id);
    res.json({ ok: true });
  }));

  // ---------- networks / volumes ----------
  router.get('/networks', wrap(async (_req, res) => {
    const list = await dockerRequest('GET', '/networks');
    res.json({ networks: list.map((n) => ({ id: n.Id.slice(0, 12), name: n.Name, driver: n.Driver, scope: n.Scope, subnet: n.IPAM?.Config?.[0]?.Subnet || null, internal: n.Internal, createdAt: n.Created })) });
  }));
  router.post('/networks', requireSuperAdmin, wrap(async (req, res) => {
    const name = str(req.body?.name, { max: 63, name: 'Name', re: NAME_RE });
    await dockerRequest('POST', '/networks/create', { body: { Name: name, Driver: 'bridge', Internal: !!req.body.internal, CheckDuplicate: true } });
    log(req, 'docker_network_create', name);
    res.status(201).json({ ok: true });
  }));
  router.delete('/networks/:id', requireSuperAdmin, wrap(async (req, res) => {
    const n = await dockerRequest('GET', `/networks/${cid(req.params.id)}`);
    if (['bridge', 'host', 'none'].includes(n.Name)) throw bad('Built-in networks cannot be removed');
    if (req.body?.confirm !== n.Name) throw bad(`Type "${n.Name}" exactly to confirm`);
    await dockerRequest('DELETE', `/networks/${n.Id}`);
    log(req, 'docker_network_remove', n.Name);
    res.json({ ok: true });
  }));
  router.get('/volumes', wrap(async (_req, res) => {
    const [v, df] = await Promise.all([dockerRequest('GET', '/volumes'), dockerRequest('GET', '/system/df', { timeout: 60_000 }).catch(() => null)]);
    const sizes = Object.fromEntries((df?.Volumes || []).map((x) => [x.Name, x.UsageData]));
    res.json({ volumes: (v.Volumes || []).map((x) => ({ name: x.Name, driver: x.Driver, createdAt: x.CreatedAt, compose: x.Labels?.['com.docker.compose.project'] || null, size: sizes[x.Name]?.Size ?? null, refs: sizes[x.Name]?.RefCount ?? null })) });
  }));
  router.post('/volumes', requireSuperAdmin, wrap(async (req, res) => {
    const name = str(req.body?.name, { max: 63, name: 'Name', re: NAME_RE });
    await dockerRequest('POST', '/volumes/create', { body: { Name: name } });
    log(req, 'docker_volume_create', name);
    res.status(201).json({ ok: true });
  }));
  router.delete('/volumes/:name', requireSuperAdmin, wrap(async (req, res) => {
    const name = req.params.name;
    if (!NAME_RE.test(name) && !/^[a-f0-9]{64}$/.test(name)) throw bad('Bad volume name');
    if (req.body?.confirm !== name) throw bad(`Type "${name}" exactly to confirm. The data in it is deleted.`);
    await dockerRequest('DELETE', `/volumes/${name}`);
    log(req, 'docker_volume_remove', name);
    res.json({ ok: true });
  }));

  // ---------- Compose projects (grouped by the compose labels; actions per project) ----------
  router.get('/compose', wrap(async (_req, res) => {
    const list = await dockerRequest('GET', '/containers/json', { query: { all: true } });
    const projects = {};
    for (const c of list) {
      const p = c.Labels?.['com.docker.compose.project'];
      if (!p) continue;
      const x = (projects[p] ??= { name: p, dir: c.Labels['com.docker.compose.project.working_dir'] || null, services: [], running: 0, total: 0 });
      x.total += 1;
      if (c.State === 'running') x.running += 1;
      x.services.push({ id: c.Id.slice(0, 12), service: c.Labels['com.docker.compose.service'], state: c.State, image: c.Image });
    }
    res.json({ projects: Object.values(projects) });
  }));
  router.post('/compose/:project/:action(start|stop|restart)', requireSuperAdmin, wrap(async (req, res) => {
    const { project, action } = req.params;
    if (!NAME_RE.test(project) || !['start', 'stop', 'restart'].includes(action)) throw notFound();
    const list = await dockerRequest('GET', '/containers/json', { query: { all: true, filters: { label: [`com.docker.compose.project=${project}`] } } });
    if (!list.length) throw notFound('No such compose project');
    await locks.with(`compose:${project}`, `${action} ${project}`, async () => {
      for (const c of list) await dockerRequest('POST', `/containers/${c.Id}/${action}`, { timeout: 60_000 }).catch((e) => { if (e.status !== 304) throw e; });
    });
    log(req, `compose_${action}`, project);
    res.json({ ok: true });
  }));
  // docker compose up -d / pull in the project's own folder (must be inside HOST_APP_ROOTS)
  router.post('/compose/:project/up', requireSuperAdmin, wrap(async (req, res) => {
    const { project } = req.params;
    if (!NAME_RE.test(project)) throw notFound();
    const dir = allowedDir(req.body?.dir, 'Compose folder');
    const r = await locks.with(`compose:${project}`, `up ${project}`, async () => {
      if (req.body?.pull) await hostRun('docker', ['compose', '-p', project, 'pull'], { cwd: dir, timeout: 15 * 60_000 });
      return hostRun('docker', ['compose', '-p', project, 'up', '-d', '--remove-orphans'], { cwd: dir, timeout: 15 * 60_000 });
    });
    log(req, 'compose_up', project, dir);
    if (!r.ok) throw new HttpError(502, `compose up failed: ${(r.error || r.stderr).trim().split('\n').slice(-5).join('\n').slice(0, 800)}`);
    res.json({ ok: true, log: `${r.stdout}\n${r.stderr}`.slice(-20_000) });
  }));

  return { router };
}
