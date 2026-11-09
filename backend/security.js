// Security center: host firewall (UFW), fail2ban, panel login blocks and a security check.
// Everything privileged goes through ONE root helper (/usr/local/sbin/kapil-security, source system/kapil-security)
// run with `sudo -n`; /etc/sudoers.d/kapil-security allows exactly that file. Admins read, only a super admin changes.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { audit, db, users, settings } from './db.js';
import { requireAdmin, requireSuperAdmin, clientIp, loginLimit, COOKIE_SECURE } from './auth.js';
import { wrap, bad, HttpError } from './http.js';

const HELPER = () => process.env.SECURITY_HELPER || '/usr/local/sbin/kapil-security';
const SUDO_PROBLEM = /a password is required|a terminal is required|not allowed to execute|may not run sudo|not in the sudoers|command not found|No such file/i;
const NOT_INSTALLED = 'The security helper is not installed yet. On the server run: sudo bash <panel folder>/system/install-security.sh --tools';

// Runs the helper (through sudo unless SECURITY_SUDO=off, for tests) and returns its @@RESULT object
export function securityHelper(args, timeout = 90_000) {
  const direct = process.env.SECURITY_SUDO === 'off';
  const [cmd, argv] = direct ? [HELPER(), args] : ['sudo', ['-n', HELPER(), ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (d) => { if (out.length < 2_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200_000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new HttpError(503, e.code === 'ENOENT' ? NOT_INSTALLED : `Cannot run the security helper: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const res = out.split('\n').reverse().find((l) => l.startsWith('@@RESULT '));
      if (code === 0 && res) { try { return resolve(JSON.parse(res.slice(9))); } catch { /* fall through */ } }
      const msg = err.split('\n').reverse().find((l) => l.startsWith('@@ERROR '))?.slice(8);
      if (msg) return reject(new HttpError(code === 2 ? 400 : 502, msg));
      if (SUDO_PROBLEM.test(err)) return reject(new HttpError(503, NOT_INSTALLED));
      return reject(new HttpError(502, err.trim().split('\n').pop() || `Security helper failed (exit ${code})`));
    });
  });
}

// Checks the panel can make about itself, without root
function panelChecks() {
  const checks = [];
  const add = (id, title, status, detail, fix = null) => checks.push({ id, title, status, detail, fix });
  const envFile = process.env.DOTENV_CONFIG_PATH || path.join(process.cwd(), '.env');
  try {
    const mode = fs.statSync(envFile).mode & 0o777;
    add('env_mode', 'Panel .env permissions', mode & 0o077 ? 'bad' : 'ok', `${envFile} is ${mode.toString(8)}`, mode & 0o077 ? `chmod 600 ${envFile}` : null);
  } catch { add('env_mode', 'Panel .env permissions', 'info', 'no .env file found next to the panel'); }
  const host = process.env.HOST || '127.0.0.1';
  add('panel_bind', 'Panel listens on', host === '127.0.0.1' || host === '::1' ? 'ok' : 'bad', host,
    host === '127.0.0.1' ? null : 'Set HOST=127.0.0.1 so the panel is reachable only through the tunnel (the login rate limit trusts CF-Connecting-IP)');
  add('cookie_secure', 'Secure cookies', COOKIE_SECURE ? 'ok' : 'bad', COOKIE_SECURE ? 'on' : 'COOKIE_SECURE=false', COOKIE_SECURE ? null : 'Set COOKIE_SECURE=true (HTTPS through Cloudflare)');
  add('secrets_key', 'Encryption key for saved secrets', /^[0-9a-f]{64}$/i.test(process.env.SECRETS_KEY || '') ? 'ok' : 'warn',
    process.env.SECRETS_KEY ? 'SECRETS_KEY set' : 'derived from SESSION_SECRET', 'Optional: set SECRETS_KEY (64 hex). Only before secrets are saved, or they become unreadable.');
  const admins = db.prepare("SELECT id, username FROM users WHERE role IN ('admin', 'super_admin') AND status = 'active'").all();
  const without = admins.filter((u) => !users.twoFactor(u.id)?.totp_enabled_at).map((u) => u.username);
  add('admin_2fa', 'Two-factor login for admins', without.length ? (settings.get('require_2fa_admins') ? 'warn' : 'bad') : 'ok',
    without.length ? `without 2FA: ${without.join(', ')}` : `all ${admins.length} admins use it`, without.length ? 'Security → Two-factor login (each admin), then Settings → require it' : null);
  add('staging', 'Staging mode', process.env.STAGING_MODE === '1' ? 'warn' : 'ok', process.env.STAGING_MODE === '1' ? 'STAGING_MODE=1: monitoring, domain repair, replicas and fleet loops are off' : 'off',
    process.env.STAGING_MODE === '1' ? 'Remove STAGING_MODE from the .env of the main panel' : null);
  const fails = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'login' AND result = 'failure' AND ts > ?").get(Date.now() - 86400_000).n;
  add('login_failures', 'Failed panel logins (24 h)', fails > 50 ? 'warn' : 'ok', String(fails));
  return checks;
}

export function createSecurity() {
  const router = express.Router();
  const log = (req, action, target, detail = null, result = 'success') => audit.log({ username: req.session.username, ip: clientIp(req), action, target, result, detail });
  // Run a helper change and audit it either way
  const change = async (req, action, target, args) => {
    try {
      const r = await securityHelper(args);
      log(req, action, target, args.join(' '));
      return r;
    } catch (e) {
      log(req, action, target, `${args.join(' ')}: ${e.message}`, 'failure');
      throw e;
    }
  };

  router.use(requireAdmin);

  router.get('/status', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let host = null;
    let error = null;
    try { host = await securityHelper(['status'], 30_000); } catch (e) { error = e.message; }
    res.json({ host, error, panelLogins: loginLimit.list() });
  }));

  router.get('/check', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let host = null;
    let error = null;
    try { host = await securityHelper(['check'], 120_000); } catch (e) { error = e.message; }
    res.json({ checks: [...panelChecks(), ...(host?.checks || [])], listening: host?.listening || [], error, at: Date.now() });
  }));

  router.post('/firewall/rules', requireSuperAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    if (!['allow', 'deny', 'limit'].includes(b.action)) throw bad('Action must be allow, deny or limit');
    const args = ['ufw-rule', b.action, String(b.port ?? ''), String(b.from || 'any'), ...(b.comment ? [String(b.comment)] : [])];
    res.json(await change(req, 'firewall_rule_add', `${b.action} ${b.port}`, args));
  }));
  router.delete('/firewall/rules/:num', requireSuperAdmin, wrap(async (req, res) => {
    if (!/^\d{1,4}$/.test(req.params.num)) throw bad('Bad rule number');
    res.json(await change(req, 'firewall_rule_delete', `rule ${req.params.num}`, ['ufw-delete', req.params.num]));
  }));
  router.post('/firewall/enable', requireSuperAdmin, wrap(async (req, res) => res.json(await change(req, 'firewall_enable', 'ufw', ['ufw-enable']))));
  router.post('/firewall/disable', requireSuperAdmin, wrap(async (req, res) => {
    if (req.body?.confirm !== 'disable') throw bad('Type "disable" to confirm');
    res.json(await change(req, 'firewall_disable', 'ufw', ['ufw-disable']));
  }));

  router.post('/fail2ban/:action(ban|unban)', requireSuperAdmin, wrap(async (req, res) => {
    const { jail, ip } = req.body || {};
    res.json(await change(req, `fail2ban_${req.params.action}`, `${jail} ${ip}`, [`f2b-${req.params.action}`, String(jail || ''), String(ip || '')]));
  }));

  // Panel login blocks are in memory (they also clear when the panel restarts)
  router.delete('/panel-logins/:ip', requireSuperAdmin, (req, res) => {
    const ip = String(req.params.ip).slice(0, 64);
    const had = loginLimit.clear(ip);
    log(req, 'login_block_clear', ip, had ? null : 'was not blocked');
    res.json({ ok: true });
  });

  return { router };
}
