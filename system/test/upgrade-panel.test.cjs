// Runs the real upgrade-panel.sh against a throwaway HOME, with stub pm2/npm and tiny HTTP servers as the "panel".
// No root, network or real PM2 needed.  node --test 'system/test/*.test.cjs'
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'upgrade-panel.sh');

// The stand-in panel: reads .env from its working directory like dotenv, and says which version it is.
const PANEL = (version, { healthy = true } = {}) => `
const fs = require('fs'), http = require('http');
const env = Object.fromEntries(fs.readFileSync(process.env.DOTENV_CONFIG_PATH || '.env', 'utf8').split('\\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
${healthy ? '' : "console.error('boom: broken release'); process.exit(1);"}
const dbFile = env.DB_PATH || 'data/panel.db';
fs.mkdirSync(require('path').dirname(dbFile), { recursive: true }); fs.appendFileSync(dbFile, 'started ${version}\\n');
http.createServer((req, res) => {
  if (req.url === '/version') return res.end('${version}');
  if (req.url === '/healthz') return res.end('{"ok":true,"lxd":true}');
  res.end('login');
}).listen(Number(env.PORT), '127.0.0.1');
`;

// Stub pm2: JSON state, really starts/stops processes. One extra app proves others are never touched.
const PM2 = `#!/usr/bin/env node
const fs = require('fs'), { spawn } = require('child_process');
const F = process.env.PM2_STATE;
const s = JSON.parse(fs.readFileSync(F, 'utf8'));
const log = (x) => fs.appendFileSync(F + '.log', x + '\\n');
const [cmd, name] = process.argv.slice(2);
log(process.argv.slice(2).join(' '));
const p = s.procs.find((x) => x.name === name);
const kill = () => { try { if (p.pid) process.kill(p.pid, 'SIGKILL'); } catch {} p.pid = 0; p.status = 'stopped'; };
const up = () => {
  const out = fs.openSync(F + '.out', 'a');
  const c = spawn(process.execPath, [p.script], { cwd: p.cwd, env: { ...process.env, ...(p.dotenv ? { DOTENV_CONFIG_PATH: p.dotenv } : {}) }, detached: true, stdio: ['ignore', out, out] });
  c.unref(); p.pid = c.pid; p.status = 'online';
};
if (cmd === 'jlist') console.log(JSON.stringify(s.procs.map((x) => ({ name: x.name, pm2_env: { pm_cwd: x.cwd, pm_exec_path: x.script, status: x.status, DOTENV_CONFIG_PATH: x.dotenv } }))));
else if (cmd === 'stop') kill();
else if (cmd === 'restart') { if (p.pid) kill(); up(); }
else if (cmd === 'logs') console.log('fake log');
fs.writeFileSync(F, JSON.stringify(s));
`;

// Stub npm: "installs" a fake better-sqlite3 (or fails when NPM_FAIL is set).
const NPM = `#!/usr/bin/env bash
[ -z "\${NPM_FAIL:-}" ] || { echo "npm ERR! simulated" >&2; exit 1; }
mkdir -p node_modules/better-sqlite3
cat > node_modules/better-sqlite3/index.js <<'JS'
module.exports = class { close() {} prepare() { return { get: () => (process.env.FAKE_MIGRATED ? {} : undefined) }; } };
JS
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
};

async function setup(t, { release = PANEL('new'), envExtra = '', external = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-test-'));
  const port = await freePort();
  const app = path.join(home, 'vps-panel');
  const rel = path.join(home, 'vps-panel-release');
  const bin = path.join(home, 'bin');
  write(path.join(bin, 'pm2'), PM2, 0o755);
  write(path.join(bin, 'npm'), NPM, 0o755);

  // Old install
  write(path.join(app, 'backend/server.js'), PANEL('old'));
  const extDir = path.join(home, 'ext');
  const envFile = external ? path.join(extDir, 'staging.env') : path.join(app, 'backend/.env');
  const dbFile = external ? path.join(extDir, 'data/panel.db') : path.join(app, 'backend/data/panel.db');
  const dbLine = external ? `DB_PATH=${dbFile}\nSTAGING_MODE=1\n` : '';
  write(envFile, `PORT=${port}\nHOST=127.0.0.1\nSESSION_SECRET=keep-this-secret\nINGEST_TOKEN=keep-this-token\n${dbLine}${envExtra}`, 0o600);
  write(dbFile, 'old-data\n');
  write(path.join(app, 'backend/only-in-old.txt'), 'x');
  write(path.join(app, 'VERSION'), 'old\n');

  // New release (the real script, so the copy that ends up installed works too)
  write(path.join(rel, 'backend/server.js'), release);
  write(path.join(rel, 'backend/package-lock.json'), '{}');
  write(path.join(rel, 'frontend/dist/index.html'), 'i');
  write(path.join(rel, 'frontend/dist/login.html'), 'l');
  write(path.join(rel, 'system/panel-backup'), 'helper');
  fs.mkdirSync(path.join(rel, 'system'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(rel, 'system/upgrade-panel.sh'));
  write(path.join(rel, 'VERSION'), 'new\n');

  const state = path.join(home, 'pm2.json');
  const procs = [{ name: 'vps-panel', cwd: path.join(app, 'backend'), script: path.join(app, 'backend/server.js'), status: 'stopped', pid: 0, dotenv: external ? envFile : undefined },
    { name: 'other-app', cwd: home, script: path.join(home, 'other.js'), status: 'online', pid: 0 }];
  fs.writeFileSync(state, JSON.stringify({ procs }));

  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PM2_STATE: state, HEALTH_WAIT: '8', PANEL_DOMAIN: '', USER: 'tester' };
  const run = (args = [], { input = '', extraEnv = {} } = {}) => spawnSync('bash', [path.join(rel, 'system/upgrade-panel.sh'), ...args], { env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 60000 });
  spawnSync(path.join(bin, 'pm2'), ['restart', 'vps-panel'], { env });

  const get = async (p) => {
    for (let i = 0; i < 40; i++) {
      try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).text(); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error(`panel not answering on ${p}`);
  };
  t.after(() => {
    const s = JSON.parse(fs.readFileSync(state, 'utf8'));
    for (const p of s.procs) { try { if (p.pid) process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await get('/version');
  const pm2Log = () => fs.readFileSync(`${state}.log`, 'utf8');
  const kept = (kind) => fs.readdirSync(home).filter((n) => n.startsWith(`vps-panel.${kind}-`));
  return { home, port, app, rel, run, get, pm2Log, kept, envFile, dbFile };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const out = (r) => `${r.stdout}\n${r.stderr}`;

test('upgrade: new code, same port, same .env, same data, other apps untouched', async (t) => {
  const s = await setup(t);
  const r = s.run();
  assert.equal(r.status, 0, out(r));
  assert.equal(await s.get('/version'), 'new');
  assert.equal(read(path.join(s.app, 'VERSION')).trim(), 'new');

  const env = read(path.join(s.app, 'backend/.env'));
  assert.match(env, new RegExp(`^PORT=${s.port}$`, 'm'));
  assert.match(env, /^SESSION_SECRET=keep-this-secret$/m);
  assert.match(env, /^INGEST_TOKEN=keep-this-token$/m);
  assert.match(env, /^SECRETS_KEY=[0-9a-f]{64}$/m);
  assert.equal(fs.statSync(path.join(s.app, 'backend/.env')).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes('keep-this-secret'), 'secrets are never printed');

  const db = read(path.join(s.app, 'backend/data/panel.db'));
  assert.match(db, /^old-data$/m);
  assert.match(db, /started new/);

  assert.ok(!fs.existsSync(path.join(s.app, 'backend/only-in-old.txt')), 'old code is gone from the live folder');
  assert.match(r.stdout, /only-in-old\.txt/, 'files that would be lost are listed');
  assert.equal(s.kept('old').length, 1);
  assert.equal(s.kept('new').length, 0, 'no staging folder left');

  const log = s.pm2Log();
  assert.match(log, /^save$/m);
  assert.ok(!log.includes('other-app'), 'other PM2 apps are not touched');
  assert.ok(fs.readdirSync(path.join(s.home, 'panel-predeploy')).length === 1, 'pre-upgrade state saved');
});

test('an empty SECRETS_KEY= line is filled, not duplicated', async (t) => {
  const s = await setup(t, { envExtra: 'SECRETS_KEY=\n' });
  const r = s.run();
  assert.equal(r.status, 0, out(r));
  const env = read(path.join(s.app, 'backend/.env'));
  assert.equal(env.match(/^SECRETS_KEY=/gm).length, 1);
  assert.match(env, /^SECRETS_KEY=[0-9a-f]{64}$/m);
});

test('a database that already ran Kapil Cloud does not get a new SECRETS_KEY', async (t) => {
  const s = await setup(t);
  const r = s.run([], { extraEnv: { FAKE_MIGRATED: '1' } });
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(read(path.join(s.app, 'backend/.env')), /^SECRETS_KEY=/m);
});

test('broken new version: old version and old data come back by themselves', async (t) => {
  const s = await setup(t, { release: PANEL('new', { healthy: false }) });
  const r = s.run();
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stdout, /old version is running again/);
  assert.equal(await s.get('/version'), 'old');
  assert.equal(read(path.join(s.app, 'VERSION')).trim(), 'old');
  assert.match(read(path.join(s.app, 'backend/.env')), /^SESSION_SECRET=keep-this-secret$/m);
  assert.equal(s.kept('failed').length, 1);
  assert.equal(s.kept('old').length, 0);
});

test('npm failure: the old version never stops', async (t) => {
  const s = await setup(t);
  const r = s.run([], { extraEnv: { NPM_FAIL: '1' } });
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stdout, /Nothing was changed/);
  assert.equal(await s.get('/version'), 'old');
  assert.ok(!s.pm2Log().includes('stop vps-panel'));
  assert.equal(s.kept('new').length, 0);
});

test('--check changes nothing', async (t) => {
  const s = await setup(t);
  const r = s.run(['--check']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Nothing was changed/);
  assert.equal(await s.get('/version'), 'old');
  assert.ok(!s.pm2Log().includes('stop vps-panel'));
  assert.equal(s.kept('old').length, 0);
});

test('another process on the port: aborts, restarts the old version', async (t) => {
  const s = await setup(t);
  // The stub panel ignores stop for this test: a second "panel" keeps the port after pm2 stop
  const impostor = path.join(s.home, 'impostor.js');
  // Free the port from the real one first, then hold it with a process PM2 does not know about
  spawnSync(path.join(s.home, 'bin/pm2'), ['stop', 'vps-panel'], { env: { ...process.env, PM2_STATE: path.join(s.home, 'pm2.json') } });
  fs.writeFileSync(impostor, `require('http').createServer((q, r) => r.end('impostor')).listen(${s.port}, '127.0.0.1')`);
  const child = spawn(process.execPath, [impostor], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 40 && (await s.get('/version')) !== 'impostor'; i++) await new Promise((res) => setTimeout(res, 50));

  const r = s.run();
  assert.notEqual(r.status, 0, out(r));
  assert.match(out(r), /Something else still answers/);
  assert.equal(read(path.join(s.app, 'VERSION')).trim(), 'old', 'old code still in place');
  assert.equal(s.kept('old').length, 0);
  assert.equal(s.kept('new').length, 0);
});

test('--rollback needs the typed word, then restores old code and old data', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  const script = path.join(s.app, 'system/upgrade-panel.sh');
  const env = { ...process.env, HOME: s.home, PATH: `${path.join(s.home, 'bin')}:${process.env.PATH}`, PM2_STATE: path.join(s.home, 'pm2.json'), HEALTH_WAIT: '8', PANEL_DOMAIN: '' };

  const no = spawnSync('bash', [script, '--rollback'], { env, input: 'no\n', encoding: 'utf8' });
  assert.notEqual(no.status, 0);
  assert.equal(await s.get('/version'), 'new');

  const yes = spawnSync('bash', [script, '--rollback'], { env, input: 'ROLLBACK\n', encoding: 'utf8' });
  assert.equal(yes.status, 0, out(yes));
  assert.equal(await s.get('/version'), 'old');
  assert.doesNotMatch(read(path.join(s.app, 'backend/data/panel.db')), /started new/);
  assert.equal(s.kept('rolledback').length, 1);
});

test('--cleanup needs the typed word, deletes old versions, keeps the saved .env + database', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  const script = path.join(s.app, 'system/upgrade-panel.sh');
  const env = { ...process.env, HOME: s.home, PATH: `${path.join(s.home, 'bin')}:${process.env.PATH}`, PM2_STATE: path.join(s.home, 'pm2.json'), HEALTH_WAIT: '8', PANEL_DOMAIN: '' };

  assert.notEqual(spawnSync('bash', [script, '--cleanup'], { env, input: 'nope\n', encoding: 'utf8' }).status, 0);
  assert.equal(s.kept('old').length, 1);

  const yes = spawnSync('bash', [script, '--cleanup'], { env, input: 'DELETE\n', encoding: 'utf8' });
  assert.equal(yes.status, 0, out(yes));
  assert.equal(s.kept('old').length, 0);
  assert.equal(await s.get('/version'), 'new');
  assert.equal(fs.readdirSync(path.join(s.home, 'panel-predeploy')).length, 1);
});

test('.env and database outside the panel folder stay there, and upgrade keeps their contents', async (t) => {
  const s = await setup(t, { external: true });
  const before = read(s.envFile);
  const r = s.run();
  assert.equal(r.status, 0, out(r));
  assert.equal(await s.get('/version'), 'new');
  assert.ok(!fs.existsSync(path.join(s.app, 'backend/.env')), 'no second .env appears');
  assert.ok(!fs.existsSync(path.join(s.app, 'backend/data')), 'no second database appears');
  assert.match(read(s.envFile), /^STAGING_MODE=1$/m);
  assert.ok(read(s.envFile).startsWith(before), 'existing settings are unchanged');
  assert.match(read(s.dbFile), /^old-data$/m);
  assert.match(read(s.dbFile), /started new/);
});

test('external database: a broken new version brings the old database back', async (t) => {
  const s = await setup(t, { external: true, release: PANEL('broken-migrates-then-dies') + 'setTimeout(() => process.exit(1), 300);' });
  const r = s.run();
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stdout, /old version is running again/);
  assert.equal(await s.get('/version'), 'old');
  assert.doesNotMatch(read(s.dbFile), /broken-migrates/);
});

test('external database: --rollback restores old code, .env and database', async (t) => {
  const s = await setup(t, { external: true });
  assert.equal(s.run().status, 0);
  const env = { ...process.env, HOME: s.home, PATH: `${path.join(s.home, 'bin')}:${process.env.PATH}`, PM2_STATE: path.join(s.home, 'pm2.json'), HEALTH_WAIT: '8', PANEL_DOMAIN: '' };
  const r = spawnSync('bash', [path.join(s.app, 'system/upgrade-panel.sh'), '--rollback'], { env, input: 'ROLLBACK\n', encoding: 'utf8' });
  assert.equal(r.status, 0, out(r));
  assert.equal(await s.get('/version'), 'old');
  assert.doesNotMatch(read(s.dbFile), /started new/);
});

test('refuses a DB_PATH folder that contains the panel', async (t) => {
  const s = await setup(t);
  fs.appendFileSync(path.join(s.app, 'backend/.env'), `DB_PATH=${path.join(s.home, 'panel.db')}\n`);
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(out(r), /DB_PATH/);
  assert.equal(await s.get('/version'), 'old');
});
