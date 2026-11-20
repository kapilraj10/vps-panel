// The fixed shell scripts in apps.js: they parse, and the deploy script really deploys a git repo as a NON-ROOT user
// (the customer-VPS case: apps under ~/apps) with a stub pm2 / docker on PATH. No network, no root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-scripts-'));
process.env.DB_PATH = path.join(tmp, 'panel.db');
process.env.SESSION_SECRET = 's'.repeat(64);
const { SCRIPTS } = await import('../apps.js');
const { shQuote } = await import('../sshexec.js');
const HOME = path.join(tmp, 'home');
const BIN = path.join(tmp, 'bin');
const LOG = path.join(tmp, 'calls.log');
fs.mkdirSync(HOME);
fs.mkdirSync(BIN);
for (const tool of ['pm2', 'docker']) fs.writeFileSync(path.join(BIN, tool), `#!/bin/sh\necho "${tool} $*" >> ${LOG}\n[ "$1" = jlist ] && echo '[]'\nexit 0\n`, { mode: 0o755 });

const repo = path.join(tmp, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'server.js'), 'console.log("hi")\n');
fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM node:22-alpine\n');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
execFileSync('git', ['-C', repo, 'add', '.'], { env: gitEnv });
execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'], { env: gitEnv });

// Same as sshexec.runScript: exports on stdin, then the script, through `bash -s`
function run(script, env) {
  const input = `${Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}`).join('\n')}\n${script}\n`;
  return spawnSync('bash', ['-s'], { input, encoding: 'utf8', env: { PATH: `${BIN}:${process.env.PATH}`, HOME } });
}
const b64 = (s) => Buffer.from(s).toString('base64');
const base = (name, extra = {}) => ({
  APP_NAME: name, REPO: repo, BRANCH: 'main', ROOT_DIR: '', PORT: '3000', INSTALL_CMD: 'echo installing > installed.txt', BUILD_CMD: '', GIT_TOKEN: '',
  ENV_SH_B64: b64("export SECRET='a b'\n"), DOTENV_B64: b64('SECRET="a b"\n'), DOCKERENV_B64: b64('SECRET=a b\n'),
  ECOSYSTEM_B64: b64(JSON.stringify({ apps: [{ name, cwd: `__APPS_ROOT__/${name}` }] })), WRITE_DOTENV: '1', ...extra,
});

test('every script parses', () => {
  for (const [k, s] of Object.entries(SCRIPTS)) assert.equal(spawnSync('bash', ['-n'], { input: s }).status, 0, k);
});

test('deploy as a non-root user: clone into ~/apps, env files private, PM2 started with the real path', { skip: process.getuid() === 0 && 'running as root' }, () => {
  const r = run(SCRIPTS.DEPLOY_SCRIPT, base('shop'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /@@COMMIT [0-9a-f]{40}/);
  const app = path.join(HOME, 'apps', 'shop');
  assert.ok(fs.existsSync(path.join(app, 'installed.txt')), 'install command ran in the app folder');
  assert.equal(fs.readFileSync(path.join(app, '.env'), 'utf8'), 'SECRET="a b"\n');
  const cfg = path.join(HOME, 'apps', '.kapilcloud', 'shop');
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(cfg, '.env')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'ecosystem.json'), 'utf8')).apps[0].cwd, path.join(HOME, 'apps', 'shop'));
  assert.match(fs.readFileSync(LOG, 'utf8'), /pm2 start .*\.kapilcloud\/shop\/ecosystem\.json/);
  // redeploy = fetch + reset, not a second clone
  assert.equal(run(SCRIPTS.DEPLOY_SCRIPT, base('shop')).status, 0);
});

test('docker app: build + run with the env file, no PM2', { skip: process.getuid() === 0 && 'running as root' }, () => {
  fs.writeFileSync(LOG, '');
  const r = run(SCRIPTS.DEPLOY_SCRIPT, base('api', { APP_KIND: 'docker', PORT: '8080', DOCKER_MEMORY: '512m' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = fs.readFileSync(LOG, 'utf8');
  assert.match(calls, /docker build -t sc-app-api \./);
  assert.match(calls, /docker run -d --name sc-app-api --restart unless-stopped --env-file .*docker\.env -e PORT=8080 -p 8080:8080 --memory 512m --security-opt no-new-privileges sc-app-api/);
  assert.ok(!/pm2 start/.test(calls));
  const st = run(SCRIPTS.PM2_SCRIPT, { APP_KIND: 'docker', OP: 'status', APP_NAME: 'api', REMOVE_FILES: '0' });
  assert.equal(JSON.parse(st.stdout)[0].name, 'api');
});

test('a value with quotes and $() stays a plain value (no injection)', { skip: process.getuid() === 0 && 'running as root' }, () => {
  const evil = "x'; touch " + path.join(tmp, 'pwned') + "; echo '$(touch " + path.join(tmp, 'pwned2') + ')';
  const r = run(SCRIPTS.DEPLOY_SCRIPT, base('evil', { BRANCH: evil }));
  assert.notEqual(r.status, 0, 'no such branch');
  assert.ok(!fs.existsSync(path.join(tmp, 'pwned')) && !fs.existsSync(path.join(tmp, 'pwned2')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('customer servers must be on the public internet', async () => {
  const { isPublicIp, resolvePublic } = await import('../sshexec.js');
  for (const ip of ['10.10.10.31', '127.0.0.1', '192.168.1.5', '172.16.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['1.1.1.1', '203.0.114.9', '2606:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
  delete process.env.CUSTOMER_SSH_ALLOW_PRIVATE;
  await assert.rejects(resolvePublic('127.0.0.1'), /private or reserved/);
  await assert.rejects(resolvePublic('localhost'), /private or reserved/);
});
