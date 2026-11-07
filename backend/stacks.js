// Ready stack ("replica" servers): PM2 + Node, Docker, cloudflared and backup coverage set up INSIDE a container,
// so a super admin can hand out servers that are ready to run apps. Same rules as apps.js: the script is fixed text,
// values only arrive as environment variables, and nothing runs on the host.
//
// Docker needs security.nesting (+ mknod/setxattr syscall interception) on the container. That weakens isolation a
// little, so it is super-admin-only, never on privileged containers, and always audited.
import express from 'express';
import { audit, containerMeta, CONTAINER_RE } from './db.js';
import { execStream, updateInstance, changeState, createSnapshot } from './lxd.js';
import { clientIp, ownsContainer, requireSuperAdmin } from './auth.js';
import { wrap, bad, forbidden, notFound, conflict } from './http.js';

export const STACK_COMPONENTS = {
  pm2: { label: 'Node.js + PM2', note: 'PM2 starts on boot, log rotation on. Apps page deploys use it.' },
  docker: { label: 'Docker + Compose', note: 'Turns on LXD nesting for this server. Super admin only.' },
  cloudflared: { label: 'Cloudflare Tunnel (cloudflared)', note: 'Installs the connector; with a tunnel token it runs as a service.' },
};

// Config Docker needs inside an unprivileged LXD container
export const DOCKER_LXD_CONFIG = {
  'security.nesting': 'true',
  'security.syscalls.intercept.mknod': 'true',
  'security.syscalls.intercept.setxattr': 'true',
};

const STACK_SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
echo "==> Waiting for the server to finish booting"
if command -v cloud-init >/dev/null; then timeout 300 cloud-init status --wait >/dev/null 2>&1 || true; fi
i=0; until getent hosts archive.ubuntu.com >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "No internet/DNS inside the server after 60 s"; exit 30; }; sleep 1; done
echo "==> Updating package lists"
apt-get update -q
apt-get install -y -q curl ca-certificates git gnupg
if [ "$WANT_PM2" = "1" ]; then
  echo "==> Installing Node.js + PM2"
  apt-get install -y -q nodejs npm
  command -v pm2 >/dev/null || npm install -g pm2
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  systemctl enable pm2-root >/dev/null 2>&1 || true
  if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then pm2 install pm2-logrotate >/dev/null 2>&1 || echo "(pm2-logrotate could not be installed; continuing)"; fi
  pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:retain 5 >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  mkdir -p /srv/apps/.kapilcloud && chmod 700 /srv/apps/.kapilcloud
  echo "@@VERSION node $(node -v)"
  echo "@@VERSION pm2 $(pm2 -v)"
fi
if [ "$WANT_DOCKER" = "1" ]; then
  echo "==> Installing Docker"
  apt-get install -y -q docker.io
  apt-get install -y -q docker-compose-v2 >/dev/null 2>&1 || apt-get install -y -q docker-compose >/dev/null 2>&1 || echo "(Compose package not found; plain docker only)"
  mkdir -p /etc/docker
  if [ ! -s /etc/docker/daemon.json ]; then
    printf '%s\\n' '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' > /etc/docker/daemon.json
  fi
  systemctl enable docker >/dev/null 2>&1 || true
  systemctl restart docker
  docker info >/dev/null 2>&1 || { echo "Docker installed but the daemon is not running. Check: journalctl -u docker"; exit 31; }
  echo "@@VERSION docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
fi
if [ "$WANT_CLOUDFLARED" = "1" ]; then
  echo "==> Installing cloudflared"
  if ! command -v cloudflared >/dev/null; then
    ARCH=$(dpkg --print-architecture)
    curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
    dpkg -i /tmp/cloudflared.deb
    rm -f /tmp/cloudflared.deb
  fi
  if [ -n "\${CF_TUNNEL_TOKEN:-}" ]; then
    echo "==> Connecting cloudflared to the tunnel (token not shown)"
    if systemctl list-unit-files cloudflared.service >/dev/null 2>&1 && [ -f /etc/systemd/system/cloudflared.service ]; then
      cloudflared service uninstall >/dev/null 2>&1 || true
    fi
    cloudflared service install "$CF_TUNNEL_TOKEN" >/dev/null 2>&1
    systemctl enable --now cloudflared >/dev/null 2>&1 || true
    sleep 3
    systemctl is-active --quiet cloudflared || { echo "cloudflared did not start. Check the token, then: journalctl -u cloudflared"; exit 32; }
  fi
  echo "@@VERSION cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
fi
echo "==> Ready"
`;

// Cloudflare tunnel tokens are base64 JSON {"a": account, "t": tunnel id, "s": secret}
export function parseTunnelToken(token) {
  if (token == null || token === '') return null;
  const t = String(token).trim();
  if (!/^[A-Za-z0-9+/=_-]{40,4000}$/.test(t)) throw bad('That does not look like a Cloudflare tunnel token (Zero Trust → Networks → Tunnels → your tunnel → install command).');
  try {
    const j = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    if (j && typeof j.a === 'string' && typeof j.t === 'string' && typeof j.s === 'string') return { token: t, tunnelId: j.t };
  } catch { /* fall through */ }
  throw bad('That does not look like a Cloudflare tunnel token.');
}

// Validates { components: [...], tunnelToken } from a request body. Returns null when no stack was asked for.
export function parseStack(input, session) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('stack must be an object');
  const list = Array.isArray(input.components) ? [...new Set(input.components)] : null;
  if (!list || !list.length) throw bad('Pick at least one stack component');
  if (!list.every((c) => STACK_COMPONENTS[c])) throw bad(`Stack components: ${Object.keys(STACK_COMPONENTS).join(', ')}`);
  if (session?.role !== 'super_admin') throw forbidden('Only a super admin can set up a ready stack');
  const tunnel = parseTunnelToken(input.tunnelToken);
  if (tunnel && !list.includes('cloudflared')) list.push('cloudflared');
  const order = Object.keys(STACK_COMPONENTS);
  return { components: list.sort((a, b) => order.indexOf(a) - order.indexOf(b)), tunnel };
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function createStacks({ containers, backupCoverage = async () => null }) {
  const router = express.Router();

  // Installs the stack inside a running container, snapshots the result and records it. `progress` = job progress.
  async function install(name, stack, progress, by) {
    const f = containers.facts(name);
    if (!f?.limits?.memory) throw new Error(`${name} has no RAM limit. Set one (Resources) first, so Docker/PM2 cannot eat the host's memory.`);
    const env = {
      WANT_PM2: stack.components.includes('pm2') ? '1' : '0',
      WANT_DOCKER: stack.components.includes('docker') ? '1' : '0',
      WANT_CLOUDFLARED: stack.components.includes('cloudflared') ? '1' : '0',
      ...(stack.tunnel ? { CF_TUNNEL_TOKEN: stack.tunnel.token } : {}),
    };
    const record = { components: stack.components, tunnelId: stack.tunnel?.tunnelId || null, by, startedAt: Date.now(), status: 'running', versions: {} };
    containerMeta.setStack(name, { ...(containerMeta.stackOf(name) || {}), ...record });
    let last = '';
    const r = await execStream(name, ['bash', '-c', STACK_SCRIPT], {
      env, timeoutMs: 25 * 60_000,
      onOutput: (text) => {
        for (const line of text.split('\n')) if (line.startsWith('==> ')) { last = line.slice(4); progress(last); }
      },
    });
    for (const m of r.output.matchAll(/^@@VERSION (\S+) (.*)$/gm)) record.versions[m[1]] = m[2].trim();
    const tail = r.output.split('\n').filter((l) => l && !l.startsWith('@@')).slice(-15).join('\n');
    if (r.code !== 0) {
      containerMeta.setStack(name, { ...record, status: 'failed', finishedAt: Date.now(), log: tail.slice(-4000) });
      throw new Error(`Stack setup failed (exit ${r.code}) at "${last || 'start'}". Last output:\n${tail}`);
    }
    progress('Taking a snapshot of the ready server');
    const snap = `stack-ready-${stamp()}`;
    await createSnapshot(name, snap);
    const cover = await backupCoverage(name);
    const backup = cover == null ? 'unknown' : cover.included ? 'included' : 'excluded';
    containerMeta.setStack(name, { ...record, status: 'ready', finishedAt: Date.now(), snapshot: snap, backup, log: tail.slice(-4000) });
    const parts = [`Stack ready: ${stack.components.map((c) => STACK_COMPONENTS[c].label).join(', ')}`, `snapshot ${snap}`];
    parts.push(backup === 'included' ? 'included in the nightly backup' : backup === 'excluded' ? 'NOT in the nightly backup (excluded in Backups settings)' : 'backup helper not installed, so no nightly backup');
    return `${parts.join('; ')}.`;
  }

  // ---------- routes ----------
  router.get('/containers/:name/stack', wrap(async (req, res) => {
    const { name } = req.params;
    if (!ownsContainer(req.session, name)) throw forbidden('You can only access your own servers');
    if (!CONTAINER_RE.test(name) || !containers.exists(name)) throw notFound('No such server');
    const s = containerMeta.stackOf(name);
    const f = containers.facts(name) || {};
    res.set('Cache-Control', 'no-store');
    res.json({ stack: s ? { ...s, log: req.session.role === 'user' ? undefined : s.log } : null, nesting: !!f.nesting, privileged: !!f.privileged, memoryLimit: f.limits?.memory ?? null });
  }));

  // Applies the stack to an existing server. Docker changes LXD config, which needs a restart of a running server.
  router.post('/containers/:name/stack', requireSuperAdmin, wrap(async (req, res) => {
    const { name } = req.params;
    if (!CONTAINER_RE.test(name) || !containers.exists(name)) throw notFound('No such server');
    const stack = parseStack(req.body, req.session);
    if (req.body?.confirm !== name) throw bad(`Type "${name}" exactly to confirm`);
    if (containers.busy(name)) throw conflict('Another task is still running on this server');
    const f = containers.facts(name) || {};
    if (!f.limits?.memory) throw bad(`${name} has no RAM limit. Set one in Resources first.`);
    const wantDocker = stack.components.includes('docker');
    if (wantDocker && f.privileged) throw forbidden('Docker is not set up on privileged containers (nesting there would be root on the host).');
    if (containers.snapshot(name)?.status !== 'Running') throw conflict('Start the server first (the stack is installed from inside it).');
    const needsNesting = wantDocker && !f.nesting;
    const username = req.session.username;
    const ip = clientIp(req);
    const detail = `${stack.components.join(', ')}${stack.tunnel ? `, tunnel ${stack.tunnel.tunnelId}` : ''}${needsNesting ? ', nesting on (restart)' : ''}`;
    audit.log({ username, ip, action: 'server_stack', target: name, result: 'requested', detail });
    const job = containers.run(name, 'stack', username, (done) => {
      audit.log({ username, ip, action: 'server_stack', target: name, result: done.status, detail: done.status === 'success' ? detail : done.message.split('\n')[0] });
    }, async (p) => {
      if (needsNesting) {
        p('Saving the current state before changing security settings');
        await createSnapshot(name, `before-stack-${stamp()}`);
        p('Turning on nesting for Docker');
        await updateInstance(name, (next) => { Object.assign(next.config, DOCKER_LXD_CONFIG); });
        p('Restarting so nesting takes effect');
        containers.expect(name);
        await changeState(name, 'restart');
      }
      return install(name, stack, p, username);
    });
    res.status(202).json(job);
  }));

  return { router, install };
}
