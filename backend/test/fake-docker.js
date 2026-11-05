// TEST ONLY: a small Docker Engine API on a unix socket. Starting a container really starts test/fake-app.js on the
// published host port, so health checks and traffic hit a live server. Images whose tag contains "broken" serve a failing
// /health (a bad release); pulling an image containing "missing" fails.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function startFakeDocker(socketPath, { flags } = {}) {
  const containers = new Map(); // id -> { id, name, image, env, labels, ports, state, child, created, restarts, hostConfig }
  const images = new Map([['nginx:alpine', { id: crypto.randomBytes(32).toString('hex'), size: 4e7 }]]);
  const volumes = new Map([['dbdata', { Name: 'dbdata', Driver: 'local', CreatedAt: new Date().toISOString(), Labels: {} }]]);
  const networks = new Map([['bridge', { Id: crypto.randomBytes(32).toString('hex'), Name: 'bridge', Driver: 'bridge', Scope: 'local', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } }]]);
  const calls = [];

  const find = (key) => [...containers.values()].find((c) => c.id.startsWith(key) || c.name === key);
  const stop = (c) => { if (c.child) { c.child.kill(); c.child = null; } c.state = 'exited'; };
  const startC = (c) => {
    stop(c);
    const hostPort = Object.values(c.hostConfig.PortBindings || {})[0]?.[0]?.HostPort;
    if (hostPort) {
      const env = Object.fromEntries(c.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
      c.child = spawn(process.execPath, [path.join(here, 'fake-app.js')], {
        env: { ...process.env, ...env, HOST_PORT: hostPort, FAKE_FLAGS: flags || '', BROKEN: c.image.includes('broken') ? '1' : '0' }, stdio: 'ignore',
      });
    }
    c.state = 'running';
    c.started = Date.now();
  };
  const listView = (c) => ({
    Id: c.id, Names: [`/${c.name}`], Image: c.image, State: c.state, Status: c.state === 'running' ? 'Up' : 'Exited (0)', Created: Math.floor(c.created / 1000),
    Labels: c.labels, Ports: Object.entries(c.hostConfig.PortBindings || {}).map(([k, v]) => ({ IP: v[0].HostIp, PublicPort: Number(v[0].HostPort), PrivatePort: Number(k.split('/')[0]), Type: 'tcp' })),
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://docker');
      const p = url.pathname.replace(/^\/v[\d.]+/, '');
      const json = body ? JSON.parse(body) : null;
      calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body: json });
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      const err = (code, message) => send(code, { message });
      let m;
      if (req.method === 'GET' && p === '/info') return send(200, { OperatingSystem: 'Fake OS', Containers: containers.size, ContainersRunning: [...containers.values()].filter((c) => c.state === 'running').length, Images: images.size, Driver: 'overlay2', NCPU: 4, MemTotal: 8e9, Swarm: { LocalNodeState: 'inactive' } });
      if (req.method === 'GET' && p === '/version') return send(200, { Version: '27.0.0-fake', ApiVersion: '1.46' });
      if (req.method === 'GET' && p === '/containers/json') {
        let list = [...containers.values()];
        if (url.searchParams.get('all') !== 'true') list = list.filter((c) => c.state === 'running');
        const f = url.searchParams.get('filters');
        if (f) for (const l of JSON.parse(f).label || []) { const [k, v] = l.split('='); list = list.filter((c) => c.labels[k] === v); }
        return send(200, list.map(listView));
      }
      if (req.method === 'POST' && p === '/containers/create') {
        const name = url.searchParams.get('name');
        if (find(name)) return err(409, `Conflict. The container name "/${name}" is already in use`);
        if (json.HostConfig?.Privileged) return err(400, 'privileged not allowed in fake');
        const id = crypto.randomBytes(32).toString('hex');
        containers.set(id, { id, name, image: json.Image, env: json.Env || [], labels: json.Labels || {}, hostConfig: json.HostConfig || {}, state: 'created', created: Date.now(), restarts: 0 });
        return send(201, { Id: id, Warnings: [] });
      }
      if ((m = p.match(/^\/containers\/([^/]+)\/(start|stop|restart|pause|unpause)$/)) && req.method === 'POST') {
        const c = find(decodeURIComponent(m[1]));
        if (!c) return err(404, `No such container: ${m[1]}`);
        if (m[2] === 'start') { if (c.state === 'running') return send(304); startC(c); }
        if (m[2] === 'stop') { if (c.state !== 'running') return send(304); stop(c); }
        if (m[2] === 'restart') { c.restarts += 1; startC(c); }
        if (m[2] === 'pause') c.state = 'paused';
        if (m[2] === 'unpause') c.state = 'running';
        return send(204);
      }
      if ((m = p.match(/^\/containers\/([^/]+)$/)) && req.method === 'DELETE') {
        const c = find(decodeURIComponent(m[1]));
        if (!c) return err(404, `No such container: ${m[1]}`);
        if (c.state === 'running' && url.searchParams.get('force') !== 'true') return err(409, 'You cannot remove a running container. Stop it first or use force');
        stop(c);
        containers.delete(c.id);
        return send(204);
      }
      if ((m = p.match(/^\/containers\/([^/]+)\/json$/))) {
        const c = find(decodeURIComponent(m[1]));
        if (!c) return err(404, `No such container: ${m[1]}`);
        return send(200, {
          Id: c.id, Name: `/${c.name}`, Image: 'sha256:abc', Created: new Date(c.created).toISOString(), RestartCount: c.restarts,
          State: { Status: c.state, Running: c.state === 'running' }, Config: { Image: c.image, Env: c.env, Labels: c.labels, Cmd: null },
          HostConfig: c.hostConfig, NetworkSettings: { Ports: {}, Networks: { bridge: {} } }, Mounts: [],
        });
      }
      if ((m = p.match(/^\/containers\/([^/]+)\/logs$/))) {
        const c = find(decodeURIComponent(m[1]));
        if (!c) return err(404, 'No such container');
        const line = Buffer.from(`2026-11-05T00:00:00Z hello from ${c.name}\n`);
        const head = Buffer.alloc(8); head[0] = 1; head.writeUInt32BE(line.length, 4);
        res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' });
        return res.end(Buffer.concat([head, line]));
      }
      if ((m = p.match(/^\/containers\/([^/]+)\/stats$/))) {
        return send(200, { cpu_stats: { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 1e11, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 1e9 }, system_cpu_usage: 9e10 }, memory_stats: { usage: 5e7, limit: 1e9, stats: { inactive_file: 1e7 } }, networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } }, pids_stats: { current: 3 } });
      }
      if (req.method === 'POST' && p === '/images/create') {
        const ref = `${url.searchParams.get('fromImage')}:${url.searchParams.get('tag') || 'latest'}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (ref.includes('missing')) return res.end(`{"status":"Pulling"}\n{"error":"manifest for ${ref} not found"}\n`);
        images.set(ref, { id: crypto.randomBytes(32).toString('hex'), size: 1e8 });
        return res.end('{"status":"Pulling"}\n{"status":"Downloaded newer image"}\n');
      }
      if (req.method === 'GET' && p === '/images/json') return send(200, [...images].map(([tag, i]) => ({ Id: `sha256:${i.id}`, RepoTags: [tag], Size: i.size, Created: 1700000000, Containers: 0 })));
      if (req.method === 'GET' && p === '/networks') return send(200, [...networks.values()]);
      if (req.method === 'POST' && p === '/networks/create') { const id = crypto.randomBytes(32).toString('hex'); networks.set(json.Name, { Id: id, Name: json.Name, Driver: 'bridge', Scope: 'local', IPAM: { Config: [] } }); return send(201, { Id: id }); }
      if ((m = p.match(/^\/networks\/([^/]+)$/))) {
        const n = [...networks.values()].find((x) => x.Id.startsWith(m[1]) || x.Name === m[1]);
        if (!n) return err(404, 'network not found');
        if (req.method === 'DELETE') { networks.delete(n.Name); return send(204); }
        return send(200, n);
      }
      if (req.method === 'GET' && p === '/volumes') return send(200, { Volumes: [...volumes.values()] });
      if (req.method === 'POST' && p === '/volumes/create') { volumes.set(json.Name, { Name: json.Name, Driver: 'local', CreatedAt: new Date().toISOString(), Labels: {} }); return send(201, volumes.get(json.Name)); }
      if ((m = p.match(/^\/volumes\/([^/]+)$/)) && req.method === 'DELETE') { if (!volumes.delete(m[1])) return err(404, 'no such volume'); return send(204); }
      if (req.method === 'GET' && p === '/system/df') return send(200, { Volumes: [...volumes.values()].map((v) => ({ Name: v.Name, UsageData: { Size: 1234, RefCount: 0 } })) });
      return err(404, `fake docker: ${req.method} ${p} not implemented`);
    });
  });

  return new Promise((resolve) => {
    fs.rmSync(socketPath, { force: true });
    server.listen(socketPath, () => resolve({
      containers, calls, images, volumes,
      close: () => new Promise((r) => { for (const c of containers.values()) stop(c); server.close(() => r()); }),
    }));
  });
}
