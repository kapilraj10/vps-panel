// Backups page. Everything privileged goes through the root helper (/usr/local/sbin/panel-backup) via
// `sudo -n`, always with an argument array. Job records and logs are read straight from the helper's
// state folder (group-readable by the panel user) and mirrored into SQLite, so history, audit entries and
// live progress also cover runs the systemd timer started while the panel was down.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { audit, backupJobs } from './db.js';
import { clientIp } from './auth.js';

const HELPER = process.env.BACKUP_HELPER || '/usr/local/sbin/panel-backup';
const STATE_DIR = process.env.BACKUP_STATE_DIR || '/var/lib/panel-backup';
const JOBS_DIR = path.join(STATE_DIR, 'jobs');
const LOGS_DIR = path.join(STATE_DIR, 'logs');
const TIMER = 'panel-backup.timer';
const EXIT_BUSY = 75;
const POLL_MS = 2000;
const DISK_CACHE_MS = 30_000;
const LOG_TAIL = 512 * 1024;
const LOG_CHUNK = 1024 * 1024;
const TASK_LINES = 2000;
const START_TIMEOUT_MS = 90_000;

// Same rules as the helper. It checks again; these just give quick, friendly errors.
const ID_RE = /^\d{8}-\d{6}$/;
const CT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NEW_CT_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const DB_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(?:sql|archive)\.gz$/;
const TARGETS = ['containers', 'host', 'databases', 'pm2'];
const SUDO_PROBLEM = /a password is required|a terminal is required|not allowed to execute|may not run sudo|not in the sudoers|command not found/i;

class HelperError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const lastTagged = (text, tag) => text.split('\n').reverse().find((l) => l.startsWith(tag))?.slice(tag.length);

function helperFailure(code, stderr) {
  const msg = lastTagged(stderr, '@@ERROR ');
  if (code === EXIT_BUSY) return new HelperError(msg || 'A backup job is already running', 409);
  if (msg) return new HelperError(msg, code === 2 ? 400 : 500);
  if (SUDO_PROBLEM.test(stderr)) {
    return new HelperError('The backup helper is not installed for sudo yet. Follow "Backups: install" in README.md.', 503);
  }
  return new HelperError(stderr.trim().split('\n').pop() || `Backup helper failed (exit code ${code})`);
}

// Runs the helper and resolves with its @@RESULT object. onLine gets every other stdout line as it arrives.
function helper(args, { input = '', timeout = 120_000, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', HELPER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let result = null;
    let err = '';
    let buf = '';
    const take = (l) => {
      if (l.startsWith('@@RESULT ')) result = l.slice(9);
      else if (onLine) onLine(l);
    };
    const timer = timeout ? setTimeout(() => child.kill('SIGTERM'), timeout) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(take);
    });
    child.stderr.on('data', (d) => { if (err.length < 200_000) err += d; });
    child.on('error', (e) => reject(new HelperError(`Cannot run sudo: ${e.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) take(buf);
      if (code !== 0) return reject(helperFailure(code, err));
      try {
        return resolve(result ? JSON.parse(result) : {});
      } catch {
        return reject(new HelperError('The backup helper sent an unreadable reply'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Next/last run of the timer. `systemctl show` needs no root.
function timerInfo() {
  const props = 'LoadState,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec';
  return new Promise((resolve) => {
    execFile('systemctl', ['show', TIMER, '--timestamp=unix', '-p', props], { timeout: 5000 }, (err, stdout = '') => {
      const v = Object.fromEntries(stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const ts = (s) => {
        const m = /^@(\d+)/.exec(s || '');
        return m ? Number(m[1]) * 1000 : null;
      };
      resolve({
        installed: v.LoadState === 'loaded',
        enabled: v.UnitFileState === 'enabled',
        active: v.ActiveState === 'active',
        next: ts(v.NextElapseUSecRealtime),
        last: ts(v.LastTriggerUSec),
        error: err && !stdout ? err.message : null,
      });
    });
  });
}

function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

const parse = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};
const str = (v) => (typeof v === 'string' ? v.slice(0, 2000) : null);
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

const publicJob = (r) => r && {
  id: r.id,
  trigger: r.trigger_type,
  by: r.by_user,
  targets: parse(r.targets, []),
  status: r.status,
  phase: r.phase,
  progress: r.progress,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  size: r.size,
  error: r.error,
  warning: r.warning,
  verifiedAt: r.verified_at,
  verify: parse(r.verify_result, null),
};

const publicTask = (t) => t && {
  kind: t.kind, label: t.label, by: t.by, status: t.status, lines: t.lines, startedAt: t.startedAt,
  finishedAt: t.finishedAt, result: t.result, error: t.error,
};

// Short, readable summary of what a settings save changed, for the audit log
function settingsDiff(before, after) {
  const parts = [];
  for (const k of Object.keys(after)) {
    if (JSON.stringify(after[k]) === JSON.stringify(before?.[k])) continue;
    const v = after[k];
    if (k === 'schedule') parts.push(`schedule ${v.enabled ? `${v.time} ${v.timezone}` : 'off'}`);
    else if (k === 'retention') parts.push(`retention ${v.daily}/${v.weekly}/${v.monthly}`);
    else if (k === 'targets') parts.push(`targets ${Object.keys(v).filter((t) => v[t]).join(',') || 'none'}`);
    else if (typeof v === 'boolean' || typeof v === 'string') parts.push(`${k} ${v}`);
    else parts.push(k);
  }
  return parts.length ? `changed: ${parts.join('; ')}` : 'no changes';
}

export function createBackups({ io, containers }) {
  const emit = (event, data) => io.to('admin').emit(event, data);
  const seen = new Map(); // id -> mtime of its job file when last read
  const live = new Map(); // id -> raw job record, while running
  const tails = new Map(); // id -> log bytes already streamed
  const pending = new Map(); // id -> "Backup now" request the service has not picked up yet
  let task = null; // the current/last dry run, verify or restore (one at a time)
  let disk = null;
  let stateError = null;

  // A "running" record whose process is gone was killed hard (reboot, power cut, SIGKILL)
  function alive(job) {
    if (!Number.isInteger(job.pid) || job.startedAt < Date.now() - os.uptime() * 1000) return false;
    try {
      process.kill(job.pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM'; // exists, owned by root
    }
  }

  function auditTransition(row) {
    if (row.audited === row.status) return;
    const username = row.by_user || 'system';
    if (!row.audited) {
      audit.log({ username, action: 'backup_start', target: row.id, result: 'started', detail: `${row.trigger_type || '?'}: ${parse(row.targets, []).join(', ')}` });
    }
    if (row.status === 'success') {
      const secs = Math.round(((row.finished_at || 0) - (row.started_at || 0)) / 1000);
      audit.log({ username, action: 'backup_finish', target: row.id, result: 'success', detail: `${bytes(row.size)} new, ${secs}s${row.warning ? `; ${row.warning}` : ''}` });
    } else if (row.status === 'failed') {
      audit.log({ username, action: 'backup_fail', target: row.id, result: 'failure', detail: row.error });
    }
    backupJobs.setAudited(row.id, row.status);
  }

  function tailLog(id) {
    const file = path.join(LOGS_DIR, `${id}.log`);
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    const from = tails.get(id) ?? 0;
    if (size <= from) return;
    const len = Math.min(size - from, LOG_CHUNK);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    // Only send whole lines, so a UTF-8 character is never cut in half
    const end = len === LOG_CHUNK ? len : buf.lastIndexOf(10) + 1;
    if (!end) return;
    tails.set(id, from + end);
    emit('backup:log', { id, from, to: from + end, text: buf.subarray(0, end).toString('utf8') });
  }

  function record(job) {
    const status = ['running', 'success', 'failed'].includes(job.status) ? job.status : 'failed';
    backupJobs.upsert({
      id: job.id, trigger: str(job.trigger), by: str(job.by), targets: JSON.stringify(Array.isArray(job.targets) ? job.targets : []),
      status, phase: str(job.phase), progress: num(job.progress), startedAt: num(job.startedAt), finishedAt: num(job.finishedAt),
      size: num(job.size), error: str(job.error), warning: str(job.warning), log: path.join(LOGS_DIR, `${job.id}.log`),
    });
    pending.delete(job.id);
    if (status === 'running') {
      if (!live.has(job.id)) {
        // Clients load the log so far over HTTP; stream only what comes after
        try { tails.set(job.id, fs.statSync(path.join(LOGS_DIR, `${job.id}.log`)).size); } catch { tails.set(job.id, 0); }
      }
      live.set(job.id, job);
    } else if (live.has(job.id)) {
      tailLog(job.id);
      live.delete(job.id);
      tails.delete(job.id);
      disk = null; // sizes changed
    }
    const row = backupJobs.get(job.id);
    auditTransition(row);
    emit('backup:job', publicJob(row));
  }

  function syncJobs() {
    let files = [];
    try {
      files = fs.readdirSync(JOBS_DIR);
      stateError = null;
    } catch (err) {
      stateError = err.code === 'ENOENT' ? `${JOBS_DIR} does not exist yet: the backup helper is not installed`
        : `Cannot read ${JOBS_DIR}: ${err.message}`;
    }
    for (const f of files) {
      const m = /^(\d{8}-\d{6})\.json$/.exec(f);
      if (!m) continue;
      const file = path.join(JOBS_DIR, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (seen.get(m[1]) === st.mtimeMs) continue;
      let job;
      try { job = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; } // half-written: next poll
      if (job?.id !== m[1]) continue;
      seen.set(m[1], st.mtimeMs);
      if (job.status === 'running' && !alive(job)) {
        Object.assign(job, { status: 'failed', finishedAt: job.finishedAt || Date.now(), error: 'The backup process stopped unexpectedly (server restart or killed). The next run cleans up its unfinished files.' });
      }
      record(job);
    }
  }

  function poll() {
    try {
      syncJobs();
      for (const [id, job] of live) {
        tailLog(id);
        if (!alive(job)) record({ ...job, status: 'failed', finishedAt: Date.now(), error: 'The backup process stopped unexpectedly (server restart or killed).' });
      }
      for (const [id, p] of pending) {
        if (Date.now() - p.at < START_TIMEOUT_MS) continue;
        record({
          id, trigger: 'manual', by: p.by, targets: p.targets, status: 'failed', startedAt: p.at, finishedAt: Date.now(),
          error: 'The backup service did not start. Check: journalctl -u panel-backup',
        });
      }
    } catch (err) {
      console.error('Backup poll failed:', err.message);
    }
    setTimeout(poll, POLL_MS).unref();
  }

  async function diskStatus(refresh) {
    if (!refresh && disk && Date.now() - disk.at < DISK_CACHE_MS) return disk.value;
    const value = await helper(['disk-status'], { timeout: 30_000 });
    disk = { at: Date.now(), value };
    return value;
  }

  // Dry runs, verifies and restores run through the helper while the panel streams their output
  function startTask(kind, label, args, by, onDone) {
    if (task?.status === 'running') throw new HelperError(`Wait for the current ${task.kind} to finish`, 409);
    const t = { kind, label, by, status: 'running', lines: [], startedAt: Date.now(), finishedAt: null, result: null, error: null };
    task = t;
    emit('backup:task', publicTask(t));
    helper(args, {
      timeout: 0,
      onLine: (line) => {
        t.lines.push(line);
        if (t.lines.length > TASK_LINES) t.lines.splice(0, t.lines.length - TASK_LINES);
        emit('backup:task-line', { startedAt: t.startedAt, line });
      },
    })
      .then((r) => { t.status = 'success'; t.result = r; }, (e) => { t.status = 'failure'; t.error = e.message; })
      .then(() => {
        t.finishedAt = Date.now();
        try { onDone(t); } catch (err) { console.error('Backup task follow-up failed:', err.message); }
        emit('backup:task', publicTask(t));
      });
    return publicTask(t);
  }

  // Pipes a helper download (tar.gz / dump) to the browser. Headers go out with the first byte, so
  // errors before that still become a normal JSON error; a failure after that aborts the download.
  function streamDownload(req, res, args, filename, entry) {
    const child = spawn('sudo', ['-n', HELPER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let started = false;
    const headers = () => res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (err.length < 100_000) err += d; });
    child.stdout.once('data', (chunk) => {
      started = true;
      headers();
      res.write(chunk);
      child.stdout.pipe(res, { end: false });
    });
    child.on('error', (e) => { err += `\n${e.message}`; });
    child.on('close', (code) => {
      const failure = code === 0 ? null : helperFailure(code ?? 1, err);
      audit.log({ ...entry, result: failure ? 'failure' : 'success', detail: failure?.message || entry.detail || null });
      if (started) return failure ? res.destroy() : res.end();
      if (!failure) return headers().end();
      return res.status(failure.status).json({ error: failure.message });
    });
    res.on('close', () => { if (!res.writableFinished) child.kill('SIGTERM'); });
  }

  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });
  const checkId = (id) => {
    if (!ID_RE.test(id || '')) throw new HelperError('Invalid backup id', 400);
    return id;
  };
  const targetsFrom = (body) => {
    const t = body?.targets;
    if (!Array.isArray(t) || !t.length || t.some((x) => !TARGETS.includes(x))) {
      throw new HelperError('Pick at least one target: containers, host, databases or pm2', 400);
    }
    return TARGETS.filter((x) => t.includes(x));
  };

  router.get('/', wrap(async (req, res) => {
    const settle = (p) => p.then((value) => ({ value }), (e) => ({ error: e.message }));
    const [config, diskInfo, timer] = await Promise.all([
      settle(helper(['get-config'])), settle(diskStatus(req.query.refresh === '1')), timerInfo(),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      config: config.value || null,
      configError: config.error || null,
      disk: diskInfo.value || null,
      diskError: diskInfo.error || null,
      timer,
      jobs: backupJobs.recent(50).map(publicJob),
      task: publicTask(task),
      pending: [...pending.keys()],
      stateError,
      containers: containers.names(),
    });
  }));

  router.get('/jobs', (req, res) => {
    const before = ID_RE.test(req.query.before || '') ? req.query.before : null;
    res.json({ jobs: backupJobs.recent(50, before).map(publicJob) });
  });

  router.get('/jobs/:id/log', wrap((req, res) => {
    const file = path.join(LOGS_DIR, `${checkId(req.params.id)}.log`);
    let size;
    try { size = fs.statSync(file).size; } catch { throw new HelperError('There is no log for this backup', 404); }
    const from = Math.max(0, size - LOG_TAIL);
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    if (from > 0) text = text.slice(text.indexOf('\n') + 1);
    res.set('Cache-Control', 'no-store');
    res.json({ text, offset: size, truncated: from > 0 });
  }));

  router.post('/run', wrap(async (req, res) => {
    const targets = targetsFrom(req.body);
    const { username, ip } = who(req);
    try {
      const r = await helper(['start', `--targets=${targets.join(',')}`, `--by=${username}`]);
      pending.set(r.id, { at: Date.now(), by: username, targets });
      audit.log({ username, ip, action: 'backup_start', target: r.id, result: 'requested', detail: targets.join(', ') });
      res.status(202).json({ id: r.id });
    } catch (err) {
      audit.log({ username, ip, action: 'backup_start', result: 'failure', detail: err.message });
      throw err;
    }
  }));

  router.post('/dry-run', wrap((req, res) => {
    const targets = targetsFrom(req.body);
    const { username, ip } = who(req);
    const t = startTask('dry run', targets.join(', '), ['run', '--dry-run', `--targets=${targets.join(',')}`], username, (done) => {
      audit.log({ username, ip, action: 'backup_dry_run', target: targets.join(', '), result: done.status, detail: done.error });
    });
    res.status(202).json(t);
  }));

  router.put('/settings', wrap(async (req, res) => {
    const { username, ip } = who(req);
    const before = await helper(['get-config']).catch(() => null);
    try {
      const { config } = await helper(['set-config'], { input: JSON.stringify(req.body ?? {}) });
      audit.log({ username, ip, action: 'backup_settings', result: 'success', detail: settingsDiff(before, config) });
      res.json({ config, timer: await timerInfo() });
    } catch (err) {
      audit.log({ username, ip, action: 'backup_settings', result: 'failure', detail: err.message });
      throw err;
    }
  }));

  // Good backups on the disk (only runs with a manifest), for the restore pickers
  router.get('/runs', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await helper(['list'], { timeout: 60_000 }));
  }));

  router.get('/runs/:id/files', wrap(async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    res.set('Cache-Control', 'no-store');
    res.json(await helper(['ls', checkId(req.params.id), '--', p], { timeout: 60_000 }));
  }));

  router.get('/runs/:id/download', wrap((req, res) => {
    const id = checkId(req.params.id);
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p.replace(/\//g, '')) throw new HelperError('Pick a file or folder to download', 400);
    const base = p.split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
    const { username, ip } = who(req);
    streamDownload(req, res, ['download', id, '--', p], `${id}-${base}.tar.gz`, {
      username, ip, action: 'backup_download', target: `${id}:/${p.replace(/^\/+/, '')}`,
    });
  }));

  router.get('/runs/:id/db/:file', wrap((req, res) => {
    const id = checkId(req.params.id);
    const { file } = req.params;
    if (!DB_FILE_RE.test(file)) throw new HelperError('Invalid dump name', 400);
    const { username, ip } = who(req);
    streamDownload(req, res, ['db-download', id, file], file, { username, ip, action: 'backup_db_download', target: `${id}:${file}` });
  }));

  router.post('/runs/:id/verify', wrap((req, res) => {
    const id = checkId(req.params.id);
    const { username, ip } = who(req);
    const t = startTask('verify', id, ['verify', id], username, (done) => {
      const r = done.result;
      if (r) {
        backupJobs.setVerify(id, { ok: r.ok, checked: r.checked, failureCount: r.failureCount });
        const row = backupJobs.get(id);
        if (row) emit('backup:job', publicJob(row));
      }
      audit.log({
        username, ip, action: 'backup_verify', target: id, result: r?.ok ? 'success' : 'failure',
        detail: r ? `${r.checked} files checked, ${r.failureCount} problem(s)` : done.error,
      });
    });
    res.status(202).json(t);
  }));

  // Restores only as a NEW container (the helper refuses existing names) and only after the user typed that name
  router.post('/runs/:id/restore-container', wrap((req, res) => {
    const id = checkId(req.params.id);
    const { container, newName, confirm } = req.body ?? {};
    if (typeof container !== 'string' || !CT_RE.test(container)) throw new HelperError('Pick a container from this backup', 400);
    if (typeof newName !== 'string' || !NEW_CT_RE.test(newName)) {
      throw new HelperError('New name: 2-63 lowercase letters, digits or dashes, starting with a letter, not ending with a dash', 400);
    }
    if (confirm !== newName) throw new HelperError('Type the new container name exactly to confirm', 400);
    if (containers.exists(newName)) throw new HelperError(`A container named ${newName} already exists. Pick a new name.`, 409);
    const { username, ip } = who(req);
    const target = `${container} -> ${newName}`;
    const t = startTask('restore', `${container} from ${id} as ${newName}`, ['restore-container', id, container, newName], username, (done) => {
      const warnings = done.result?.warnings || [];
      audit.log({ username, ip, action: 'backup_restore', target, result: done.status, detail: done.error || [`from backup ${id}`, ...warnings].join('; ') });
    });
    audit.log({ username, ip, action: 'backup_restore', target, result: 'requested', detail: `from backup ${id}` });
    res.status(202).json(t);
  }));

  router.use((err, _req, res, _next) => {
    if (!(err instanceof HelperError)) console.error('Backup route failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'Backup request failed' });
  });

  return { router, start: poll };
}
