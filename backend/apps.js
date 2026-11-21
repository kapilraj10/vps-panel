// Applications: git deploys run INSIDE the owner's container through LXD exec, managed by PM2 there.
// The scripts below are fixed text; user values reach them only as environment variables, never spliced in.
// User build/start commands run as root inside the user's own container, which they already control fully
// through the terminal, so nothing here gives them more than they have. On the host the panel only adds the LXD proxy
// device that forwards 127.0.0.1:<port> to the app (portforward.js) and checks that the port answers.
import express from 'express';
import { execFile } from 'node:child_process';
import { db, audit, users } from './db.js';
import { execStream } from './lxd.js';
import { seal, open } from './secrets.js';
import { clientIp, isAdmin, ownsContainer, requireSuperAdmin } from './auth.js';
import { roomFor } from './containers.js';
import { wrap, bad, forbidden, notFound, conflict, int, str } from './http.js';
import { plans } from './billing.js';
import { cfConfigured, removeRoute } from './cloudflare.js';
import { sshRun, resolvePublic } from './sshexec.js';
import { customerServers } from './myservers.js';
import { forwardingEnabled, ensureForward, removeForward, forwardStatus, portProblem, healthCheck, localTarget } from './portforward.js';

const APP_NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const DIR_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const LOG_KEEP = 200 * 1024;

export const APP_TYPES = {
  node: { label: 'Node.js', install: 'npm ci || npm install', build: '', start: 'npm start', port: 3000 },
  express: { label: 'Express', install: 'npm ci || npm install', build: '', start: 'node server.js', port: 3000 },
  nestjs: { label: 'NestJS', install: 'npm ci || npm install', build: 'npm run build', start: 'node dist/main.js', port: 3000 },
  nextjs: { label: 'Next.js', install: 'npm ci || npm install', build: 'npm run build', start: 'npx next start -p "$PORT"', port: 3000 },
  react: { label: 'React (static build)', install: 'npm ci || npm install', build: 'npm run build', start: '', port: 8080, static: true, output: 'dist' },
  static: { label: 'Static website', install: '', build: '', start: '', port: 8080, static: true, output: '.' },
  python: { label: 'Python', install: 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', build: '', start: '.venv/bin/python app.py', port: 8000 },
  docker: { label: 'Docker (Dockerfile in the repo)', install: '', build: '', start: '', port: 8080, docker: true },
  laravel: { label: 'Laravel', install: 'composer install --no-dev --optimize-autoloader', build: 'php artisan config:cache', start: 'php artisan serve --host=0.0.0.0 --port="$PORT"', port: 8000 },
};

// ---------- scripts that run inside the container ----------
// On the main server (app host) customer commands never run as root: with RUN_AS set, a script re-runs itself as that
// user after root has fixed the ownership of the app folders. On a customer's own server it runs as root, which they
// already have through the terminal anyway.
// Where apps live: /srv/apps for root, ~/apps for a non-root SSH user on a customer's server
const APPS_ROOT_LINE = `APPS_ROOT="\${APPS_ROOT:-$( [ "$(id -u)" = 0 ] && echo /srv/apps || echo "$HOME/apps")}"
`;
const AS_USER = `if [ -n "\${RUN_AS:-}" ] && [ "$(id -u)" = 0 ]; then
  id "$RUN_AS" >/dev/null 2>&1 || { echo "User $RUN_AS is missing. Run 'Install runtime' first."; exit 24; }
  mkdir -p /srv/apps/.kapilcloud
  chown "$RUN_AS:$RUN_AS" /srv/apps /srv/apps/.kapilcloud && chmod 700 /srv/apps/.kapilcloud
  if [ -n "\${APP_NAME:-}" ]; then for d in "/srv/apps/$APP_NAME" "/srv/apps/.kapilcloud/$APP_NAME"; do [ ! -e "$d" ] || chown -R "$RUN_AS:$RUN_AS" "$d"; done; fi
  export HOME="/home/$RUN_AS" PM2_HOME="/home/$RUN_AS/.pm2" USER="$RUN_AS" LOGNAME="$RUN_AS" APPS_ROOT=/srv/apps
  exec runuser -m -u "$RUN_AS" -- bash -c "$BASH_EXECUTION_STRING"
fi
${APPS_ROOT_LINE}`;

export const RUNTIME_SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
echo "==> Updating package lists"
apt-get update -q
PKGS="git curl ca-certificates nodejs npm"
case ",$RUNTIMES," in *,python,*) PKGS="$PKGS python3 python3-venv python3-pip";; esac
case ",$RUNTIMES," in *,php,*) PKGS="$PKGS php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-mysql composer unzip";; esac
case ",$RUNTIMES," in *,docker,*) command -v docker >/dev/null || PKGS="$PKGS docker.io";; esac
echo "==> Installing: $PKGS"
apt-get install -y -q $PKGS
if ! command -v pm2 >/dev/null; then echo "==> Installing PM2"; npm install -g pm2; fi
echo "==> Making PM2 start on boot"
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
systemctl enable pm2-root >/dev/null 2>&1 || true
mkdir -p /srv/apps/.kapilcloud && chmod 700 /srv/apps/.kapilcloud
if [ -n "\${RUN_AS:-}" ]; then
  id "$RUN_AS" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUN_AS"
  chown "$RUN_AS:$RUN_AS" /srv/apps /srv/apps/.kapilcloud
  pm2 startup systemd -u "$RUN_AS" --hp "/home/$RUN_AS" >/dev/null 2>&1 || true
  systemctl enable "pm2-$RUN_AS" >/dev/null 2>&1 || true
  case ",$RUNTIMES," in *,docker,*) usermod -aG docker "$RUN_AS"; systemctl enable --now docker >/dev/null 2>&1 || true;; esac
  echo "==> Apps run as the unprivileged user $RUN_AS, not root"
fi
case ",$RUNTIMES," in *,docker,*) systemctl enable --now docker >/dev/null 2>&1 || true; echo "==> Docker $(docker -v 2>/dev/null || echo missing)";; esac
echo "==> Node $(node -v 2>/dev/null || echo missing), PM2 $(pm2 -v 2>/dev/null || echo missing)"
`;

const DEPLOY_SCRIPT = `set -eu
${AS_USER}export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || { echo "git is not installed in this server. Run 'Install runtime' first."; exit 20; }
if [ "\${APP_KIND:-}" = docker ]; then command -v docker >/dev/null || { echo "Docker is not installed in this server. Run 'Install runtime' first."; exit 25; }
else command -v pm2 >/dev/null || { echo "PM2 is not installed in this server. Run 'Install runtime' first."; exit 21; }; fi
APP_DIR="$APPS_ROOT/$APP_NAME"
CFG="$APPS_ROOT/.kapilcloud/$APP_NAME"
mkdir -p "$CFG" && chmod 700 "$CFG"
set --
if [ -n "\${GIT_TOKEN:-}" ]; then
  set -- -c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)"
fi
if [ -d "$APP_DIR/.git" ]; then
  echo "==> Fetching $BRANCH"
  git "$@" -C "$APP_DIR" remote set-url origin "$REPO"
  git "$@" -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
elif [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  echo "$APP_DIR exists and is not a git checkout. Move it away first; Sampanna Cloud will not overwrite it."; exit 22
else
  echo "==> Cloning $REPO ($BRANCH)"
  git "$@" clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
echo "@@COMMIT $(git -C "$APP_DIR" rev-parse HEAD)"
WORK="$APP_DIR/$ROOT_DIR"
[ -d "$WORK" ] || { echo "Folder $ROOT_DIR does not exist in the repository"; exit 23; }
cd "$WORK"
printf '%s' "$ENV_SH_B64" | base64 -d > "$CFG/env.sh"
printf '%s' "$DOTENV_B64" | base64 -d > "$CFG/.env"
printf '%s' "$ECOSYSTEM_B64" | base64 -d | sed "s#__APPS_ROOT__#$APPS_ROOT#g" > "$CFG/ecosystem.json"
printf '%s' "\${DOCKERENV_B64:-}" | base64 -d > "$CFG/docker.env"
chmod 600 "$CFG/env.sh" "$CFG/.env" "$CFG/ecosystem.json" "$CFG/docker.env"
if [ "$WRITE_DOTENV" = "1" ]; then cp "$CFG/.env" "$WORK/.env"; chmod 600 "$WORK/.env"; fi
. "$CFG/env.sh"
export PORT
if [ "\${APP_KIND:-}" = docker ]; then
  [ -f Dockerfile ] || { echo "No Dockerfile in $ROOT_DIR"; exit 26; }
  echo "==> docker build"
  docker build -t "sc-app-$APP_NAME" .
  docker rm -f "sc-app-$APP_NAME" >/dev/null 2>&1 || true
  echo "==> docker run (port $PORT)"
  docker run -d --name "sc-app-$APP_NAME" --restart unless-stopped --env-file "$CFG/docker.env" -e PORT="$PORT" -p "$PORT:$PORT" \
    \${DOCKER_MEMORY:+--memory "$DOCKER_MEMORY"} --security-opt no-new-privileges "sc-app-$APP_NAME" >/dev/null
  docker image prune -f >/dev/null 2>&1 || true
  echo "==> Started. Listening on port $PORT inside the server."
  exit 0
fi
if [ -n "$INSTALL_CMD" ]; then echo "==> Install: $INSTALL_CMD"; bash -c "$INSTALL_CMD"; fi
if [ -n "$BUILD_CMD" ]; then echo "==> Build: $BUILD_CMD"; bash -c "$BUILD_CMD"; fi
echo "==> Starting with PM2"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start "$CFG/ecosystem.json"
pm2 save
echo "==> Started. Listening on port $PORT inside the server."
`;

const PM2_SCRIPT = `set -eu
${AS_USER}if [ "\${APP_KIND:-}" = docker ]; then
  C="sc-app-$APP_NAME"
  case "$OP" in
    start|stop|restart) docker "$OP" "$C" >/dev/null ;;
    logs) docker logs --tail 300 "$C" 2>&1 || true ;;
    status)
      if docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null | grep -q true; then st=online; else st=stopped; fi
      line=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' "$C" 2>/dev/null || true)
      cpu=$(echo "$line" | cut -d'|' -f1 | tr -d '% ')
      mem=$(echo "$line" | cut -d'|' -f2 | awk '{v=$1; u=v; gsub(/[0-9.]/,"",u); gsub(/[A-Za-z]/,"",v); m=1; if(u=="KiB")m=1024; if(u=="MiB")m=1048576; if(u=="GiB")m=1073741824; if(u=="kB")m=1000; if(u=="MB")m=1000000; if(u=="GB")m=1000000000; printf "%d", v*m}')
      printf '[{"name":"%s","pm2_env":{"status":"%s","restart_time":0},"monit":{"cpu":%s,"memory":%s}}]\n' "$APP_NAME" "$st" "\${cpu:-0}" "\${mem:-0}" ;;
    delete) docker rm -f "$C" >/dev/null 2>&1 || true; docker rmi "$C" >/dev/null 2>&1 || true
            rm -rf "$APPS_ROOT/.kapilcloud/$APP_NAME"
            if [ "$REMOVE_FILES" = "1" ]; then rm -rf "$APPS_ROOT/$APP_NAME"; fi ;;
  esac
  exit 0
fi
command -v pm2 >/dev/null || { echo "PM2 is not installed in this server."; exit 21; }
case "$OP" in
  start) if pm2 describe "$APP_NAME" >/dev/null 2>&1; then pm2 start "$APP_NAME"; else pm2 start "$APPS_ROOT/.kapilcloud/$APP_NAME/ecosystem.json"; fi ;;
  stop) pm2 stop "$APP_NAME" ;;
  restart) pm2 restart "$APP_NAME" --update-env ;;
  logs) pm2 logs "$APP_NAME" --nostream --lines 300 --raw 2>&1 || true; exit 0 ;;
  status) pm2 jlist; exit 0 ;;
  delete) pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
          rm -rf "$APPS_ROOT/.kapilcloud/$APP_NAME"
          if [ "$REMOVE_FILES" = "1" ]; then rm -rf "$APPS_ROOT/$APP_NAME"; fi ;;
esac
pm2 save >/dev/null 2>&1 || true
`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Can the panel see this repository and branch (with the token, if any)? Runs `git ls-remote` from the panel host
// before anything is saved, so a typo or a missing token fails at once instead of in the middle of a deploy.
// GIT_CHECK=off skips it (tests, offline installs). A network failure does not block: the deploy log will show it.
export async function checkRepo(repo, branch, token = '', { publicOnly = false } = {}) {
  if (process.env.GIT_CHECK === 'off') return { checked: false };
  // Customers: the panel only talks to public Git hosts (no probing of the LXD bridge, localhost, metadata)
  if (publicOnly && /^https?:/.test(repo)) await resolvePublic(new URL(repo).hostname).catch((err) => { throw bad(`Repository host: ${err.message}`); });
  const args = [];
  if (token) args.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
  args.push('ls-remote', '--heads', '--', repo, branch);
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 20_000, env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', HOME: '/nonexistent' } }, (err, stdout, stderr) => {
      const msg = String(stderr || err?.message || '');
      if (!err) {
        if (!stdout.trim()) return reject(bad(`Branch "${branch}" was not found in ${repo}`));
        return resolve({ checked: true });
      }
      if (err.code === 'ENOENT' || err.killed || /Could not resolve host|timed out|Connection refused|Network is unreachable/i.test(msg)) return resolve({ checked: false, warning: msg.slice(0, 200) });
      if (/not found|Authentication failed|could not read Username|403|401/i.test(msg)) {
        return reject(bad(token ? 'The repository was not found, or the access token cannot read it.' : 'The repository was not found or is private. For a private repository add an access token.'));
      }
      return reject(bad(`Git could not read the repository: ${msg.split('\n').filter(Boolean).pop()?.slice(0, 200) || 'unknown error'}`));
    });
  });
}
const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const dotenvQuote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

function parseEnv(input) {
  if (input == null || input === '') return {};
  const obj = {};
  if (typeof input === 'string') {
    for (const line of input.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const i = l.indexOf('=');
      if (i < 1) throw bad(`Env line "${l.slice(0, 40)}" must look like KEY=value`);
      let v = l.slice(i + 1).trim();
      if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
      obj[l.slice(0, i).trim().replace(/^export\s+/, '')] = v;
    }
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    Object.assign(obj, input);
  } else throw bad('env must be KEY=value lines');
  const keys = Object.keys(obj);
  if (keys.length > 200) throw bad('At most 200 environment variables');
  for (const k of keys) {
    if (!ENV_KEY_RE.test(k)) throw bad(`Invalid variable name ${k.slice(0, 40)}`);
    if (typeof obj[k] !== 'string') obj[k] = String(obj[k]);
    if (obj[k].length > 8000) throw bad(`${k} is too long`);
  }
  return obj;
}

const appsDb = {
  get: (id) => db.prepare('SELECT * FROM apps WHERE id = ?').get(id),
  list: () => db.prepare('SELECT a.*, u.username AS owner FROM apps a JOIN users u ON u.id = a.user_id ORDER BY a.container, a.name').all(),
  setStatus: (id, status) => db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id),
  deployments: (appId, limit = 30) => db.prepare('SELECT id, kind, by_user, status, commit_sha, started_at, finished_at FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT ?').all(appId, limit),
};

// Targets: 'server' = one of the user's own servers; 'main' = the main server, in the user's panel-managed app host
// (apphost.js), for users without a VPS. The app is priced by an "app" plan.
export function createApps({ io, containers, appHost = null, billing = null }) {
  const router = express.Router();
  const busy = new Map(); // appId -> deployment id
  let onDeployed = () => {}; // set by server.js: automatic subdomain
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });

  const publicApp = (a) => {
    let envKeys = [];
    try { envKeys = Object.keys(JSON.parse(open(a.env_enc) || '{}')); } catch { envKeys = []; }
    return {
      id: a.id, name: a.name, container: a.container, type: a.type, typeLabel: APP_TYPES[a.type]?.label || a.type,
      owner: a.owner || users.byId(a.user_id)?.username, userId: a.user_id, repoUrl: a.repo_url, branch: a.branch, rootDir: a.root_dir || '',
      outputDir: a.output_dir || '', installCmd: a.install_cmd || '', buildCmd: a.build_cmd || '', startCmd: a.start_cmd || '',
      port: a.port, envKeys, hasGitToken: !!a.git_token_enc, status: a.status, lastDeployAt: a.last_deploy_at,
      deploying: busy.has(a.id), createdAt: a.created_at, target: a.target || 'server', planId: a.plan_id ?? null,
      // Main server: the owner's hosting package covers all their apps there; on their own server it is in the server's price
      planName: a.target === 'main' ? appHost?.packageOf(a.user_id)?.name || null : null,
      priceDay: null,
      serverId: a.server_id ?? null,
      serverName: a.target === 'vps' ? customerServers.get(a.server_id)?.name || '(removed)' : null,
      directUrl: a.target === 'vps' && customerServers.get(a.server_id) ? `http://${customerServers.get(a.server_id).host}:${a.port}` : null,
      domains: db.prepare("SELECT hostname, status FROM domains WHERE app_id = ? AND status != 'removed'").all(a.id),
    };
  };

  function mineApp(req) {
    const a = /^\d+$/.test(req.params.id) ? appsDb.get(Number(req.params.id)) : null;
    if (!a) throw notFound('No such application');
    if (!ownsContainer(req.session, a.container) && a.user_id !== req.session.id) throw forbidden('You can only manage your own applications');
    return a;
  }
  // Ready to run something for this app? (LXD server running, or the customer's VPS known and not on a changed host key)
  function needReady(a) {
    if (a.target !== 'vps') return needRunning(a.container);
    const srv = customerServers.get(a.server_id);
    if (!srv) throw notFound('The VPS of this app was removed from the panel');
    if (srv.status === 'host_key_changed') throw conflict(`${srv.name}: the host key changed. Check the server on My VPS servers.`);
    return srv;
  }
  function needRunning(container) {
    if (!containers.exists(container)) throw notFound('The server for this app does not exist');
    if (containers.snapshot(container)?.status !== 'Running') throw conflict('Start the server first');
  }

  function validate(b, existing = null) {
    const type = existing?.type || b.type;
    const t = APP_TYPES[type];
    if (!t) throw bad('Pick an application type');
    const repo = str(b.repoUrl ?? existing?.repo_url, { max: 300, name: 'Repository URL' });
    let u;
    try { u = new URL(repo); } catch { throw bad('Repository URL must be an https:// URL'); }
    if (u.protocol !== 'https:' || u.username || u.password) throw bad('Repository URL must be https:// without a password in it (use the token field)');
    const branch = str(b.branch ?? existing?.branch ?? 'main', { max: 100, name: 'Branch', re: BRANCH_RE });
    const rootDir = (b.rootDir ?? existing?.root_dir ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!DIR_RE.test(rootDir)) throw bad('Root folder: a relative path inside the repository');
    const outputDir = (b.outputDir ?? existing?.output_dir ?? t.output ?? '').trim().replace(/^\/+|\/+$/g, '') || (t.static ? '.' : '');
    if (!DIR_RE.test(outputDir)) throw bad('Output folder: a relative path');
    const cmd = (v, name) => {
      if (v == null) return '';
      if (typeof v !== 'string' || v.length > 1000 || /[\0\r]/.test(v)) throw bad(`${name}: at most 1000 characters on one line`);
      return v.replace(/\n/g, ' ').trim();
    };
    const installCmd = cmd(b.installCmd ?? existing?.install_cmd ?? t.install, 'Install command');
    const buildCmd = cmd(b.buildCmd ?? existing?.build_cmd ?? t.build, 'Build command');
    const startCmd = cmd(b.startCmd ?? existing?.start_cmd ?? t.start, 'Start command');
    if (!t.static && !t.docker && !startCmd) throw bad('Start command is required');
    const port = int(b.port ?? existing?.port ?? t.port, { min: 1024, max: 65535, name: 'Port' });
    return { type, repo, branch, rootDir, outputDir, installCmd, buildCmd, startCmd, port };
  }

  function ecosystem(a, env) {
    const cwd = `__APPS_ROOT__/${a.name}${a.root_dir ? `/${a.root_dir}` : ''}`; // filled in by the deploy script
    const base = { name: a.name, cwd, env: { ...env, PORT: String(a.port), NODE_ENV: env.NODE_ENV || 'production' }, autorestart: true, max_restarts: 20 };
    if (APP_TYPES[a.type]?.static) {
      return { apps: [{ ...base, script: 'serve', env: { ...base.env, PM2_SERVE_PATH: `${cwd}/${a.output_dir || '.'}`, PM2_SERVE_PORT: String(a.port), PM2_SERVE_SPA: 'true' } }] };
    }
    return { apps: [{ ...base, script: 'bash', args: ['-c', a.start_cmd], interpreter: 'none' }] };
  }

  const rooms = (a) => ['admin', roomFor(a.container), `user:${a.user_id}`];
  const emitLog = (a, depId, text) => io.to(rooms(a)).emit('app:log', { appId: a.id, deploymentId: depId, text });
  const emitApp = (a) => { const fresh = appsDb.get(a.id); if (fresh) io.to(rooms(a)).emit('app:update', publicApp(fresh)); };

  // One way to run an app script wherever the app lives: LXD exec (own server / main server app host) or SSH (VPS)
  const kindEnv = (a) => (APP_TYPES[a.type]?.docker ? { APP_KIND: 'docker' } : {});
  function execApp(a, script, env, { timeoutMs = 60_000, onOutput = () => {}, asRoot = false } = {}) {
    if (a.target === 'vps') {
      const srv = customerServers.get(a.server_id);
      if (!srv) return Promise.reject(notFound('The VPS of this app was removed from the panel'));
      return sshRun(customerServers.creds(srv), script, { env: { ...kindEnv(a), ...env }, timeoutMs, onOutput, asRoot });
    }
    return execStream(a.container, ['bash', '-c', script], { env: { ...runAs(a.container), ...kindEnv(a), ...env }, timeoutMs, onOutput });
  }

  // Runs a script in the container as a recorded deployment (deploy, runtime install, start/stop/restart)
  // `req` may also be an actor { username, ip } for background work
  // `post(say)` runs on the panel after the script succeeded (port forwarding, health check); false = deploy failed
  function runRecorded(req, a, kind, script, env, { timeoutMs = 30 * 60_000, onFinish = () => {}, post = null } = {}) {
    const { username, ip } = req.session ? who(req) : req;
    const depId = Number(db.prepare('INSERT INTO deployments (app_id, kind, by_user, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, kind, username, 'running', Date.now()).lastInsertRowid);
    busy.set(a.id, depId);
    if (kind === 'deploy') appsDb.setStatus(a.id, 'deploying');
    emitApp(a);
    audit.log({ username, ip, action: `app_${kind}`, target: `${a.container}/${a.name}`, result: 'requested' });
    let log = '';
    const out = (text) => { log = (log + text).slice(-LOG_KEEP); emitLog(a, depId, text); };
    execApp(a, script, env, { timeoutMs, asRoot: kind === 'runtime', onOutput: out })
      .then(({ code }) => ({ ok: code === 0, code }))
      .catch((err) => { out(`\n[Sampanna Cloud] ${err.message}\n`); return { ok: false, code: -1 }; })
      .then(async (r) => {
        if (!r.ok || !post) return r;
        const ok = await Promise.resolve(post((line) => out(`${line}\n`))).catch((err) => { out(`[Sampanna Cloud] ${err.message}\n`); return false; });
        return ok ? r : { ok: false, code: 'post-deploy check' };
      })
      .then(({ ok, code }) => {
        const commit = /@@COMMIT ([0-9a-f]{40})/.exec(log)?.[1] || null;
        db.prepare('UPDATE deployments SET status = ?, log = ?, commit_sha = ?, finished_at = ? WHERE id = ?')
          .run(ok ? 'success' : 'failed', log, commit, Date.now(), depId);
        busy.delete(a.id);
        onFinish(ok);
        audit.log({ username, ip, action: `app_${kind}`, target: `${a.container}/${a.name}`, result: ok ? 'success' : 'failure', detail: ok ? commit : typeof code === 'number' ? `exit code ${code}` : code });
        emitApp(a);
      });
    return depId;
  }

  // ---------- routes ----------
  router.get('/apps/types', (_req, res) => res.json({ types: Object.entries(APP_TYPES).map(([id, t]) => ({ id, ...t })) }));

  // App plans for the "Main server" target
  router.get('/apps/plans', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ plans: plans.list({ kind: 'app', activeOnly: !isAdmin(req.session) }).map((p) => ({
      id: p.id, name: p.name, cpu: p.cpu, memoryMb: p.memory_mb, diskGb: p.disk_gb, priceDay: p.price_day, description: p.description,
    })) });
  });

  router.get('/apps', (req, res) => {
    const list = appsDb.list().filter((a) => ownsContainer(req.session, a.container) || a.user_id === req.session.id);
    res.set('Cache-Control', 'no-store');
    res.json({ apps: list.map(publicApp) });
  });

  router.get('/apps/:id', wrap(async (req, res) => {
    const a = mineApp(req);
    res.set('Cache-Control', 'no-store');
    res.json({ app: publicApp(a), deployments: appsDb.deployments(a.id) });
  }));

  router.get('/apps/:id/deployments/:dep', wrap(async (req, res) => {
    const a = mineApp(req);
    const d = db.prepare('SELECT * FROM deployments WHERE id = ? AND app_id = ?').get(Number(req.params.dep), a.id);
    if (!d) throw notFound('No such deployment');
    res.json({ deployment: d });
  }));

  router.post('/apps', wrap(async (req, res) => {
    const b = req.body ?? {};
    if (b.target === 'main') return createOnMain(req, res);
    if (b.target === 'vps') return createOnVps(req, res);
    if (b.target && b.target !== 'server') throw bad('Target must be server, main or vps');
    const container = str(b.container, { max: 63, name: 'Server' });
    if (!ownsContainer(req.session, container) || !containers.exists(container)) throw forbidden('Pick one of your servers');
    if (appHost?.isAppHost(container)) throw bad('That is your managed app host. Pick "Main server" to add apps to it.');
    const name = str(b.name, { max: 32, name: 'App name' }).toLowerCase();
    if (!APP_NAME_RE.test(name)) throw bad('App name: 3-32 lowercase letters, digits or dashes');
    const t0 = APP_TYPES[b.type];
    if (!t0) throw bad('Pick an application type');
    const asked = b.port != null && b.port !== '' ? int(b.port, { min: 1024, max: 65535, name: 'Port' }) : null;
    validate({ ...b, port: asked ?? t0.port });
    if (db.prepare('SELECT 1 FROM apps WHERE container = ? AND name = ?').get(container, name)) throw conflict(`${name} already exists on ${container}`);
    const v = validate({ ...b, port: await pickPort(container, asked ?? t0.port, asked != null, container) });
    await checkRepo(v.repo, v.branch, b.gitToken, { publicOnly: !isAdmin(req.session) });
    const env = parseEnv(b.env);
    const ownerId = isAdmin(req.session) ? (users.ownersOf(container)[0]?.id || req.session.id) : req.session.id;
    const now = Date.now();
    const id = db.prepare(`INSERT INTO apps (user_id, container, name, type, repo_url, branch, root_dir, output_dir, install_cmd, build_cmd, start_cmd,
        port, env_enc, git_token_enc, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
      .run(ownerId, container, name, v.type, v.repo, v.branch, v.rootDir, v.outputDir, v.installCmd, v.buildCmd, v.startCmd, v.port,
        seal(JSON.stringify(env)), b.gitToken ? seal(String(b.gitToken).slice(0, 500)) : null, now, now).lastInsertRowid;
    audit.log({ ...who(req), action: 'app_create', target: `${container}/${name}`, result: 'success', detail: `${v.type} ${v.repo}#${v.branch}` });
    res.status(201).json({ app: publicApp(appsDb.get(Number(id))) });
  }));

  router.put('/apps/:id', wrap(async (req, res) => {
    const a = mineApp(req);
    const b = req.body ?? {};
    const v = validate(b, a);
    if (v.port !== a.port && db.prepare('SELECT 1 FROM apps WHERE container = ? AND port = ? AND id != ?').get(a.container, v.port, a.id)) {
      throw conflict(`Port ${v.port} is already used by another app on ${a.container}`);
    }
    // Takes effect on the next deploy, which forwards the new port and removes the old proxy device
    if (v.port !== a.port && onLxd(a)) await pickPort(a.container, v.port, true, a.container).catch((err) => { if (!(err.status === 409 && /another app on/.test(err.message))) throw err; });
    let envEnc = a.env_enc;
    if (b.env !== undefined) {
      // Values left as "********" keep their saved value, so secrets never have to travel back to the browser
      const old = JSON.parse(open(a.env_enc) || '{}');
      const next = parseEnv(b.env);
      for (const k of Object.keys(next)) if (next[k] === '********' && k in old) next[k] = old[k];
      envEnc = seal(JSON.stringify(next));
    }
    const tokenEnc = b.gitToken === '' ? null : b.gitToken ? seal(String(b.gitToken).slice(0, 500)) : a.git_token_enc;
    if (v.repo !== a.repo_url || v.branch !== a.branch || b.gitToken) await checkRepo(v.repo, v.branch, open(tokenEnc) || '', { publicOnly: !isAdmin(req.session) });
    db.prepare(`UPDATE apps SET repo_url = ?, branch = ?, root_dir = ?, output_dir = ?, install_cmd = ?, build_cmd = ?, start_cmd = ?, port = ?,
        env_enc = ?, git_token_enc = ?, updated_at = ? WHERE id = ?`)
      .run(v.repo, v.branch, v.rootDir, v.outputDir, v.installCmd, v.buildCmd, v.startCmd, v.port, envEnc, tokenEnc, Date.now(), a.id);
    audit.log({ ...who(req), action: 'app_update', target: `${a.container}/${a.name}`, result: 'success' });
    res.json({ app: publicApp(appsDb.get(a.id)) });
  }));

  // Env values are shown masked; admins and owners can reveal them on purpose (audited)
  router.get('/apps/:id/env', wrap(async (req, res) => {
    const a = mineApp(req);
    const env = JSON.parse(open(a.env_enc) || '{}');
    const reveal = req.query.reveal === '1';
    if (reveal) audit.log({ ...who(req), action: 'app_env_reveal', target: `${a.container}/${a.name}`, result: 'success' });
    res.set('Cache-Control', 'no-store');
    res.json({ env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, reveal ? v : '********'])) });
  }));

  router.post('/apps/:id/deploy', wrap(async (req, res) => {
    const a = mineApp(req);
    needReady(a);
    if (busy.has(a.id)) throw conflict('A deployment for this app is already running');
    res.status(202).json({ deploymentId: startDeploy(req, a, req.body?.writeDotenv !== false) });
  }));

  function startDeploy(req, a, writeDotenv = true, after = () => {}) {
    const env = JSON.parse(open(a.env_enc) || '{}');
    const envSh = `${Object.entries({ ...env, PORT: String(a.port) }).map(([k, v]) => `export ${k}=${shQuote(v)}`).join('\n')}\n`;
    const dotenv = `${Object.entries(env).map(([k, v]) => `${k}=${dotenvQuote(v)}`).join('\n')}\n`;
    // docker --env-file takes values literally (no quotes); a newline cannot be expressed, so it is written as \n
    const dockerEnv = `${Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, '\\n')}`).join('\n')}\n`;
    const depId = runRecorded(req, a, 'deploy', DEPLOY_SCRIPT, {
      APP_NAME: a.name, REPO: a.repo_url, BRANCH: a.branch, ROOT_DIR: a.root_dir || '', PORT: String(a.port),
      INSTALL_CMD: a.install_cmd || '', BUILD_CMD: a.build_cmd || '', GIT_TOKEN: open(a.git_token_enc) || '',
      ENV_SH_B64: b64(envSh), DOTENV_B64: b64(dotenv), DOCKERENV_B64: b64(dockerEnv), ECOSYSTEM_B64: b64(JSON.stringify(ecosystem(a, env), null, 2)),
      WRITE_DOTENV: writeDotenv ? '1' : '0',
    }, {
      post: async (say) => {
        if (onLxd(a) && forwardingEnabled()) {
          if (!(await forwardStep(a, say))) return false;
          if (!(await healthStep(a, say))) return false;
        }
        await Promise.resolve(onDeployed(a.id, say)).catch((err) => say(`[Sampanna Cloud] Public hostname: ${err.message}`));
        say('==> Deployed.');
        return true;
      },
      onFinish: (ok) => {
        appsDb.setStatus(a.id, ok ? 'running' : 'failed');
        if (ok) db.prepare('UPDATE apps SET last_deploy_at = ? WHERE id = ?').run(Date.now(), a.id);
        after(ok);
      },
    });
    return depId;
  }

  // ---------- host port forwarding (LXD proxy device) + health check ----------
  const onLxd = (a) => a.target !== 'vps';
  const otherAppUses = (container, port, exceptId) => !!db.prepare('SELECT 1 FROM apps WHERE container = ? AND port = ? AND id != ?').get(container, port, exceptId);

  // Makes port<PORT> exist on the app's container and drops the device of a port the app used before. Never throws.
  async function forwardApp(a, say = () => {}) {
    const fresh = appsDb.get(a.id) || a;
    const r = await ensureForward(fresh.container, fresh.port);
    say({
      unchanged: `Proxy device ${r.device} already in place`,
      created: `Created proxy device ${r.device}: listen=tcp:127.0.0.1:${fresh.port} connect=tcp:127.0.0.1:${fresh.port}`,
      updated: `Updated proxy device ${r.device} to listen=tcp:127.0.0.1:${fresh.port} connect=tcp:127.0.0.1:${fresh.port}`,
      manual: `Port ${fresh.port} is already forwarded by the device ${r.device} (added by hand); left as it is`,
    }[r.action]);
    const old = fresh.forwarded_port;
    if (old && old !== fresh.port && !otherAppUses(fresh.container, old, fresh.id)) {
      await removeForward(fresh.container, old)
        .then((gone) => { if (gone) say(`Removed the old proxy device port${old}`); })
        .catch((err) => say(`Could not remove the old proxy device port${old}: ${err.message}`));
    }
    db.prepare('UPDATE apps SET forwarded_port = ? WHERE id = ?').run(fresh.port, fresh.id);
    return r;
  }

  async function forwardStep(a, say) {
    say(`==> Forwarding port ${a.port} (host 127.0.0.1:${a.port} -> ${a.container} 127.0.0.1:${a.port})`);
    try {
      await forwardApp(a, say);
      return true;
    } catch (err) {
      say(`[Sampanna Cloud] Port forwarding failed: ${err.message}`);
      return false;
    }
  }

  async function healthStep(a, say) {
    say(`==> Health check: http://127.0.0.1:${a.port} from the host`);
    const r = await healthCheck(a.port, { say: (l) => say(`  ${l}`) });
    if (r.ok) return true;
    say(`[Sampanna Cloud] FAILED: nothing answers on host port ${a.port} (${r.error}). The public URL would show 502 Bad Gateway.`);
    await diagnose(a, say);
    return false;
  }

  // What to look at when the health check fails: PM2 state, listening sockets in the container, the proxy device
  async function diagnose(a, say) {
    say('==> Diagnostics');
    try {
      const r = await execApp(a, PM2_SCRIPT, { OP: 'status', APP_NAME: a.name, REMOVE_FILES: '0' }, { timeoutMs: 30_000 });
      let list = [];
      try { list = JSON.parse(r.output.slice(r.output.indexOf('['))); } catch { list = []; }
      const p = list.find((x) => x.name === a.name);
      say(p ? `PM2: ${a.name} is ${p.pm2_env?.status || 'unknown'} (restarts: ${p.pm2_env?.restart_time ?? 0})` : `PM2: no process named ${a.name} inside ${a.container}`);
    } catch (err) { say(`PM2: could not ask (${err.message})`); }
    try {
      const r = await execStream(a.container, ['ss', '-tlnp'], { timeoutMs: 20_000 });
      say(`Listening TCP sockets inside ${a.container} (ss -tlnp):`);
      say(r.output.trimEnd() || '(none)');
      const portRe = new RegExp(`:${a.port}\\s`);
      const lines = r.output.split('\n').filter((l) => portRe.test(l));
      if (!lines.length) say(`Nothing listens on port ${a.port} inside the container. Does the app use the PORT variable (${a.port})?`);
      else if (!lines.some((l) => new RegExp(`(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\*|\\[::\\]|\\[::ffff:127\\.0\\.0\\.1\\]):${a.port}\\s`).test(l))) {
        say(`Port ${a.port} is bound to another address only. The app must listen on 0.0.0.0 or 127.0.0.1.`);
      }
    } catch (err) { say(`ss -tlnp: could not run (${err.message})`); }
    try {
      const s = await forwardStatus(a.container, a.port);
      say(`Proxy device: ${{ ok: `${s.device} present (${s.config.listen} -> ${s.config.connect})`, other: `${s.device} forwards the port`, different: `${s.device} exists but with listen=${s.config.listen} connect=${s.config.connect}`, missing: `port${a.port} MISSING` }[s.status]}`);
    } catch (err) { say(`Proxy device: could not check (${err.message})`); }
  }

  // Port for a new app in an LXD container. Host ports are shared by all containers (cloudflared reaches every app at
  // localhost:<port>), so a port is free only if no other container's app uses it and nothing on the host holds it.
  // explicit = the user typed it: refuse a taken one with a clear message; otherwise move on to the next free port.
  async function pickPort(container, wanted, explicit, label) {
    const here = new Set(db.prepare('SELECT port FROM apps WHERE container = ?').all(container).map((r) => r.port));
    const elsewhere = new Set();
    if (forwardingEnabled()) {
      for (const r of db.prepare("SELECT port, forwarded_port FROM apps WHERE container != ? AND target != 'vps'").all(container)) {
        elsewhere.add(r.port);
        if (r.forwarded_port) elsewhere.add(r.forwarded_port);
      }
    }
    const problem = (port) => (forwardingEnabled() ? portProblem(container, port).catch(() => null) : null);
    if (explicit) {
      if (here.has(wanted)) throw conflict(`Port ${wanted} is already used by another app on ${label}`);
      if (elsewhere.has(wanted)) throw conflict(`Port ${wanted} is already taken on the host by another app. Pick another port.`);
      const p = await problem(wanted);
      if (p) throw conflict(p);
      return wanted;
    }
    for (let port = wanted; port <= 65535; port += 1) {
      if (!here.has(port) && !elsewhere.has(port) && !(await problem(port))) return port;
    }
    throw conflict('No free port left');
  }

  // Network facts for the app page: container, IP, port, proxy device state
  async function networkOf(a) {
    if (!onLxd(a)) return { applicable: false };
    const out = { applicable: true, enabled: forwardingEnabled(), container: a.container, ip: containers.snapshot(a.container)?.ip || null, port: a.port, hostTarget: localTarget(a.port) };
    if (!forwardingEnabled()) return { ...out, forward: { status: 'disabled' } };
    try {
      const s = await forwardStatus(a.container, a.port);
      out.forward = { status: s.status, device: s.device, listen: s.config?.listen || null, connect: s.config?.connect || null };
      if (s.status === 'missing' || s.status === 'different') out.forward.problem = await portProblem(a.container, a.port).catch(() => null);
    } catch (err) {
      out.forward = { status: 'error', error: err.message };
    }
    return out;
  }

  router.get('/apps/:id/network', wrap(async (req, res) => {
    const a = mineApp(req);
    res.set('Cache-Control', 'no-store');
    res.json(await networkOf(a));
  }));

  // "Fix port forwarding": re-runs the forward step, then points the app's public hostnames at it again
  router.post('/apps/:id/forward', wrap(async (req, res) => {
    const a = mineApp(req);
    if (!onLxd(a)) throw bad('This app runs on your own VPS; there is no port to forward');
    if (!forwardingEnabled()) throw conflict('Port forwarding is turned off on this panel (PORT_FORWARD=off)');
    if (!containers.exists(a.container)) throw notFound('The server for this app does not exist');
    if (busy.has(a.id)) throw conflict('Wait for the running task to finish');
    const log = [];
    const say = (l) => log.push(l);
    try {
      await forwardApp(a, say);
    } catch (err) {
      audit.log({ ...who(req), action: 'app_forward', target: `${a.container}/${a.name}`, result: 'failure', detail: err.message });
      throw err.status ? err : conflict(err.message);
    }
    await Promise.resolve(onDeployed(a.id, say)).catch((err) => say(`Public hostname: ${err.message}`));
    audit.log({ ...who(req), action: 'app_forward', target: `${a.container}/${a.name}`, result: 'success', detail: `port${a.port}` });
    emitApp(a);
    res.json({ log, network: await networkOf(appsDb.get(a.id)) });
  }));

  const runAs = (container) => (appHost?.isAppHost(container) ? { RUN_AS: 'app' } : {});
  const runtimesFor = (a) => ['node', a.type === 'python' ? 'python' : null, a.type === 'laravel' ? 'php' : null, APP_TYPES[a.type]?.docker ? 'docker' : null].filter(Boolean).join(',');

  // ---------- hosting package (main server) ----------
  router.get('/hosting', (req, res) => {
    const pkg = appHost?.packageOf(req.session.id);
    const host = appHost?.hostNameFor(req.session.username);
    const used = host ? db.prepare("SELECT COUNT(*) AS n FROM apps WHERE container = ? AND target = 'main'").get(host).n : 0;
    res.set('Cache-Control', 'no-store');
    res.json({
      package: pkg && { id: pkg.id, name: pkg.name, cpu: pkg.cpu, memoryMb: pkg.memory_mb, diskGb: pkg.disk_gb, maxApps: pkg.max_apps, priceDay: pkg.price_day },
      appsUsed: used, host: host && containers.exists(host) ? { name: host, status: containers.snapshot(host)?.status || null } : null,
      packages: plans.list({ kind: 'app', activeOnly: !isAdmin(req.session) }).map((p) => ({ id: p.id, name: p.name, cpu: p.cpu, memoryMb: p.memory_mb, diskGb: p.disk_gb, maxApps: p.max_apps, priceDay: p.price_day, description: p.description })),
    });
  });

  // Change package (up or down). Starts with the first app; ends with the last one.
  router.put('/hosting', wrap(async (req, res) => {
    const user = users.byId(req.session.id);
    const cur = appHost.packageOf(user.id);
    if (!cur) throw bad('You have no hosting package yet. It starts with your first app on the main server.');
    const plan = plans.get(int(req.body?.planId, { min: 1, max: 1e9, name: 'Package' }));
    if (!plan || plan.kind !== 'app' || (!plan.active && !isAdmin(req.session))) throw bad('Pick an available package');
    if (plan.id === cur.id) return res.json({ ok: true });
    const host = appHost.hostNameFor(user.username);
    const used = db.prepare("SELECT COUNT(*) AS n FROM apps WHERE container = ? AND target = 'main'").get(host).n;
    if (plan.max_apps != null && used > plan.max_apps) throw conflict(`${plan.name} allows ${plan.max_apps} apps and you have ${used}. Delete some first.`);
    const curDisk = cur.disk_gb || 0;
    if ((plan.disk_gb || 0) < curDisk) throw bad('A smaller disk is not possible (it could destroy data). Pick a package with at least the same disk.');
    if (!isAdmin(req.session) && plan.price_day > cur.price_day) billing?.assertCanAfford(user.id, plan.price_day - cur.price_day);
    const room = await appHost.checkRoom(user, plan);
    if (room) return res.status(409).json({ error: `The main server has no room for ${plan.name} right now. ${room}` });
    db.prepare('UPDATE users SET hosting_plan_id = ? WHERE id = ?').run(plan.id, user.id);
    const r = db.prepare("SELECT * FROM billed_resources WHERE kind = 'app' AND name = ? AND ended_at IS NULL").get(host);
    if (r) { billing.settle(r); db.prepare('UPDATE billed_resources SET price_day = ?, plan_id = ? WHERE id = ?').run(plan.price_day, plan.id, r.id); }
    await appHost.applyPackage(user);
    audit.log({ ...who(req), action: 'hosting_change', target: user.username, result: 'success', detail: `${cur.name} -> ${plan.name}` });
    return res.json({ ok: true });
  }));

  // Live CPU / RAM / restarts of one app (from PM2 in its server)
  router.get('/apps/:id/stats', wrap(async (req, res) => {
    const a = mineApp(req);
    res.set('Cache-Control', 'no-store');
    if (a.target !== 'vps' && containers.snapshot(a.container)?.status !== 'Running') return res.json({ running: false });
    let r;
    try { r = await execApp(a, PM2_SCRIPT, { OP: 'status', APP_NAME: a.name, REMOVE_FILES: '0' }, { timeoutMs: 30_000 }); } catch { return res.json({ running: false }); }
    let list = [];
    try { list = JSON.parse(r.output.slice(r.output.indexOf('['))); } catch { list = []; }
    const p = list.find((x) => x.name === a.name);
    return res.json(p ? { running: true, status: p.pm2_env?.status, cpu: p.monit?.cpu ?? 0, memory: p.monit?.memory ?? 0, restarts: p.pm2_env?.restart_time ?? 0, uptime: p.pm2_env?.pm_uptime ?? null }
      : { running: true, status: 'not started' });
  }));

  // ---------- customer's own VPS (over SSH) ----------
  async function createOnVps(req, res) {
    const b = req.body ?? {};
    const srv = customerServers.get(int(b.serverId, { min: 1, max: 1e9, name: 'VPS' }));
    if (!srv || srv.user_id !== req.session.id) throw notFound('Pick one of your connected VPS servers');
    const name = str(b.name, { max: 32, name: 'App name' }).toLowerCase();
    if (!APP_NAME_RE.test(name)) throw bad('App name: 3-32 lowercase letters, digits or dashes');
    const container = `vps-${srv.id}`; // apps.container is a label here; the server is apps.server_id
    if (db.prepare('SELECT 1 FROM apps WHERE container = ? AND name = ?').get(container, name)) throw conflict(`${name} already exists on ${srv.name}`);
    const t = APP_TYPES[b.type];
    if (!t) throw bad('Pick an application type');
    let port = b.port ? int(b.port, { min: 1024, max: 65535, name: 'Port' }) : t.port;
    const used = new Set(db.prepare('SELECT port FROM apps WHERE container = ?').all(container).map((r) => r.port));
    if (b.port && used.has(port)) throw conflict(`Port ${port} is already used by another app on ${srv.name}`);
    while (used.has(port)) port += 1;
    const v = validate({ ...b, port });
    await checkRepo(v.repo, v.branch, b.gitToken, { publicOnly: !isAdmin(req.session) });
    const env = parseEnv(b.env);
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO apps (user_id, container, name, type, repo_url, branch, root_dir, output_dir, install_cmd, build_cmd, start_cmd,
        port, env_enc, git_token_enc, status, created_at, updated_at, target, server_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 'vps', ?)`)
      .run(req.session.id, container, name, v.type, v.repo, v.branch, v.rootDir, v.outputDir, v.installCmd, v.buildCmd, v.startCmd, v.port,
        seal(JSON.stringify(env)), b.gitToken ? seal(String(b.gitToken).slice(0, 500)) : null, now, now, srv.id).lastInsertRowid);
    audit.log({ ...who(req), action: 'app_create', target: `${srv.name}/${name}`, result: 'success', detail: `my VPS ${srv.host}, ${v.type} ${v.repo}#${v.branch}` });
    return res.status(201).json({ app: publicApp(appsDb.get(id)) });
  }

  // ---------- main server (managed app host) ----------
  async function createOnMain(req, res) {
    const b = req.body ?? {};
    if (!appHost) throw bad('Deploying on the main server is not available');
    const user = users.byId(req.session.id);
    const self = !isAdmin(req.session);
    // Hosting package: the user's current one, or the one picked now (first app on the main server)
    const current = appHost.packageOf(user.id);
    const plan = current || (b.planId ? plans.get(int(b.planId, { min: 1, max: 1e9, name: 'Plan' })) : null);
    if (!plan || plan.kind !== 'app' || (self && !current && !plan.active)) throw bad('Pick a hosting package');
    const name = str(b.name, { max: 32, name: 'App name' }).toLowerCase();
    if (!APP_NAME_RE.test(name)) throw bad('App name: 3-32 lowercase letters, digits or dashes');
    const host = appHost.hostNameFor(user.username);
    if (containers.exists(host) && !appHost.isAppHost(host)) throw conflict(`A server named ${host} already exists that the panel does not manage. Ask the administrator.`);
    if (db.prepare('SELECT 1 FROM apps WHERE container = ? AND name = ?').get(host, name)) throw conflict(`You already have an app named ${name}`);
    const count = db.prepare("SELECT COUNT(*) AS n FROM apps WHERE container = ? AND target = 'main'").get(host).n;
    if (plan.max_apps != null && count >= plan.max_apps) {
      throw conflict(`Your ${plan.name} package allows ${plan.max_apps} app${plan.max_apps === 1 ? '' : 's'}. Upgrade the package (Plans & billing) to add more.`);
    }
    const t = APP_TYPES[b.type];
    if (!t) throw bad('Pick an application type');
    // Port: the type's default, or the next free one in the app host
    const port = await pickPort(host, b.port ? int(b.port, { min: 1024, max: 65535, name: 'Port' }) : t.port, !!b.port, 'your app host');
    const v = validate({ ...b, port });
    if (self && !current) billing?.assertCanAfford(user.id, plan.price_day);
    if (!current) {
      const room = await appHost.checkRoom(user, plan);
      if (room) return res.status(409).json({ error: `The main server has no room for this package right now. ${room}` });
    }
    await checkRepo(v.repo, v.branch, b.gitToken, { publicOnly: !isAdmin(req.session) });
    const env = parseEnv(b.env);
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO apps (user_id, container, name, type, repo_url, branch, root_dir, output_dir, install_cmd, build_cmd, start_cmd,
        port, env_enc, git_token_enc, status, created_at, updated_at, target, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, 'main', ?)`)
      .run(user.id, host, name, v.type, v.repo, v.branch, v.rootDir, v.outputDir, v.installCmd, v.buildCmd, v.startCmd, v.port,
        seal(JSON.stringify(env)), b.gitToken ? seal(String(b.gitToken).slice(0, 500)) : null, now, now, plan.id).lastInsertRowid);
    if (!current) {
      db.prepare('UPDATE users SET hosting_plan_id = ? WHERE id = ?').run(plan.id, user.id);
      billing?.start({ userId: user.id, kind: 'app', name: host, planId: plan.id, priceDay: plan.price_day, by: req.session.username });
      audit.log({ ...who(req), action: 'hosting_subscribe', target: user.username, result: 'success', detail: `${plan.name}, ${plan.price_day} paisa/day` });
    }
    audit.log({ ...who(req), action: 'app_create', target: `${host}/${name}`, result: 'success', detail: `main server, package ${plan.name}, ${v.type} ${v.repo}#${v.branch}` });
    provision(who(req), user, id);
    return res.status(201).json({ app: publicApp(appsDb.get(id)) });
  }

  // Background: app host ready -> runtime -> first deploy. Every step is a recorded deployment with its log.
  function provision(actor, user, appId) {
    const a = appsDb.get(appId);
    const depId = Number(db.prepare('INSERT INTO deployments (app_id, kind, by_user, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'provision', actor.username, 'running', Date.now()).lastInsertRowid);
    busy.set(a.id, depId);
    let log = '';
    const say = (m) => { log += `${m}\n`; emitLog(a, depId, `${m}\n`); };
    emitApp(a);
    appHost.ensure(user, say)
      .then(async (host) => {
        io.in(`user:${user.id}`).socketsJoin(roomFor(host));
        say(`App host ${host} is running.`);
        db.prepare("UPDATE deployments SET status = 'success', log = ?, finished_at = ? WHERE id = ?").run(log, Date.now(), depId);
        busy.delete(a.id);
        const fresh = appsDb.get(appId);
        if (!fresh) return;
        if (APP_TYPES[fresh.type]?.docker) await appHost.enableDocker(host, say);
        runRecorded(actor, fresh, 'runtime', RUNTIME_SCRIPT, { RUNTIMES: runtimesFor(fresh) }, {
          timeoutMs: 20 * 60_000,
          onFinish: (ok) => {
            if (!ok) { appsDb.setStatus(appId, 'failed'); return; }
            const again = appsDb.get(appId);
            if (again) startDeploy(actor, again);
          },
        });
      })
      .catch((err) => {
        say(`[Sampanna Cloud] Could not prepare the main server: ${err.message}`);
        db.prepare("UPDATE deployments SET status = 'failed', log = ?, finished_at = ? WHERE id = ?").run(log, Date.now(), depId);
        busy.delete(a.id);
        appsDb.setStatus(appId, 'failed');
        emitApp(a);
      });
  }


  router.post('/apps/:id/runtime', wrap(async (req, res) => {
    const a = mineApp(req);
    needReady(a);
    if (busy.has(a.id)) throw conflict('Another task for this app is still running');
    const depId = runRecorded(req, a, 'runtime', RUNTIME_SCRIPT, { RUNTIMES: runtimesFor(a) }, { timeoutMs: 20 * 60_000 });
    res.status(202).json({ deploymentId: depId });
  }));

  for (const op of ['start', 'stop', 'restart']) {
    router.post(`/apps/:id/${op}`, wrap(async (req, res) => {
      const a = mineApp(req);
      needReady(a);
      if (busy.has(a.id)) throw conflict('Another task for this app is still running');
      const depId = runRecorded(req, a, op, PM2_SCRIPT, { OP: op, APP_NAME: a.name, REMOVE_FILES: '0' }, {
        timeoutMs: 120_000, onFinish: (ok) => { if (ok) appsDb.setStatus(a.id, op === 'stop' ? 'stopped' : 'running'); },
      });
      res.status(202).json({ deploymentId: depId });
    }));
  }

  router.get('/apps/:id/logs', wrap(async (req, res) => {
    const a = mineApp(req);
    needReady(a);
    const r = await execApp(a, PM2_SCRIPT, { OP: 'logs', APP_NAME: a.name, REMOVE_FILES: '0' }, { timeoutMs: 30_000 });
    res.set('Cache-Control', 'no-store');
    res.json({ text: r.output });
  }));

  // Live PM2 state for every app on one server
  router.get('/servers/:name/pm2', wrap(async (req, res) => {
    const name = req.params.name;
    if (!ownsContainer(req.session, name) || !containers.exists(name)) throw forbidden('You can only see your own servers');
    needRunning(name);
    const r = await execStream(name, ['bash', '-c', PM2_SCRIPT], { env: { ...runAs(name), OP: 'status', APP_NAME: 'x', REMOVE_FILES: '0' }, timeoutMs: 30_000 });
    let list = [];
    try { list = JSON.parse(r.output.slice(r.output.indexOf('['))); } catch { list = []; }
    res.set('Cache-Control', 'no-store');
    res.json({
      installed: r.code === 0,
      processes: list.map((p) => ({
        name: p.name, status: p.pm2_env?.status, cpu: p.monit?.cpu ?? 0, memory: p.monit?.memory ?? 0,
        restarts: p.pm2_env?.restart_time ?? 0, uptime: p.pm2_env?.pm_uptime ?? null,
      })),
    });
  }));

  // Super admin: move an app to another target of the SAME owner (main server <-> their VPS <-> their cloud server).
  // The old copy is stopped and its process entry removed (files kept there), then the app is deployed at the new place.
  router.post('/apps/:id/move', requireSuperAdmin, wrap(async (req, res) => {
    const a = mineApp(req);
    if (busy.has(a.id)) throw conflict('Wait for the running task to finish');
    const b = req.body ?? {};
    const owner = users.byId(a.user_id);
    let next;
    if (b.target === 'main') {
      if (owner.role !== 'user') throw bad('Only customer apps can move to the main server');
      const host = appHost.hostNameFor(owner.username);
      const pkg = appHost.packageOf(owner.id) || (b.planId ? plans.get(int(b.planId, { min: 1, max: 1e9, name: 'Package' })) : null);
      if (!pkg || pkg.kind !== 'app') throw bad(`${owner.username} has no hosting package: pick one (planId)`);
      const count = db.prepare("SELECT COUNT(*) AS n FROM apps WHERE container = ? AND target = 'main'").get(host).n;
      if (pkg.max_apps != null && count >= pkg.max_apps) throw conflict(`${owner.username}'s ${pkg.name} package is full (${pkg.max_apps} apps)`);
      next = { target: 'main', container: host, server_id: null, plan: pkg };
    } else if (b.target === 'vps') {
      const srv = customerServers.get(int(b.serverId, { min: 1, max: 1e9, name: 'VPS' }));
      if (!srv || srv.user_id !== a.user_id) throw bad('Pick a VPS of the same customer');
      next = { target: 'vps', container: `vps-${srv.id}`, server_id: srv.id };
    } else if (b.target === 'server') {
      const container = str(b.container, { max: 63, name: 'Server' });
      if (!containers.exists(container) || appHost?.isAppHost(container) || !users.ownersOf(container).some((u) => u.id === a.user_id)) throw bad("Pick one of the customer's cloud servers");
      next = { target: 'server', container, server_id: null };
    } else throw bad('Target must be main, vps or server');
    if (next.container === a.container) throw bad('The app is already there');
    if (db.prepare('SELECT 1 FROM apps WHERE container = ? AND name = ?').get(next.container, a.name)) throw conflict(`An app named ${a.name} already exists there`);
    const used = new Set(db.prepare('SELECT port FROM apps WHERE container = ?').all(next.container).map((r) => r.port));
    let port = a.port;
    while (used.has(port)) port += 1;

    // 1. take it down where it is (best effort; files stay)
    const off = await execApp(a, PM2_SCRIPT, { OP: 'delete', APP_NAME: a.name, REMOVE_FILES: '0' }, { timeoutMs: 60_000 }).catch((err) => ({ code: -1, output: err.message }));
    await dropForwards(a);
    for (const d of db.prepare("SELECT * FROM domains WHERE app_id = ? AND requested_by = 'auto'").all(a.id)) {
      if (d.route_synced && cfConfigured()) await removeRoute(d.hostname.toLowerCase(), d.dns_record_id).catch(() => {});
      db.prepare('DELETE FROM domains WHERE id = ?').run(d.id);
    }
    // 2. point the row at the new place
    db.prepare('UPDATE apps SET target = ?, container = ?, server_id = ?, port = ?, forwarded_port = NULL, status = ?, updated_at = ? WHERE id = ?')
      .run(next.target, next.container, next.server_id, port, next.target === 'main' ? 'provisioning' : 'new', Date.now(), a.id);
    if (next.target === 'main' && !appHost.packageOf(owner.id)) {
      db.prepare('UPDATE users SET hosting_plan_id = ? WHERE id = ?').run(next.plan.id, owner.id);
      billing?.start({ userId: owner.id, kind: 'app', name: next.container, planId: next.plan.id, priceDay: next.plan.price_day, by: req.session.username });
    }
    if (a.target === 'main' && !db.prepare("SELECT 1 FROM apps WHERE container = ? AND target = 'main'").get(a.container)) {
      billing?.end('app', a.container, req.session.username);
      db.prepare('UPDATE users SET hosting_plan_id = NULL WHERE id = ?').run(owner.id);
      appHost?.release(a.container).catch((err) => console.error(`App host ${a.container}: ${err.message}`));
    }
    audit.log({ ...who(req), action: 'app_move', target: `${a.container}/${a.name}`, result: 'success', detail: `-> ${next.target} ${next.container}, port ${port}${off.code === 0 ? '' : '; old copy not reached'}` });
    // 3. bring it up there
    const moved = appsDb.get(a.id);
    if (next.target === 'main') provision(who(req), owner, a.id);
    else if (next.target === 'vps' || containers.snapshot(next.container)?.status === 'Running') startDeploy(req, moved);
    res.json({ app: publicApp(appsDb.get(a.id)), oldCopyStopped: off.code === 0 });
  }));

  // Removes the app's proxy devices (current and previously forwarded port) unless another app in the container uses
  // that port. Best effort: returns a note for the user instead of failing the delete or the move.
  async function dropForwards(a) {
    if (!onLxd(a) || !forwardingEnabled() || !containers.exists(a.container)) return '';
    const failed = [];
    for (const p of new Set([a.forwarded_port, a.port].filter(Boolean))) {
      if (otherAppUses(a.container, p, a.id)) continue;
      await removeForward(a.container, p).catch((err) => failed.push(`port${p} (${err.message})`));
    }
    return failed.length ? ` The proxy device ${failed.join(', ')} could not be removed.` : '';
  }

  router.delete('/apps/:id', wrap(async (req, res) => {
    const a = mineApp(req);
    if (req.body?.confirm !== a.name) throw bad(`Type "${a.name}" to confirm`);
    if (busy.has(a.id)) throw conflict('Wait for the running task to finish');
    const doms = db.prepare("SELECT hostname FROM domains WHERE app_id = ? AND status NOT IN ('removed', 'rejected') AND requested_by != 'auto'").all(a.id);
    if (doms.length) throw conflict(`Remove its domains first: ${doms.map((d) => d.hostname).join(', ')}`);
    // The automatic subdomain belongs to the app and goes with it
    for (const d of db.prepare("SELECT * FROM domains WHERE app_id = ? AND requested_by = 'auto'").all(a.id)) {
      if (d.route_synced) {
        if (!cfConfigured()) throw conflict(`${d.hostname} is live but the Cloudflare API is not configured, so it cannot be removed from here`);
        await removeRoute(d.hostname.toLowerCase(), d.dns_record_id);
      }
      db.prepare('DELETE FROM domains WHERE id = ?').run(d.id);
      audit.log({ ...who(req), action: 'domain_remove', target: d.hostname, result: 'success', detail: 'automatic domain of a deleted app' });
    }
    let note = '';
    if (a.target === 'vps') {
      const r = await execApp(a, PM2_SCRIPT, { OP: 'delete', APP_NAME: a.name, REMOVE_FILES: req.body?.removeFiles === true ? '1' : '0' }, { timeoutMs: 60_000 })
        .catch((err) => ({ code: -1, output: err.message }));
      if (r.code !== 0) note = ` Your VPS could not be reached (${r.output.slice(-120)}), so the app may still be running there.`;
    } else if (containers.snapshot(a.container)?.status === 'Running') {
      const r = await execApp(a, PM2_SCRIPT, { OP: 'delete', APP_NAME: a.name, REMOVE_FILES: req.body?.removeFiles === true ? '1' : '0' }, { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`Could not stop the app in the server: ${r.output.slice(-300)}`);
    } else {
      note = ' The server was stopped, so its PM2 entry and files were left in place.';
    }
    note += await dropForwards(a);
    db.prepare('DELETE FROM apps WHERE id = ?').run(a.id);
    if (a.target === 'main' && !db.prepare("SELECT 1 FROM apps WHERE container = ? AND target = 'main'").get(a.container)) {
      // Last app gone: the package ends (no paying for an empty host) and the host is removed
      billing?.end('app', a.container, req.session.username);
      db.prepare('UPDATE users SET hosting_plan_id = NULL WHERE id = ?').run(a.user_id);
      appHost?.release(a.container).catch((err) => console.error(`App host ${a.container}: ${err.message}`));
      note += ' That was your last app on the main server, so your hosting package ended and billing stopped.';
    }
    audit.log({ ...who(req), action: 'app_delete', target: `${a.container}/${a.name}`, result: 'success', detail: req.body?.removeFiles ? 'files removed' : 'files kept' });
    res.json({ ok: true, note });
  }));

  return { router, appsDb, setOnDeployed: (fn) => { onDeployed = fn; } };
}
export const SCRIPTS = { RUNTIME_SCRIPT, DEPLOY_SCRIPT, PM2_SCRIPT }; // for tests
