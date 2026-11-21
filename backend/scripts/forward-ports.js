#!/usr/bin/env node
// One-time repair, safe to run again: gives every app already deployed in an LXD container the proxy device that
// forwards the host's 127.0.0.1:<port> to it (port<PORT>, see portforward.js). New deploys do this by themselves.
//
// Run it on the server as the user the panel runs as (it needs the LXD socket), with the panel's environment,
// AFTER the new panel version is installed (opening the database applies its migrations, like the panel does):
//   cd <panel>/backend
//   DOTENV_CONFIG_PATH=/path/to/panel/.env node scripts/forward-ports.js --dry-run   # only show what it would do
//   DOTENV_CONFIG_PATH=/path/to/panel/.env node scripts/forward-ports.js             # create the missing devices
// Add --check to also test http://127.0.0.1:<port> from the host for every app.
// Exit code 1 when an app could not be forwarded (port taken by something else, container missing, ...).
import 'dotenv/config';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('Usage: node scripts/forward-ports.js [--dry-run] [--check]');
  process.exit(0);
}
const dry = args.has('--dry-run');
const check = args.has('--check');

const { db } = await import('../db.js');
const pf = await import('../portforward.js');
const { listInstances } = await import('../lxd.js');

if (!pf.forwardingEnabled()) console.log('Note: PORT_FORWARD=off is set for the panel, so it will not use these devices.');

let existing;
try {
  existing = new Set((await listInstances()).map((i) => i.name));
} catch (err) {
  console.error(`Cannot reach LXD (${err.message}). Run this as the panel user on the server.`);
  process.exit(2);
}

const apps = db.prepare(`SELECT a.id, a.name, a.container, a.port, a.forwarded_port, a.status, u.username AS owner
  FROM apps a JOIN users u ON u.id = a.user_id
  WHERE a.target != 'vps' AND a.status NOT IN ('new', 'provisioning') ORDER BY a.container, a.port`).all();
const counts = { ok: 0, created: 0, updated: 0, would: 0, failed: 0, skipped: 0 };
console.log(`${apps.length} deployed app(s) in LXD containers${dry ? ' (dry run: nothing is changed)' : ''}\n`);

for (const a of apps) {
  const label = `${a.container}/${a.name} (${a.owner}) port ${a.port}`;
  try {
    pf.checkContainer(a.container);
    pf.checkPort(a.port);
    if (!existing.has(a.container)) { counts.skipped += 1; console.log(`- ${label}: container not found, skipped`); continue; }
    const st = await pf.forwardStatus(a.container, a.port);
    if (st.status === 'ok' || st.status === 'other') {
      counts.ok += 1;
      console.log(`= ${label}: already forwarded by ${st.device}`);
    } else if (dry) {
      const problem = await pf.portProblem(a.container, a.port);
      if (problem) { counts.failed += 1; console.log(`! ${label}: ${problem}`); } else {
        counts.would += 1;
        console.log(`+ ${label}: would ${st.status === 'different' ? `replace ${st.device} (${st.config.listen} -> ${st.config.connect})` : `create port${a.port}`}`);
      }
    } else {
      const r = await pf.ensureForward(a.container, a.port);
      db.prepare('UPDATE apps SET forwarded_port = ? WHERE id = ?').run(a.port, a.id);
      counts[r.action === 'updated' ? 'updated' : r.action === 'created' ? 'created' : 'ok'] += 1;
      console.log(`+ ${label}: ${r.action} ${r.device}`);
    }
    if (check) {
      const h = await pf.probe(a.port);
      console.log(`  health: ${h.ok ? `HTTP ${h.code}` : `FAILED (${h.error})`}`);
    }
  } catch (err) {
    counts.failed += 1;
    console.log(`! ${label}: ${err.message}`);
  }
}

console.log(`\nDone. ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', ') || 'nothing to do'}`);
process.exit(counts.failed ? 1 : 0);
