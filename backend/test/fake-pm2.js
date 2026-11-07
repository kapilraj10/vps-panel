#!/usr/bin/env node
// TEST ONLY: a tiny `pm2` CLI. State in $FAKE_PM2_STATE (JSON). `start <ecosystem.json>` really starts test/fake-app.js
// with the app's env, so health checks hit a live HTTP server.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.FAKE_PM2_STATE;
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { next: 0, procs: [] }; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const [cmd, arg, ...rest] = process.argv.slice(2);
const s = load();
const find = (x) => s.procs.find((p) => String(p.pm_id) === String(x) || p.name === x);
const kill = (p) => { try { if (p.pid) process.kill(p.pid); } catch { /* gone */ } p.pid = 0; };
const run = (p) => {
  kill(p);
  const logDir = path.dirname(STATE);
  p.out = path.join(logDir, `${p.name}-out.log`);
  p.err = path.join(logDir, `${p.name}-err.log`);
  const child = spawn(process.execPath, [path.join(here, 'fake-app.js')], {
    env: { ...process.env, ...p.env }, detached: true, stdio: ['ignore', fs.openSync(p.out, 'a'), fs.openSync(p.err, 'a')],
  });
  child.unref();
  p.pid = child.pid; p.status = 'online'; p.started = Date.now();
};
const fail = (m) => { console.error(`[PM2][ERROR] ${m}`); process.exit(1); };

switch (cmd) {
  case 'jlist':
    console.log(JSON.stringify(s.procs.map((p) => ({
      name: p.name, pm_id: p.pm_id, pid: p.pid, monit: { cpu: 1.5, memory: 40 * 1024 * 1024 },
      pm2_env: { status: p.status, exec_mode: p.mode === 'cluster' ? 'cluster_mode' : 'fork_mode', instances: p.instances || 1, restart_time: p.restarts || 0,
        pm_uptime: p.started, env: p.env, pm_cwd: p.cwd, pm_exec_path: p.script, pm_out_log_path: p.out, pm_err_log_path: p.err },
    }))));
    break;
  case 'start': {
    if (!arg.endsWith('.json')) { const p = find(arg); if (!p) fail('not found'); run(p); break; }
    const { apps } = JSON.parse(fs.readFileSync(arg, 'utf8'));
    for (const a of apps) {
      if (find(a.name)) fail(`${a.name} already exists`);
      const p = { name: a.name, pm_id: s.next++, env: a.env || {}, cwd: a.cwd, script: a.script, mode: a.exec_mode, instances: a.instances, restarts: 0 };
      s.procs.push(p);
      run(p);
    }
    break;
  }
  case 'stop': { const p = find(arg); if (!p) fail('not found'); kill(p); p.status = 'stopped'; break; }
  case 'restart': case 'reload': { const p = find(arg); if (!p) fail('not found'); p.restarts = (p.restarts || 0) + 1; run(p); break; }
  case 'delete': { const p = find(arg); if (!p) fail('not found'); kill(p); s.procs = s.procs.filter((x) => x !== p); break; }
  case 'scale': { const p = find(arg); if (!p) fail('not found'); p.instances = Number(rest[0]); break; }
  case 'flush': { const p = find(arg); if (p?.out) fs.writeFileSync(p.out, ''); break; }
  case 'save': s.saved = Date.now(); break;
  case 'resurrect': s.resurrected = Date.now(); break;
  case 'killall': for (const p of s.procs) kill(p); break;
  default: fail(`unknown command ${cmd}`);
}
save(s);
