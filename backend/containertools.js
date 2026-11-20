// Self-service tools for ONE container, open to its owner: login accounts and passwords, SSH password login, and
// managers for PM2, Docker and databases. Everything runs INSIDE the container through LXD exec, never on the host.
// Owners already have a root shell there through the terminal, so none of this gives them more than they have.
// Same rules as apps.js: scripts are fixed text and user values only ever arrive as environment variables.
//
// Turning Docker on changes the container's LXD security settings, so that stays super-admin-only (stacks.js).
import crypto from 'node:crypto';
import express from 'express';
import { audit } from './db.js';
import { execStream } from './lxd.js';
import { clientIp, isAdmin, ownsContainer } from './auth.js';
import { wrap, bad, forbidden, notFound, conflict, int } from './http.js';
import { passwordProblem } from './users.js';
import { RUNTIME_SCRIPT } from './apps.js';
import { ENGINES } from './databases.js';

const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PROC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/i;
const PORT_MAP_RE = /^(?:\d{1,5}:)?\d{1,5}(?:\/(?:tcp|udp))?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const DB_RE = /^[a-z][a-z0-9-]{0,30}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SSH_CONF = '/etc/ssh/sshd_config.d/10-kapilcloud-password.conf';
const DB_PREFIX = 'kc-db-';
const DB_LABEL = 'kapil.cloud.db';
const TASK_LOG_KEEP = 20_000;

// ---------- scripts that run inside the container ----------
const ACCOUNTS_SCRIPT = `getent passwd | awk -F: '$3==0 || ($3>=1000 && $3<60000) {print $1":"$3":"$7}' | while IFS=: read -r u uid sh; do
  st=$(passwd -S "$u" 2>/dev/null | awk '{print $2}')
  groups=$(id -nG "$u" 2>/dev/null | tr ' ' ',')
  echo "@@ACC $u $uid \${st:-unknown} \${groups:-none} $sh"
done
if command -v sshd >/dev/null 2>&1; then
  echo "@@SSHD"
  mkdir -p /run/sshd
  sshd -T 2>/dev/null | awk '/^passwordauthentication |^permitrootlogin /{print "@@CFG",$1,$2}'
fi
exit 0
`;

const SET_PASSWORD_SCRIPT = `set -eu
if ! id -- "$ACCT" >/dev/null 2>&1; then
  [ "$CREATE" = "1" ] || exit 40
  useradd -m -s /bin/bash -- "$ACCT"
  echo "@@CREATED"
fi
uid=$(id -u -- "$ACCT")
if [ "$uid" -ne 0 ] && [ "$uid" -lt 1000 ]; then exit 41; fi
if [ "$SUDO" = "1" ] && [ "$uid" -ne 0 ]; then usermod -aG sudo -- "$ACCT"; fi
printf '%s:%s\\n' "$ACCT" "$NEW_PASSWORD" | chpasswd
if [ "$MUST_CHANGE" = "1" ]; then chage -d 0 -- "$ACCT"; fi
`;

const LOCK_SCRIPT = `set -eu
id -- "$ACCT" >/dev/null 2>&1 || exit 40
uid=$(id -u -- "$ACCT")
if [ "$uid" -ne 0 ] && [ "$uid" -lt 1000 ]; then exit 41; fi
if [ "$LOCK" = "1" ]; then usermod -L -- "$ACCT"; else usermod -U -- "$ACCT"; fi
`;

// The file sorts before the image's 60-cloudimg-settings.conf, and sshd keeps the FIRST value it reads
const SSH_PASSWORD_SCRIPT = `set -eu
command -v sshd >/dev/null 2>&1 || exit 42
if [ "$ENABLE" = "1" ]; then
  mkdir -p /etc/ssh/sshd_config.d
  { echo "PasswordAuthentication yes"; if [ "$ROOT_LOGIN" = "1" ]; then echo "PermitRootLogin yes"; else echo "PermitRootLogin prohibit-password"; fi; } > "${SSH_CONF}"
  chmod 644 "${SSH_CONF}"
else
  rm -f "${SSH_CONF}"
fi
mkdir -p /run/sshd
if ! sshd -t; then rm -f "${SSH_CONF}"; exit 43; fi
systemctl try-reload-or-restart ssh 2>/dev/null || service ssh reload 2>/dev/null || true
`;

const PM2_STATUS_SCRIPT = `command -v pm2 >/dev/null 2>&1 || { echo "@@MISSING"; exit 0; }
echo "@@JSON"
pm2 jlist 2>/dev/null
exit 0
`;

const PM2_OP_SCRIPT = `set -eu
case "$P_OP" in
  start|stop|restart|reload|delete) pm2 "$P_OP" "$P_NAME" ;;
  scale) pm2 scale "$P_NAME" "$P_COUNT" ;;
  *) exit 2 ;;
esac
pm2 save --force >/dev/null 2>&1 || true
`;

const PM2_START_SCRIPT = `set -euf
[ -d "$P_CWD" ] || { echo "Folder not found: $P_CWD"; exit 44; }
cd "$P_CWD"
if [ -n "\${P_PORT:-}" ]; then export PORT="$P_PORT"; fi
set -- start "$P_SCRIPT" --name "$P_NAME"
if [ "$P_INSTANCES" -gt 1 ]; then set -- "$@" -i "$P_INSTANCES"; fi
if [ -n "\${P_ARGS:-}" ]; then set -- "$@" -- $P_ARGS; fi
pm2 "$@"
pm2 save --force >/dev/null 2>&1 || true
`;

const DOCKER_STATUS_SCRIPT = `command -v docker >/dev/null 2>&1 || { echo "@@MISSING"; exit 0; }
docker info >/dev/null 2>&1 || { echo "@@DOWN"; exit 0; }
docker ps -a --no-trunc --format '@@C {{json .}}'
exit 0
`;

const DOCKER_OP_SCRIPT = `set -eu
case "$D_OP" in
  start|stop|restart) docker "$D_OP" "$D_NAME" ;;
  remove) docker rm -f "$D_NAME" ;;
  *) exit 2 ;;
esac
`;

const DOCKER_RUN_SCRIPT = `set -euf
echo "==> Pulling $D_IMAGE"
docker pull -q "$D_IMAGE"
set -- -d --name "$D_NAME" --restart "$D_RESTART"
for p in \${D_PORTS:-}; do set -- "$@" -p "$p"; done
for k in \${D_ENV_KEYS:-}; do set -- "$@" -e "$k"; done
echo "==> Starting $D_NAME"
docker run "$@" "$D_IMAGE"
echo "==> Started"
`;

const DB_CREATE_SCRIPT = `set -euf
P="$DB_BASE_PORT"
while ss -ltn | awk '{print $4}' | grep -q ":$P\\$"; do P=$((P+1)); done
echo "==> Pulling $DB_IMAGE"
docker pull -q "$DB_IMAGE"
docker volume create --label "${DB_LABEL}=$DB_NAME" "$DB_VOLUME" >/dev/null
set --
for k in $DB_ENV_KEYS; do set -- "$@" -e "$k"; done
echo "==> Starting on 127.0.0.1:$P"
docker run -d --name "$DB_CONTAINER" --restart unless-stopped --label "${DB_LABEL}=$DB_NAME" --label "kapil.cloud.engine=$DB_ENGINE" \\
  -p "127.0.0.1:$P:$DB_PORT" -v "$DB_VOLUME:$DB_MOUNT" "$@" "$DB_IMAGE"
echo "==> Ready"
`;

const DB_REMOVE_SCRIPT = `set -eu
docker rm -f "$DB_CONTAINER" >/dev/null
if [ "$DELETE_DATA" = "1" ]; then docker volume rm "$DB_VOLUME" >/dev/null; fi
`;

// ---------- helpers ----------
const labelsOf = (s) => Object.fromEntries(String(s || '').split(',').filter(Boolean).map((kv) => {
  const i = kv.indexOf('=');
  return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
}));

const dockerRows = (output) => output.split('\n').filter((l) => l.startsWith('@@C ')).flatMap((l) => {
  try {
    const c = JSON.parse(l.slice(4));
    return [{ id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, labels: labelsOf(c.Labels) }];
  } catch { return []; }
});

function parsePm2(output) {
  const at = output.indexOf('@@JSON');
  const rest = at < 0 ? output : output.slice(at + 6);
  let list = [];
  try { list = JSON.parse(rest.slice(rest.indexOf('['))); } catch { list = []; }
  const byName = new Map();
  for (const p of list) {
    if (p.pm2_env?.pmx_module) continue; // pm2-logrotate and friends are not the user's apps
    const g = byName.get(p.name) || { name: p.name, status: p.pm2_env?.status, mode: p.pm2_env?.exec_mode === 'cluster_mode' ? 'cluster' : 'fork', instances: 0, cpu: 0, memory: 0, restarts: 0, uptime: p.pm2_env?.pm_uptime ?? null, cwd: p.pm2_env?.pm_cwd || null };
    g.instances += 1;
    g.cpu += p.monit?.cpu ?? 0;
    g.memory += p.monit?.memory ?? 0;
    g.restarts += p.pm2_env?.restart_time ?? 0;
    if (p.pm2_env?.status !== 'online') g.status = p.pm2_env?.status;
    byName.set(p.name, g);
  }
  return [...byName.values()];
}

const parseEnvText = (text) => {
  const out = {};
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const i = line.indexOf('=');
    if (i < 1 || !ENV_KEY_RE.test(line.slice(0, i))) throw bad(`Environment line must look like KEY=value: ${line.slice(0, 40)}`);
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
};

export function createContainerTools({ containers }) {
  const router = express.Router();
  const tasks = new Map(); // server -> latest long-running task (install, image pull, database create)

  const log = (req, action, target, result = 'success', detail = null) => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });

  function target(req) {
    const name = req.params.name;
    if (!ownsContainer(req.session, name)) throw forbidden('You can only manage your own servers');
    if (!containers.exists(name)) throw notFound('No such server');
    if (!isAdmin(req.session) && containers.facts(name)?.privileged) throw forbidden('This server runs privileged, so these tools are disabled for it. Ask the admin.');
    if (containers.snapshot(name)?.status !== 'Running') throw conflict('Start the server first');
    return name;
  }

  const run = (name, op, script, env = {}, timeoutMs = 60_000) => execStream(name, ['bash', '-c', script], { env: { TOOL_OP: op, ...env }, timeoutMs });

  function must(r, what, known = {}) {
    if (r.code === 0) return r;
    if (known[r.code]) throw bad(known[r.code]);
    const tail = r.output.replace(/@@\S+/g, '').trim().slice(-400);
    throw bad(`${what} failed${tail ? `: ${tail}` : ` (exit code ${r.code})`}`);
  }

  const account = (v) => {
    if (typeof v !== 'string' || !ACCOUNT_RE.test(v)) throw bad('Account name: lowercase letters, digits, - or _, starting with a letter or _');
    return v;
  };
  const matching = (v, re, name) => {
    if (typeof v !== 'string' || !re.test(v)) throw bad(`Invalid ${name}`);
    return v;
  };

  function taskView(name) {
    const t = tasks.get(name);
    return t ? { kind: t.kind, label: t.label, status: t.status, log: t.log, startedAt: t.startedAt, finishedAt: t.finishedAt } : null;
  }

  // Installs and image pulls can outlast any HTTP request: answer 202 and let the page poll the task.
  function startTask(req, name, kind, label, script, env, timeoutMs = 20 * 60_000) {
    if (tasks.get(name)?.status === 'running') throw conflict(`${tasks.get(name).label} is still running on this server`);
    const t = { kind, label, status: 'running', log: '', startedAt: Date.now(), finishedAt: null };
    tasks.set(name, t);
    log(req, `tools_${kind}`, name, 'requested', label);
    const username = req.session.username;
    const ip = clientIp(req);
    execStream(name, ['bash', '-c', script], {
      env: { TOOL_OP: kind, ...env }, timeoutMs, onOutput: (x) => { t.log = (t.log + x).slice(-TASK_LOG_KEEP); },
    }).then((r) => r.code, (err) => { t.log += `\n${err.message}\n`; return -1; }).then((code) => {
      t.status = code === 0 ? 'success' : 'failed';
      t.finishedAt = Date.now();
      audit.log({ username, ip, action: `tools_${kind}`, target: name, result: code === 0 ? 'success' : 'failure', detail: code === 0 ? label : `${label}: exit code ${code}` });
    });
    return t;
  }

  async function dockerState(name) {
    const r = await run(name, 'docker-status', DOCKER_STATUS_SCRIPT, {}, 30_000);
    const state = r.output.includes('@@MISSING') ? 'missing' : r.output.includes('@@DOWN') ? 'stopped' : 'ready';
    return { state, rows: dockerRows(r.output) };
  }
  async function needDocker(name) {
    const { state } = await dockerState(name);
    if (state === 'missing') throw conflict('Docker is not enabled on this server. A super admin can turn it on from the server\'s Stack tab.');
    if (state === 'stopped') throw conflict('Docker is installed but not running on this server.');
  }

  // ---------- accounts and passwords ----------
  router.get('/servers/:name/access', wrap(async (req, res) => {
    const name = target(req);
    const r = await run(name, 'accounts', ACCOUNTS_SCRIPT, {}, 30_000);
    must(r, 'Reading the accounts');
    const accounts = [];
    const cfg = {};
    for (const line of r.output.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p[0] === '@@ACC') accounts.push({ name: p[1], uid: Number(p[2]), status: { P: 'password', NP: 'no-password', L: 'locked' }[p[3]] || 'unknown', sudo: p[2] === '0' || (p[4] || '').split(',').includes('sudo'), shell: p[5] || '' });
      if (p[0] === '@@CFG') cfg[p[1]] = p[2];
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      accounts,
      ssh: {
        installed: r.output.includes('@@SSHD'),
        passwordLogin: cfg.passwordauthentication === 'yes',
        rootPasswordLogin: cfg.passwordauthentication === 'yes' && cfg.permitrootlogin === 'yes',
      },
    });
  }));

  router.post('/servers/:name/access/password', wrap(async (req, res) => {
    const name = target(req);
    const b = req.body ?? {};
    const acct = account(b.account);
    const generated = b.generate === true;
    const password = generated ? crypto.randomBytes(18).toString('base64url') : b.password;
    if (!generated) {
      const problem = passwordProblem(password);
      if (problem) throw bad(problem);
      if (CONTROL_RE.test(password)) throw bad('Password cannot contain line breaks or control characters');
    }
    const r = await run(name, 'set-password', SET_PASSWORD_SCRIPT, {
      ACCT: acct, NEW_PASSWORD: password, CREATE: b.create === true ? '1' : '0', SUDO: b.sudo === true ? '1' : '0', MUST_CHANGE: b.mustChange === true ? '1' : '0',
    });
    if (r.code !== 0) log(req, 'server_password_change', `${name}/${acct}`, 'failure', `exit code ${r.code}`);
    must({ ...r, output: r.output.split(password).join('***') }, 'Changing the password', {
      40: `There is no account named ${acct} on this server`,
      41: `${acct} is a system account; its password cannot be changed here`,
    });
    const created = r.output.includes('@@CREATED');
    log(req, 'server_password_change', `${name}/${acct}`, 'success', [created && 'created', b.sudo === true && 'sudo', generated && 'generated', b.mustChange === true && 'must change'].filter(Boolean).join(', ') || null);
    res.set('Cache-Control', 'no-store');
    res.json({ account: acct, created, password: generated ? password : undefined });
  }));

  router.post('/servers/:name/access/lock', wrap(async (req, res) => {
    const name = target(req);
    const acct = account(req.body?.account);
    const lock = req.body?.locked === true;
    must(await run(name, 'lock-account', LOCK_SCRIPT, { ACCT: acct, LOCK: lock ? '1' : '0' }), lock ? 'Locking the account' : 'Unlocking the account', {
      40: `There is no account named ${acct} on this server`,
      41: `${acct} is a system account and cannot be changed here`,
    });
    log(req, lock ? 'server_account_lock' : 'server_account_unlock', `${name}/${acct}`);
    res.json({ ok: true });
  }));

  router.put('/servers/:name/access/ssh', wrap(async (req, res) => {
    const name = target(req);
    const enable = req.body?.passwordLogin === true;
    const root = enable && req.body?.rootLogin === true;
    must(await run(name, 'ssh-password', SSH_PASSWORD_SCRIPT, { ENABLE: enable ? '1' : '0', ROOT_LOGIN: root ? '1' : '0' }), 'Changing the SSH settings', {
      42: 'No SSH server is installed in this server',
      43: 'The SSH configuration was rejected, so nothing was changed',
    });
    log(req, 'server_ssh_password', name, 'success', enable ? `enabled${root ? ', root allowed' : ''}` : 'disabled');
    res.json({ ok: true });
  }));

  // ---------- PM2 ----------
  router.get('/servers/:name/tools/pm2', wrap(async (req, res) => {
    const name = target(req);
    const r = await run(name, 'pm2-status', PM2_STATUS_SCRIPT, {}, 30_000);
    res.set('Cache-Control', 'no-store');
    res.json({ installed: !r.output.includes('@@MISSING'), processes: parsePm2(r.output), task: taskView(name) });
  }));

  router.post('/servers/:name/tools/pm2/install', wrap(async (req, res) => {
    const name = target(req);
    startTask(req, name, 'install-pm2', 'Installing Node.js and PM2', RUNTIME_SCRIPT, { RUNTIMES: 'node' });
    res.status(202).json({ task: taskView(name) });
  }));

  router.post('/servers/:name/tools/pm2', wrap(async (req, res) => {
    const name = target(req);
    const b = req.body ?? {};
    const proc = matching(b.name, PROC_RE, 'process name');
    if (typeof b.cwd !== 'string' || !b.cwd.startsWith('/') || CONTROL_RE.test(b.cwd) || b.cwd.length > 300) throw bad('App folder must be an absolute path');
    if (typeof b.script !== 'string' || !b.script.trim() || CONTROL_RE.test(b.script) || b.script.length > 300) throw bad('Enter the script to run');
    if (b.args != null && (typeof b.args !== 'string' || CONTROL_RE.test(b.args) || b.args.length > 500)) throw bad('Invalid arguments');
    const instances = b.instances == null || b.instances === '' ? 1 : int(b.instances, { min: 1, max: 16, name: 'Instances' });
    const port = b.port == null || b.port === '' ? '' : String(int(b.port, { min: 1, max: 65535, name: 'Port' }));
    must(await run(name, 'pm2-start', PM2_START_SCRIPT, { P_NAME: proc, P_CWD: b.cwd, P_SCRIPT: b.script, P_ARGS: b.args || '', P_INSTANCES: String(instances), P_PORT: port }, 120_000), 'Starting the process', { 44: `Folder not found: ${b.cwd}` });
    log(req, 'tools_pm2_start', `${name}/${proc}`);
    res.status(201).json({ ok: true });
  }));

  router.get('/servers/:name/tools/pm2/:proc/logs', wrap(async (req, res) => {
    const name = target(req);
    const proc = matching(req.params.proc, PROC_RE, 'process name');
    const r = await execStream(name, ['pm2', 'logs', proc, '--nostream', '--raw', '--lines', '200'], { env: { TOOL_OP: 'pm2-logs' }, timeoutMs: 30_000 });
    res.set('Cache-Control', 'no-store');
    res.json({ logs: r.output });
  }));

  router.post('/servers/:name/tools/pm2/:proc/:op', wrap(async (req, res) => {
    const name = target(req);
    const proc = matching(req.params.proc, PROC_RE, 'process name');
    const op = req.params.op;
    if (!['start', 'stop', 'restart', 'reload', 'delete', 'scale'].includes(op)) throw bad('Unknown action');
    const count = op === 'scale' ? String(int(req.body?.instances, { min: 1, max: 16, name: 'Instances' })) : '';
    must(await run(name, 'pm2-op', PM2_OP_SCRIPT, { P_OP: op, P_NAME: proc, P_COUNT: count }, 120_000), `PM2 ${op}`);
    log(req, `tools_pm2_${op}`, `${name}/${proc}`, 'success', count || null);
    res.json({ ok: true });
  }));

  // ---------- Docker ----------
  router.get('/servers/:name/tools/docker', wrap(async (req, res) => {
    const name = target(req);
    const { state, rows } = await dockerState(name);
    res.set('Cache-Control', 'no-store');
    res.json({ state, containers: rows.map(({ labels, ...c }) => ({ ...c, database: labels[DB_LABEL] || null })), task: taskView(name) });
  }));

  router.post('/servers/:name/tools/docker', wrap(async (req, res) => {
    const name = target(req);
    const b = req.body ?? {};
    const image = matching(b.image, IMAGE_RE, 'image');
    const cname = matching(b.name, DOCKER_NAME_RE, 'container name');
    const ports = String(b.ports || '').split(/[\s,]+/).filter(Boolean);
    for (const p of ports) if (!PORT_MAP_RE.test(p)) throw bad(`Port mapping must look like 8080:80 (got ${p.slice(0, 20)})`);
    const restart = b.restart == null ? 'unless-stopped' : b.restart;
    if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(restart)) throw bad('Invalid restart policy');
    const envs = parseEnvText(b.env);
    await needDocker(name);
    startTask(req, name, 'docker-run', `Starting ${cname} from ${image}`, DOCKER_RUN_SCRIPT, {
      ...envs, D_IMAGE: image, D_NAME: cname, D_RESTART: restart, D_PORTS: ports.join(' '), D_ENV_KEYS: Object.keys(envs).join(' '),
    });
    res.status(202).json({ task: taskView(name) });
  }));

  router.get('/servers/:name/tools/docker/:c/logs', wrap(async (req, res) => {
    const name = target(req);
    const c = matching(req.params.c, DOCKER_NAME_RE, 'container name');
    const r = await execStream(name, ['docker', 'logs', '--tail', '300', c], { env: { TOOL_OP: 'docker-logs' }, timeoutMs: 30_000 });
    res.set('Cache-Control', 'no-store');
    res.json({ logs: r.output });
  }));

  router.post('/servers/:name/tools/docker/:c/:op', wrap(async (req, res) => {
    const name = target(req);
    const c = matching(req.params.c, DOCKER_NAME_RE, 'container name');
    const op = req.params.op;
    if (!['start', 'stop', 'restart', 'remove'].includes(op)) throw bad('Unknown action');
    must(await run(name, 'docker-op', DOCKER_OP_SCRIPT, { D_OP: op, D_NAME: c }, 120_000), `Docker ${op}`);
    log(req, `tools_docker_${op}`, `${name}/${c}`);
    res.json({ ok: true });
  }));

  // ---------- databases (Docker inside the container, reachable from that container only) ----------
  router.get('/servers/:name/tools/databases', wrap(async (req, res) => {
    const name = target(req);
    const { state, rows } = await dockerState(name);
    res.set('Cache-Control', 'no-store');
    res.json({
      state,
      engines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label, versions: Object.keys(e.versions) })),
      databases: rows.filter((c) => c.labels[DB_LABEL]).map((c) => ({
        name: c.labels[DB_LABEL], engine: c.labels['kapil.cloud.engine'], engineLabel: ENGINES[c.labels['kapil.cloud.engine']]?.label || c.labels['kapil.cloud.engine'],
        image: c.image, state: c.state, status: c.status, port: Number(/127\.0\.0\.1:(\d+)->/.exec(c.ports || '')?.[1]) || null,
      })),
      task: taskView(name),
    });
  }));

  router.post('/servers/:name/tools/databases', wrap(async (req, res) => {
    const name = target(req);
    const b = req.body ?? {};
    const db = matching(b.name, DB_RE, 'database name (lowercase letters, digits and dashes)');
    const e = ENGINES[b.engine];
    if (!e) throw bad('Pick an engine');
    const image = e.versions[b.version];
    if (!image) throw bad('Pick a version');
    await needDocker(name);
    const secrets = { user: 'app', dbName: db.replace(/-/g, '_'), password: crypto.randomBytes(18).toString('base64url'), rootPassword: crypto.randomBytes(18).toString('base64url') };
    const envs = e.env(secrets);
    startTask(req, name, 'database-create', `Creating database ${db}`, DB_CREATE_SCRIPT, {
      ...envs, DB_NAME: db, DB_ENGINE: b.engine, DB_IMAGE: image, DB_CONTAINER: `${DB_PREFIX}${db}`, DB_VOLUME: `${DB_PREFIX}${db}-data`,
      DB_PORT: String(e.port), DB_BASE_PORT: String(e.port), DB_MOUNT: e.mount, DB_ENV_KEYS: Object.keys(envs).join(' '),
    });
    res.status(202).json({ task: taskView(name) });
  }));

  router.get('/servers/:name/tools/databases/:db/credentials', wrap(async (req, res) => {
    const name = target(req);
    const db = matching(req.params.db, DB_RE, 'database name');
    const r = await execStream(name, ['docker', 'inspect', `${DB_PREFIX}${db}`], { env: { TOOL_OP: 'db-inspect' }, timeoutMs: 30_000 });
    must(r, 'Reading the credentials');
    let info;
    try { [info] = JSON.parse(r.output.slice(r.output.indexOf('['))); } catch { throw bad('Could not read the credentials'); }
    const env = Object.fromEntries((info?.Config?.Env || []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    const engine = info?.Config?.Labels?.['kapil.cloud.engine'];
    const e = ENGINES[engine];
    if (!e || info?.Config?.Labels?.[DB_LABEL] !== db) throw notFound('No such database');
    const port = Number(info?.HostConfig?.PortBindings?.[`${e.port}/tcp`]?.[0]?.HostPort) || e.port;
    const d = {
      host: '127.0.0.1', port,
      user: env.POSTGRES_USER || env.MYSQL_USER || env.MONGO_INITDB_ROOT_USERNAME,
      password: env.POSTGRES_PASSWORD || env.MYSQL_PASSWORD || env.MONGO_INITDB_ROOT_PASSWORD,
      dbName: env.POSTGRES_DB || env.MYSQL_DATABASE || env.MONGO_INITDB_DATABASE,
    };
    log(req, 'tools_database_credentials', `${name}/${db}`);
    res.set('Cache-Control', 'no-store');
    res.json({ ...d, url: e.url(d) });
  }));

  router.post('/servers/:name/tools/databases/:db/:op', wrap(async (req, res) => {
    const name = target(req);
    const db = matching(req.params.db, DB_RE, 'database name');
    const op = req.params.op;
    const container = `${DB_PREFIX}${db}`;
    if (op === 'remove') {
      const deleteData = req.body?.deleteData === true;
      must(await run(name, 'db-remove', DB_REMOVE_SCRIPT, { DB_CONTAINER: container, DB_VOLUME: `${container}-data`, DELETE_DATA: deleteData ? '1' : '0' }, 120_000), 'Removing the database');
      log(req, 'tools_database_remove', `${name}/${db}`, 'success', deleteData ? 'data deleted' : 'data kept');
      return res.json({ ok: true });
    }
    if (!['start', 'stop', 'restart'].includes(op)) throw bad('Unknown action');
    must(await run(name, 'docker-op', DOCKER_OP_SCRIPT, { D_OP: op, D_NAME: container }, 120_000), `Database ${op}`);
    log(req, `tools_database_${op}`, `${name}/${db}`);
    return res.json({ ok: true });
  }));

  return { router };
}
