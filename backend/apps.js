// Applications: git deploys run INSIDE the owner's container through LXD exec, managed by PM2 there.
// The scripts below are fixed text; user values reach them only as environment variables, never spliced in.
// User build/start commands run as root inside the user's own container, which they already control fully
// through the terminal, so nothing here gives them more than they have. Nothing ever runs on the host.
import express from 'express';
import { db, audit, users } from './db.js';
import { execStream } from './lxd.js';
import { seal, open } from './secrets.js';
import { clientIp, isAdmin, ownsContainer } from './auth.js';
import { roomFor } from './containers.js';
import { wrap, bad, forbidden, notFound, conflict, int, str } from './http.js';

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
  laravel: { label: 'Laravel', install: 'composer install --no-dev --optimize-autoloader', build: 'php artisan config:cache', start: 'php artisan serve --host=0.0.0.0 --port="$PORT"', port: 8000 },
};

// ---------- scripts that run inside the container ----------
export const RUNTIME_SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
echo "==> Updating package lists"
apt-get update -q
PKGS="git curl ca-certificates nodejs npm"
case ",$RUNTIMES," in *,python,*) PKGS="$PKGS python3 python3-venv python3-pip";; esac
case ",$RUNTIMES," in *,php,*) PKGS="$PKGS php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-mysql composer unzip";; esac
echo "==> Installing: $PKGS"
apt-get install -y -q $PKGS
if ! command -v pm2 >/dev/null; then echo "==> Installing PM2"; npm install -g pm2; fi
echo "==> Making PM2 start on boot"
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
systemctl enable pm2-root >/dev/null 2>&1 || true
mkdir -p /srv/apps/.kapilcloud && chmod 700 /srv/apps/.kapilcloud
echo "==> Node $(node -v 2>/dev/null || echo missing), PM2 $(pm2 -v 2>/dev/null || echo missing)"
`;

const DEPLOY_SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || { echo "git is not installed in this server. Run 'Install runtime' first."; exit 20; }
command -v pm2 >/dev/null || { echo "PM2 is not installed in this server. Run 'Install runtime' first."; exit 21; }
APP_DIR="/srv/apps/$APP_NAME"
CFG="/srv/apps/.kapilcloud/$APP_NAME"
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
  echo "$APP_DIR exists and is not a git checkout. Move it away first; Kapil Cloud will not overwrite it."; exit 22
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
printf '%s' "$ECOSYSTEM_B64" | base64 -d > "$CFG/ecosystem.json"
chmod 600 "$CFG/env.sh" "$CFG/.env" "$CFG/ecosystem.json"
if [ "$WRITE_DOTENV" = "1" ]; then cp "$CFG/.env" "$WORK/.env"; chmod 600 "$WORK/.env"; fi
. "$CFG/env.sh"
export PORT
if [ -n "$INSTALL_CMD" ]; then echo "==> Install: $INSTALL_CMD"; bash -c "$INSTALL_CMD"; fi
if [ -n "$BUILD_CMD" ]; then echo "==> Build: $BUILD_CMD"; bash -c "$BUILD_CMD"; fi
echo "==> Starting with PM2"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start "$CFG/ecosystem.json"
pm2 save
echo "==> Deployed. Listening on port $PORT inside the server."
`;

const PM2_SCRIPT = `set -eu
command -v pm2 >/dev/null || { echo "PM2 is not installed in this server."; exit 21; }
case "$OP" in
  start) if pm2 describe "$APP_NAME" >/dev/null 2>&1; then pm2 start "$APP_NAME"; else pm2 start "/srv/apps/.kapilcloud/$APP_NAME/ecosystem.json"; fi ;;
  stop) pm2 stop "$APP_NAME" ;;
  restart) pm2 restart "$APP_NAME" --update-env ;;
  logs) pm2 logs "$APP_NAME" --nostream --lines 300 --raw 2>&1 || true; exit 0 ;;
  status) pm2 jlist; exit 0 ;;
  delete) pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
          rm -rf "/srv/apps/.kapilcloud/$APP_NAME"
          if [ "$REMOVE_FILES" = "1" ]; then rm -rf "/srv/apps/$APP_NAME"; fi ;;
esac
pm2 save >/dev/null 2>&1 || true
`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
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

export function createApps({ io, containers }) {
  const router = express.Router();
  const busy = new Map(); // appId -> deployment id
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });

  const publicApp = (a) => {
    let envKeys = [];
    try { envKeys = Object.keys(JSON.parse(open(a.env_enc) || '{}')); } catch { envKeys = []; }
    return {
      id: a.id, name: a.name, container: a.container, type: a.type, typeLabel: APP_TYPES[a.type]?.label || a.type,
      owner: a.owner || users.byId(a.user_id)?.username, repoUrl: a.repo_url, branch: a.branch, rootDir: a.root_dir || '',
      outputDir: a.output_dir || '', installCmd: a.install_cmd || '', buildCmd: a.build_cmd || '', startCmd: a.start_cmd || '',
      port: a.port, envKeys, hasGitToken: !!a.git_token_enc, status: a.status, lastDeployAt: a.last_deploy_at,
      deploying: busy.has(a.id), createdAt: a.created_at,
      domains: db.prepare("SELECT hostname, status FROM domains WHERE app_id = ? AND status != 'removed'").all(a.id),
    };
  };

  function mineApp(req) {
    const a = /^\d+$/.test(req.params.id) ? appsDb.get(Number(req.params.id)) : null;
    if (!a) throw notFound('No such application');
    if (!ownsContainer(req.session, a.container)) throw forbidden('You can only manage your own applications');
    return a;
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
    if (!t.static && !startCmd) throw bad('Start command is required');
    const port = int(b.port ?? existing?.port ?? t.port, { min: 1024, max: 65535, name: 'Port' });
    return { type, repo, branch, rootDir, outputDir, installCmd, buildCmd, startCmd, port };
  }

  function ecosystem(a, env) {
    const cwd = `/srv/apps/${a.name}${a.root_dir ? `/${a.root_dir}` : ''}`;
    const base = { name: a.name, cwd, env: { ...env, PORT: String(a.port), NODE_ENV: env.NODE_ENV || 'production' }, autorestart: true, max_restarts: 20 };
    if (APP_TYPES[a.type]?.static) {
      return { apps: [{ ...base, script: 'serve', env: { ...base.env, PM2_SERVE_PATH: `${cwd}/${a.output_dir || '.'}`, PM2_SERVE_PORT: String(a.port), PM2_SERVE_SPA: 'true' } }] };
    }
    return { apps: [{ ...base, script: 'bash', args: ['-c', a.start_cmd], interpreter: 'none' }] };
  }

  const emitLog = (a, depId, text) => io.to(['admin', roomFor(a.container)]).emit('app:log', { appId: a.id, deploymentId: depId, text });
  const emitApp = (a) => io.to(['admin', roomFor(a.container)]).emit('app:update', publicApp({ ...appsDb.get(a.id) }));

  // Runs a script in the container as a recorded deployment (deploy, runtime install, start/stop/restart)
  function runRecorded(req, a, kind, script, env, { timeoutMs = 30 * 60_000, onFinish = () => {} } = {}) {
    const { username, ip } = who(req);
    const depId = Number(db.prepare('INSERT INTO deployments (app_id, kind, by_user, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, kind, username, 'running', Date.now()).lastInsertRowid);
    busy.set(a.id, depId);
    if (kind === 'deploy') appsDb.setStatus(a.id, 'deploying');
    emitApp(a);
    audit.log({ username, ip, action: `app_${kind}`, target: `${a.container}/${a.name}`, result: 'requested' });
    let log = '';
    execStream(a.container, ['bash', '-c', script], {
      env, timeoutMs,
      onOutput: (text) => { log = (log + text).slice(-LOG_KEEP); emitLog(a, depId, text); },
    })
      .then(({ code }) => ({ ok: code === 0, code }))
      .catch((err) => { const msg = `\n[Kapil Cloud] ${err.message}\n`; log += msg; emitLog(a, depId, msg); return { ok: false, code: -1 }; })
      .then(({ ok, code }) => {
        const commit = /@@COMMIT ([0-9a-f]{40})/.exec(log)?.[1] || null;
        db.prepare('UPDATE deployments SET status = ?, log = ?, commit_sha = ?, finished_at = ? WHERE id = ?')
          .run(ok ? 'success' : 'failed', log, commit, Date.now(), depId);
        busy.delete(a.id);
        onFinish(ok);
        audit.log({ username, ip, action: `app_${kind}`, target: `${a.container}/${a.name}`, result: ok ? 'success' : 'failure', detail: ok ? commit : `exit code ${code}` });
        emitApp(a);
      });
    return depId;
  }

  // ---------- routes ----------
  router.get('/apps/types', (_req, res) => res.json({ types: Object.entries(APP_TYPES).map(([id, t]) => ({ id, ...t })) }));

  router.get('/apps', (req, res) => {
    const list = appsDb.list().filter((a) => ownsContainer(req.session, a.container));
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
    const container = str(b.container, { max: 63, name: 'Server' });
    if (!ownsContainer(req.session, container) || !containers.exists(container)) throw forbidden('Pick one of your servers');
    const name = str(b.name, { max: 32, name: 'App name' }).toLowerCase();
    if (!APP_NAME_RE.test(name)) throw bad('App name: 3-32 lowercase letters, digits or dashes');
    const v = validate(b);
    if (db.prepare('SELECT 1 FROM apps WHERE container = ? AND name = ?').get(container, name)) throw conflict(`${name} already exists on ${container}`);
    if (db.prepare('SELECT 1 FROM apps WHERE container = ? AND port = ?').get(container, v.port)) throw conflict(`Port ${v.port} is already used by another app on ${container}`);
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
    let envEnc = a.env_enc;
    if (b.env !== undefined) {
      // Values left as "********" keep their saved value, so secrets never have to travel back to the browser
      const old = JSON.parse(open(a.env_enc) || '{}');
      const next = parseEnv(b.env);
      for (const k of Object.keys(next)) if (next[k] === '********' && k in old) next[k] = old[k];
      envEnc = seal(JSON.stringify(next));
    }
    const tokenEnc = b.gitToken === '' ? null : b.gitToken ? seal(String(b.gitToken).slice(0, 500)) : a.git_token_enc;
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
    needRunning(a.container);
    if (busy.has(a.id)) throw conflict('A deployment for this app is already running');
    const env = JSON.parse(open(a.env_enc) || '{}');
    const envSh = `${Object.entries({ ...env, PORT: String(a.port) }).map(([k, v]) => `export ${k}=${shQuote(v)}`).join('\n')}\n`;
    const dotenv = `${Object.entries(env).map(([k, v]) => `${k}=${dotenvQuote(v)}`).join('\n')}\n`;
    const depId = runRecorded(req, a, 'deploy', DEPLOY_SCRIPT, {
      APP_NAME: a.name, REPO: a.repo_url, BRANCH: a.branch, ROOT_DIR: a.root_dir || '', PORT: String(a.port),
      INSTALL_CMD: a.install_cmd || '', BUILD_CMD: a.build_cmd || '', GIT_TOKEN: open(a.git_token_enc) || '',
      ENV_SH_B64: b64(envSh), DOTENV_B64: b64(dotenv), ECOSYSTEM_B64: b64(JSON.stringify(ecosystem(a, env), null, 2)),
      WRITE_DOTENV: req.body?.writeDotenv === false ? '0' : '1',
    }, {
      onFinish: (ok) => {
        appsDb.setStatus(a.id, ok ? 'running' : 'failed');
        if (ok) db.prepare('UPDATE apps SET last_deploy_at = ? WHERE id = ?').run(Date.now(), a.id);
      },
    });
    res.status(202).json({ deploymentId: depId });
  }));

  router.post('/apps/:id/runtime', wrap(async (req, res) => {
    const a = mineApp(req);
    needRunning(a.container);
    if (busy.has(a.id)) throw conflict('Another task for this app is still running');
    const runtimes = ['node', a.type === 'python' ? 'python' : null, a.type === 'laravel' ? 'php' : null].filter(Boolean).join(',');
    const depId = runRecorded(req, a, 'runtime', RUNTIME_SCRIPT, { RUNTIMES: runtimes }, { timeoutMs: 20 * 60_000 });
    res.status(202).json({ deploymentId: depId });
  }));

  for (const op of ['start', 'stop', 'restart']) {
    router.post(`/apps/:id/${op}`, wrap(async (req, res) => {
      const a = mineApp(req);
      needRunning(a.container);
      if (busy.has(a.id)) throw conflict('Another task for this app is still running');
      const depId = runRecorded(req, a, op, PM2_SCRIPT, { OP: op, APP_NAME: a.name, REMOVE_FILES: '0' }, {
        timeoutMs: 120_000, onFinish: (ok) => { if (ok) appsDb.setStatus(a.id, op === 'stop' ? 'stopped' : 'running'); },
      });
      res.status(202).json({ deploymentId: depId });
    }));
  }

  router.get('/apps/:id/logs', wrap(async (req, res) => {
    const a = mineApp(req);
    needRunning(a.container);
    const r = await execStream(a.container, ['bash', '-c', PM2_SCRIPT], { env: { OP: 'logs', APP_NAME: a.name, REMOVE_FILES: '0' }, timeoutMs: 30_000 });
    res.set('Cache-Control', 'no-store');
    res.json({ text: r.output });
  }));

  // Live PM2 state for every app on one server
  router.get('/servers/:name/pm2', wrap(async (req, res) => {
    const name = req.params.name;
    if (!ownsContainer(req.session, name) || !containers.exists(name)) throw forbidden('You can only see your own servers');
    needRunning(name);
    const r = await execStream(name, ['bash', '-c', PM2_SCRIPT], { env: { OP: 'status', APP_NAME: 'x', REMOVE_FILES: '0' }, timeoutMs: 30_000 });
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

  router.delete('/apps/:id', wrap(async (req, res) => {
    const a = mineApp(req);
    if (req.body?.confirm !== a.name) throw bad(`Type "${a.name}" to confirm`);
    if (busy.has(a.id)) throw conflict('Wait for the running task to finish');
    const doms = db.prepare("SELECT hostname FROM domains WHERE app_id = ? AND status NOT IN ('removed', 'rejected')").all(a.id);
    if (doms.length) throw conflict(`Remove its domains first: ${doms.map((d) => d.hostname).join(', ')}`);
    let note = '';
    if (containers.snapshot(a.container)?.status === 'Running') {
      const r = await execStream(a.container, ['bash', '-c', PM2_SCRIPT], {
        env: { OP: 'delete', APP_NAME: a.name, REMOVE_FILES: req.body?.removeFiles === true ? '1' : '0' }, timeoutMs: 60_000,
      });
      if (r.code !== 0) throw new Error(`Could not stop the app in the server: ${r.output.slice(-300)}`);
    } else {
      note = ' The server was stopped, so its PM2 entry and files were left in place.';
    }
    db.prepare('DELETE FROM apps WHERE id = ?').run(a.id);
    audit.log({ ...who(req), action: 'app_delete', target: `${a.container}/${a.name}`, result: 'success', detail: req.body?.removeFiles ? 'files removed' : 'files kept' });
    res.json({ ok: true, note });
  }));

  return { router, appsDb };
}
