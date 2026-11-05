// LoadBalancerService: Nginx upstreams for host applications, plus live traffic numbers from Nginx's own access log.
//
// Files (LB_CONF_DIR, default /etc/nginx/kapil-cloud, owned by the panel user, included from nginx's http block):
//   00-kapil-common.conf   log format, websocket map, local stub_status
//   app-<name>.conf        upstream + server for one application (listens on 127.0.0.1:<lb_port>)
// Every change: write new file -> `nginx -t` -> reload. If the test or the reload fails, the previous file is put back
// (and nginx reloaded again if needed). Nothing here listens on a public interface; Cloudflare Tunnel points at the LB port.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { hostRun } from './hostexec.js';
import { HttpError } from './http.js';

const CONF_DIR = () => process.env.LB_CONF_DIR || '/etc/nginx/kapil-cloud';
const LOG_DIR = () => process.env.LB_LOG_DIR || '/var/log/nginx/kapil-cloud';
const STATUS_PORT = () => Number(process.env.LB_STATUS_PORT) || 18089;
const BUCKET_MS = 10_000;
const KEEP_BUCKETS = 360; // 1 hour

export const HEADER = '# Managed by Kapil Cloud. Do not edit: changes are overwritten. Edit the app in the panel instead.';

export function renderCommon() {
  return `${HEADER}
log_format kc_lb '$msec $status $request_time "$upstream_addr"';
map $http_upgrade $kc_connection_upgrade { default upgrade; '' ''; }
server {
    listen 127.0.0.1:${STATUS_PORT()};
    server_name kapil-cloud-status;
    access_log off;
    location = /kc_status { stub_status; allow 127.0.0.1; deny all; }
}
`;
}

// servers: [{ port, weight, state: 'active' | 'backup' | 'down' }]
export function renderApp(app, servers) {
  const name = `kc_${app.name.replace(/-/g, '_')}`;
  const lines = servers.map((s) => {
    const flags = s.state === 'down' ? ' down' : s.state === 'backup' ? ' backup' : '';
    return `    server 127.0.0.1:${s.port} weight=${Math.max(1, s.weight)} max_fails=2 fail_timeout=10s${flags};`;
  });
  return `${HEADER}
# app: ${app.name} (${app.runtime})
upstream ${name} {
${app.lb_method === 'least_conn' ? '    least_conn;\n' : ''}${lines.join('\n')}
    keepalive 16;
}
server {
    listen 127.0.0.1:${app.lb_port};
    server_name ${app.server_name || '_'};
    access_log ${LOG_DIR()}/${app.name}.access.log kc_lb;
    client_max_body_size 50m;
    location / {
        proxy_pass http://${name};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $kc_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_connect_timeout 3s;
        proxy_read_timeout 120s;
        proxy_next_upstream error timeout http_502 http_503 http_504;
        proxy_next_upstream_tries 3;
    }
}
`;
}

const short = (r) => (r.error || r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' ').slice(0, 500);
const fileFor = (appName) => path.join(CONF_DIR(), `app-${appName}.conf`);

export function createLoadBalancer() {
  // Nginx changes are queued, one at a time: a health-check failover and a user's traffic switch arriving together
  // must both apply (in order), not fail each other with "busy"
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const traffic = new Map(); // appName -> { offset, buckets: Map(t -> bucket) }

  function status() {
    const dir = CONF_DIR();
    let writable = false;
    try { fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch { /* not set up */ }
    return { confDir: dir, logDir: LOG_DIR(), writable, statusPort: STATUS_PORT() };
  }

  async function nginxVersion() {
    const r = await hostRun('nginxVersion', [], { timeout: 5000 });
    const m = `${r.stdout}${r.stderr}`.match(/nginx\/([\d.]+)/);
    return m ? m[1] : null;
  }

  // Replace a set of files atomically from nginx's point of view: write all, test, reload; on failure restore all.
  async function applyFiles(changes) {
    return serial(async () => {
      const dir = CONF_DIR();
      if (!status().writable) throw new HttpError(503, `Load balancer is not set up: ${dir} is missing or not writable. Run system/install-lb.sh on the server (see docs/HOST_APPS.md).`);
      fs.mkdirSync(LOG_DIR(), { recursive: true });
      const previous = new Map();
      let changed = false;
      for (const [file, content] of changes) {
        const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        previous.set(file, old);
        if (old !== content) changed = true;
      }
      if (!changed) return { changed: false };
      const write = (file, content) => {
        if (content == null) { fs.rmSync(file, { force: true }); return; }
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, content, { mode: 0o644 });
        fs.renameSync(tmp, file);
      };
      const restore = () => { for (const [file, old] of previous) write(file, old); };
      for (const [file, content] of changes) write(file, content);

      const test = await hostRun('nginxTest', [], { timeout: 20_000 });
      if (!test.ok) {
        restore();
        throw new HttpError(422, `Nginx rejected the new configuration, nothing was changed: ${short(test)}`);
      }
      const reload = await hostRun('nginxReload', [], { timeout: 30_000 });
      if (!reload.ok) {
        restore();
        const again = await hostRun('nginxReload', [], { timeout: 30_000 });
        throw new HttpError(502, `Nginx reload failed (${short(reload)}). The previous configuration was restored${again.ok ? ' and reloaded' : ', but reloading it failed too: check nginx on the server'}.`);
      }
      const hash = crypto.createHash('sha256').update(changes.map(([f, c]) => `${f}\n${c}`).join('\n')).digest('hex').slice(0, 12);
      return { changed: true, hash };
    });
  }

  const apply = (app, servers) => applyFiles([
    [path.join(CONF_DIR(), '00-kapil-common.conf'), renderCommon()],
    [fileFor(app.name), renderApp(app, servers)],
  ]);
  const remove = (appName) => applyFiles([[fileFor(appName), null]]);
  const current = (appName) => { try { return fs.readFileSync(fileFor(appName), 'utf8'); } catch { return null; } };

  // ---------- traffic from the access log: "$msec $status $request_time \"$upstream_addr\"" ----------
  function readTraffic(appName) {
    const file = path.join(LOG_DIR(), `${appName}.access.log`);
    let t = traffic.get(appName);
    let size;
    try { size = fs.statSync(file).size; } catch {
      if (!t) { t = { offset: 0, buckets: new Map() }; traffic.set(appName, t); } // no log yet: read it from the start once it appears
      return t;
    }
    if (!t) { t = { offset: size, buckets: new Map() }; traffic.set(appName, t); return t; } // start from now
    if (size < t.offset) t.offset = 0; // rotated
    if (size === t.offset) return t;
    const len = Math.min(size - t.offset, 8 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, t.offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return t;
    t.offset += Buffer.byteLength(text.slice(0, end + 1));
    for (const line of text.slice(0, end).split('\n')) {
      const m = line.match(/^(\d+)(?:\.\d+)? (\d{3}) ([\d.]+) "([^"]*)"/);
      if (!m) continue;
      const ts = Number(m[1]) * 1000;
      const key = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
      const b = t.buckets.get(key) || { t: key, n: 0, s2: 0, s3: 0, s4: 0, s5: 0, ms: 0, times: [], by: {} };
      b.n += 1;
      b[`s${m[2][0]}`] = (b[`s${m[2][0]}`] || 0) + 1;
      const ms = Math.round(Number(m[3]) * 1000);
      b.ms += ms;
      if (b.times.length < 2000) b.times.push(ms);
      const up = m[4].split(',').pop().trim().split(':').pop();
      if (/^\d+$/.test(up)) b.by[up] = (b.by[up] || 0) + 1;
      t.buckets.set(key, b);
    }
    const oldest = Date.now() - KEEP_BUCKETS * BUCKET_MS;
    for (const k of t.buckets.keys()) if (k < oldest) t.buckets.delete(k);
    return t;
  }

  function trafficSummary(appName, minutes = 60) {
    const t = readTraffic(appName);
    const since = Date.now() - minutes * 60_000;
    const buckets = t ? [...t.buckets.values()].filter((b) => b.t >= since).sort((a, b) => a.t - b.t) : [];
    const series = buckets.map((b) => {
      const sorted = [...b.times].sort((x, y) => x - y);
      return {
        t: b.t, rps: Math.round((b.n / (BUCKET_MS / 1000)) * 100) / 100, s2xx: b.s2, s3xx: b.s3, s4xx: b.s4, s5xx: b.s5,
        avgMs: b.n ? Math.round(b.ms / b.n) : 0, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
      };
    });
    const recent = buckets.filter((b) => b.t >= Date.now() - 5 * 60_000);
    const by = {};
    const codes = { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
    let n = 0;
    let ms = 0;
    for (const b of recent) {
      n += b.n; ms += b.ms;
      codes.s2xx += b.s2; codes.s3xx += b.s3; codes.s4xx += b.s4; codes.s5xx += b.s5;
      for (const [p, c] of Object.entries(b.by)) by[p] = (by[p] || 0) + c;
    }
    return { series, last5m: { requests: n, rps: Math.round((n / 300) * 100) / 100, avgMs: n ? Math.round(ms / n) : 0, codes, byPort: by }, logging: !!t };
  }

  // Global active connections from stub_status (Nginx does not count them per upstream)
  function activeConnections() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: STATUS_PORT(), path: '/kc_status', timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const m = body.match(/Active connections:\s*(\d+)/);
          const r = body.match(/\n\s*(\d+)\s+(\d+)\s+(\d+)\s*\n/);
          resolve(m ? { active: Number(m[1]), totalRequests: r ? Number(r[3]) : null } : null);
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
  }

  return { status, nginxVersion, apply, remove, current, trafficSummary, readTraffic, activeConnections };
}
