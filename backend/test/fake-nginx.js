#!/usr/bin/env node
// TEST ONLY: stands in for `nginx -t` and `systemctl reload nginx`. Checks brace balance of the files in LB_CONF_DIR
// and refuses anything containing INVALID. Flags next to the conf dir force failures: nginx-fail-test, nginx-fail-reload.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.LB_CONF_DIR;
const flag = (n) => fs.existsSync(path.join(dir, '..', n));
const mode = process.argv[2];
if (mode === 'version') { console.error('nginx version: nginx/1.24.0 (fake)'); process.exit(0); }
if (mode === 'test') {
  if (flag('nginx-fail-test')) { console.error('nginx: [emerg] forced test failure'); process.exit(1); }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.conf'))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    if (t.includes('INVALID') || (t.match(/{/g) || []).length !== (t.match(/}/g) || []).length) {
      console.error(`nginx: [emerg] invalid config in ${f}`); process.exit(1);
    }
  }
  console.error('nginx: configuration file test is successful');
  process.exit(0);
}
if (mode === 'reload') {
  if (flag('nginx-fail-reload')) { console.error('Job for nginx.service failed'); process.exit(1); }
  fs.appendFileSync(path.join(dir, '..', 'reloads.log'), `${Date.now()}\n`);
  process.exit(0);
}
process.exit(2);
