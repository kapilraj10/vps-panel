// TEST ONLY: a small in-memory imitation of the LXD REST API on a unix socket, so the panel's real code paths
// (REST calls, background operations, exec websockets) can be exercised without LXD. Never used by the panel.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const GiB = 1024 ** 3;

export function startFakeLxd(socketPath, { instances: initial = {} } = {}) {
  const instances = new Map();
  const ops = new Map();
  const files = new Map(); // `${name}:${path}` -> { content, uid, gid, mode, type }
  const calls = [];
  let etag = 1;

  function addInstance(name, { cpu = null, memory = null, disk = null, status = 'Running', ip = null, privileged = false } = {}) {
    const config = { 'image.description': 'Ubuntu 24.04 LTS' };
    if (cpu) config['limits.cpu'] = String(cpu);
    if (memory) config['limits.memory'] = memory;
    if (privileged) config['security.privileged'] = 'true';
    const devices = disk ? { root: { type: 'disk', path: '/', pool: 'default', size: disk } } : {};
    instances.set(name, {
      name, type: 'container', status, config, devices, profiles: ['default'], snapshots: [], created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(), ip: ip || `10.10.10.${10 + instances.size}`, architecture: 'x86_64', ephemeral: false, description: '',
    });
    files.set(`${name}:/etc/passwd`, { content: Buffer.from('root:x:0:0:root:/root:/bin/bash\nubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n'), uid: 0, gid: 0, type: 'file' });
    files.set(`${name}:/root`, { type: 'directory', uid: 0, gid: 0 });
  }
  for (const [n, o] of Object.entries(initial)) addInstance(n, o);

  const profile = { name: 'default', devices: { root: { type: 'disk', path: '/', pool: 'default' }, eth0: { type: 'nic', name: 'eth0', network: 'lxdbr0' } } };
  const expanded = (i) => ({ ...profile.devices, ...i.devices });

  function instanceObj(i) {
    return {
      name: i.name, type: i.type, status: i.status, config: i.config, devices: i.devices, profiles: i.profiles,
      expanded_config: i.config, expanded_devices: expanded(i), created_at: i.created_at, last_used_at: i.last_used_at,
      architecture: i.architecture, ephemeral: i.ephemeral, description: i.description,
    };
  }

  function newOp(work, extra = {}) {
    const id = crypto.randomUUID();
    const op = { id, status_code: 103, status: 'Running', err: '', metadata: {}, ...extra };
    ops.set(id, op);
    op.done = Promise.resolve().then(work).then(
      (meta) => { Object.assign(op, { status_code: 200, status: 'Success', metadata: meta || op.metadata }); },
      (err) => { Object.assign(op, { status_code: 400, status: 'Failure', err: err.message }); },
    );
    return op;
  }
  const asyncReply = (res, op, metadata = {}) => send(res, 202, { type: 'async', status_code: 100, operation: `/1.0/operations/${op.id}`, metadata: { id: op.id, metadata } });
  const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const ok = (res, metadata, headers) => send(res, 200, { type: 'sync', status_code: 200, metadata }, headers);
  const err = (res, code, msg) => send(res, code, { type: 'error', error_code: code, error: msg });

  // exec: ops waiting for websockets
  const execs = new Map(); // opId -> { secrets, socks, cmd, env, interactive, resolve }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://lxd');
      const p = url.pathname;
      calls.push({ method: req.method, path: p, body });
      let m;

      if (p === '/1.0') return ok(res, { api_extensions: ['instance_rebuild'], environment: { server_version: '6.0' } });
      if ((m = p.match(/^\/1\.0\/operations\/([0-9a-f-]+)\/wait$/))) {
        const op = ops.get(m[1]);
        if (!op) return err(res, 404, 'not found');
        const t = Number(url.searchParams.get('timeout') || 30) * 1000;
        // Same reply as real LXD 5.21 when the wait expires while the operation is still running
        return Promise.race([op.done.then(() => true), new Promise((r) => setTimeout(() => r(false), t))]).then((finished) => (finished
          ? ok(res, { ...op, done: undefined })
          : send(res, 200, { type: 'error', status: '', status_code: 0, operation: '', error_code: 500, error: 'context deadline exceeded' })));
      }
      if (p === '/1.0/profiles/default') return ok(res, profile);
      if (p === '/1.0/networks') return ok(res, [{ name: 'lxdbr0', type: 'bridge', managed: true, config: { 'ipv4.address': '10.10.10.1/24' } }]);
      if (p === '/1.0/networks/lxdbr0') return ok(res, { name: 'lxdbr0', managed: true, config: { 'ipv4.address': '10.10.10.1/24' } });
      if (p === '/1.0/networks/lxdbr0/leases') return ok(res, [...instances.values()].map((i) => ({ address: i.ip, hostname: i.name })));
      if (p === '/1.0/storage-pools' && url.searchParams.get('recursion')) return ok(res, [{ name: 'default', driver: 'zfs', status: 'Created' }]);
      if (p === '/1.0/storage-pools/default/resources') return ok(res, { space: { total: 400 * GiB, used: 50 * GiB } });
      if (p === '/1.0/instances' && req.method === 'GET') return ok(res, [...instances.values()].map(instanceObj));

      if (p === '/1.0/instances' && req.method === 'POST') {
        if (instances.has(body.name)) return err(res, 409, 'exists');
        const op = newOp(async () => {
          if (body.source.type === 'copy') {
            const src = instances.get(body.source.source);
            if (!src) throw new Error('source not found');
            addInstance(body.name);
            const i = instances.get(body.name);
            Object.assign(i, { config: { ...src.config }, devices: JSON.parse(JSON.stringify(src.devices)), status: 'Stopped' });
          } else {
            addInstance(body.name, { status: 'Stopped' });
            const i = instances.get(body.name);
            Object.assign(i.config, body.config);
            Object.assign(i.devices, body.devices);
          }
        });
        return asyncReply(res, op);
      }

      if ((m = p.match(/^\/1\.0\/instances\/([^/]+)(\/.*)?$/))) {
        const name = decodeURIComponent(m[1]);
        const sub = m[2] || '';
        const i = instances.get(name);
        if (!i) return err(res, 404, 'Instance not found');
        if (sub === '' && req.method === 'GET') return ok(res, instanceObj(i), { etag: `"${etag}"` });
        if (sub === '/state' && req.method === 'GET') {
          const run = i.status === 'Running';
          return ok(res, {
            status: i.status, cpu: { usage: run ? Date.now() * 1000 : 0 }, memory: { usage: run ? 512 * 1024 * 1024 : 0, total: 0 },
            disk: { root: { usage: 3 * GiB, total: 0 } }, processes: run ? 42 : 0,
            network: run ? { eth0: { addresses: [{ family: 'inet', scope: 'global', address: i.ip }], counters: { bytes_received: 1000, bytes_sent: 2000 } } } : {},
          });
        }
        if (sub === '/state' && req.method === 'PUT') {
          const op = newOp(async () => {
            const map = { start: 'Running', stop: 'Stopped', restart: 'Running', freeze: 'Frozen', unfreeze: 'Running' };
            i.status = map[body.action];
          });
          return asyncReply(res, op);
        }
        if (sub === '' && req.method === 'PUT') {
          const op = newOp(async () => {
            if (body.restore) {
              if (!i.snapshots.some((s) => s.name === body.restore)) throw new Error('snapshot not found');
              return;
            }
            if (req.headers['if-match'] && req.headers['if-match'] !== `"${etag}"`) throw new Error('ETag mismatch');
            etag += 1;
            i.config = body.config;
            i.devices = body.devices;
          });
          return asyncReply(res, op);
        }
        if (sub === '' && req.method === 'POST') {
          const op = newOp(async () => {
            if (i.status !== 'Stopped') throw new Error('Renaming of running instance not allowed');
            instances.delete(name);
            i.name = body.name;
            instances.set(body.name, i);
          });
          return asyncReply(res, op);
        }
        if (sub === '' && req.method === 'DELETE') {
          const op = newOp(async () => {
            if (i.status === 'Running') throw new Error('Instance is running');
            instances.delete(name);
          });
          return asyncReply(res, op);
        }
        if (sub === '/rebuild' && req.method === 'POST') return asyncReply(res, newOp(async () => {}));
        if (sub.startsWith('/snapshots')) {
          const snap = sub.split('/')[2];
          if (req.method === 'GET' && !snap) return ok(res, i.snapshots.map((s) => ({ name: s.name, created_at: s.created_at, stateful: false })));
          if (req.method === 'POST') {
            const op = newOp(async () => { i.snapshots.push({ name: body.name, created_at: new Date().toISOString() }); });
            return asyncReply(res, op);
          }
          if (req.method === 'DELETE') {
            const op = newOp(async () => { i.snapshots = i.snapshots.filter((s) => s.name !== decodeURIComponent(snap)); });
            return asyncReply(res, op);
          }
        }
        if (sub === '/console') { res.writeHead(200); return res.end('console boot log\n'); }
        if (sub.startsWith('/logs/')) { res.writeHead(200); return res.end('lxc log\n'); }
        if (sub === '/files') {
          const fp = url.searchParams.get('path');
          const key = `${name}:${fp}`;
          if (req.method === 'GET') {
            const f = files.get(key);
            if (!f) return err(res, 404, 'not found');
            if (f.type === 'directory') return ok(res, [], { 'x-lxd-type': 'directory', 'x-lxd-uid': String(f.uid), 'x-lxd-gid': String(f.gid) });
            res.writeHead(200, { 'x-lxd-type': 'file', 'x-lxd-uid': String(f.uid), 'x-lxd-gid': String(f.gid) });
            return res.end(f.content);
          }
          if (req.method === 'POST') {
            files.set(key, { content: raw, uid: Number(req.headers['x-lxd-uid']), gid: Number(req.headers['x-lxd-gid']), mode: req.headers['x-lxd-mode'], type: req.headers['x-lxd-type'] || 'file' });
            return ok(res, {});
          }
        }
        if (sub === '/exec' && req.method === 'POST') {
          const names = body.interactive ? ['0', 'control'] : ['0', '1', '2', 'control'];
          const secrets = Object.fromEntries(names.map((n) => [n, crypto.randomBytes(16).toString('hex')]));
          let resolveExec;
          const finished = new Promise((r) => { resolveExec = r; });
          const op = newOp(() => finished);
          execs.set(op.id, { secrets, socks: {}, cmd: body.command, env: body.environment, interactive: body.interactive, resolve: resolveExec });
          return asyncReply(res, op, { fds: secrets });
        }
      }
      return err(res, 404, `fake-lxd: no route for ${req.method} ${p}`);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://lxd');
    const m = url.pathname.match(/^\/1\.0\/operations\/([0-9a-f-]+)\/websocket$/);
    const ex = m && execs.get(m[1]);
    const fd = ex && Object.entries(ex.secrets).find(([, s]) => s === url.searchParams.get('secret'))?.[0];
    if (!fd) return socket.destroy();
    return wss.handleUpgrade(req, socket, head, (ws) => {
      ex.socks[fd] = ws;
      if (Object.keys(ex.socks).length === Object.keys(ex.secrets).length) runExec(ex);
    });
  });

  // Canned output of the container tools (containertools.js), keyed by the TOOL_OP each call sets
  function toolReply(ex) {
    const e = ex.env;
    if (e.ACCT === 'missing') return { out: '', code: 40 };
    if (e.ACCT === 'daemon') return { out: '', code: 41 };
    const dbRow = JSON.stringify({ ID: 'abc', Names: 'kc-db-shop', Image: 'postgres:17-alpine', State: 'running', Status: 'Up 1 minute', Ports: '127.0.0.1:5432->5432/tcp', Labels: 'kapil.cloud.db=shop,kapil.cloud.engine=postgres' });
    const appRow = JSON.stringify({ ID: 'def', Names: 'web', Image: 'nginx:alpine', State: 'running', Status: 'Up 2 minutes', Ports: '0.0.0.0:8080->80/tcp', Labels: '' });
    const replies = {
      accounts: '@@ACC root 0 L root /bin/bash\n@@ACC deploy 1000 P deploy,sudo /bin/bash\n@@SSHD\n@@CFG passwordauthentication no\n@@CFG permitrootlogin prohibit-password\n',
      'set-password': e.CREATE === '1' ? '@@CREATED\n' : '',
      'pm2-status': `@@JSON\n${JSON.stringify([
        { name: 'web', pm2_env: { status: 'online', exec_mode: 'cluster_mode', restart_time: 1, pm_uptime: 1 }, monit: { cpu: 2, memory: 100 } },
        { name: 'web', pm2_env: { status: 'online', exec_mode: 'cluster_mode', restart_time: 0, pm_uptime: 1 }, monit: { cpu: 3, memory: 200 } },
        { name: 'pm2-logrotate', pm2_env: { status: 'online', pmx_module: true }, monit: {} },
      ])}\n`,
      'docker-status': `@@C ${dbRow}\n@@C ${appRow}\n`,
      'db-inspect': JSON.stringify([{ Config: { Env: ['POSTGRES_USER=app', 'POSTGRES_PASSWORD=s3cret', 'POSTGRES_DB=shop'], Labels: { 'kapil.cloud.db': 'shop', 'kapil.cloud.engine': 'postgres' } }, HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5433' }] } } }]),
    };
    return { out: replies[e.TOOL_OP] ?? 'ok\n', code: 0 };
  }

  // Behaviour of the fake "container": interactive = echo shell; otherwise prints a fake deploy result
  function runExec(ex) {
    if (ex.interactive) {
      ex.socks['0'].send(Buffer.from('fake-shell$ '));
      ex.socks['0'].on('message', (d) => {
        const text = d.toString();
        if (text.includes('exit')) { ex.socks['0'].once('close', () => ex.resolve({ return: 0 })); ex.socks['0'].send(''); return; } // like LXD: empty frame, then wait for the client to hang up
        ex.socks['0'].send(Buffer.from(`echo:${text}`));
      });
      ex.socks.control.on('message', (d) => { ex.lastControl = JSON.parse(d.toString()); });
      return;
    }
    const script = ex.cmd.join(' ');
    let out = `ran ${ex.cmd[0]}\n`;
    if (script.includes('@@COMMIT')) out += `==> Cloning ${ex.env.REPO}\n@@COMMIT ${'a'.repeat(40)}\n==> Deployed\n`;
    if (ex.env.WANT_PM2 !== undefined) {
      out += '==> Updating package lists\n';
      if (ex.env.WANT_PM2 === '1') out += '@@VERSION node v22.0.0\n@@VERSION pm2 6.0.0\n';
      if (ex.env.WANT_DOCKER === '1') out += '@@VERSION docker 27.0.0\n';
      if (ex.env.WANT_CLOUDFLARED === '1') out += '@@VERSION cloudflared 2026.1.0\n';
      out += '==> Ready\n';
    }
    if (ex.env.TOOL_OP) {
      const code = toolReply(ex);
      ex.socks['1'].send(Buffer.from(code.out));
      setTimeout(() => { ex.socks['1'].close(); ex.socks['2'].close(); ex.resolve({ return: code.code }); }, 20);
      return;
    }
    if (ex.env.OP === 'status') out = '[{"name":"web","pm2_env":{"status":"online","restart_time":0},"monit":{"cpu":1,"memory":1000}}]';
    ex.socks['1'].send(Buffer.from(out));
    setTimeout(() => {
      ex.socks['1'].close();
      ex.socks['2'].close();
      ex.resolve({ return: 0 });
    }, 20);
  }

  try { fs.unlinkSync(socketPath); } catch { /* none */ }
  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    instances, files, calls, addInstance, close: () => new Promise((r) => { wss.close(); server.close(r); server.closeAllConnections?.(); }),
  })));
}
