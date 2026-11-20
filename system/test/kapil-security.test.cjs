// Security helper: input validation, output parsing, lock-out guards. No root needed (nothing is executed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('../kapil-security');

const HELPER = path.join(__dirname, '..', 'kapil-security');
const run = (...args) => spawnSync(process.execPath, [HELPER, ...args], { encoding: 'utf8' });

test('ports, sources, comments, jails and IPs are validated', () => {
  assert.deepEqual(h.port('443'), { spec: '443', from: 443, to: 443, proto: 'any' });
  assert.equal(h.port('443/tcp').spec, '443/tcp');
  assert.equal(h.port('6000:6100/udp').spec, '6000:6100/udp');
  for (const bad of ['', '0', '70000', '22;rm', '6000:6100', '100:50/tcp', '22/icmp', 'ssh']) assert.throws(() => h.port(bad), h.InputError, bad);
  assert.equal(h.source(undefined), 'any');
  assert.equal(h.source('203.0.113.0/24'), '203.0.113.0/24');
  assert.equal(h.source('2001:db8::/32'), '2001:db8::/32');
  for (const bad of ['203.0.113.0/33', 'example.com', '1.2.3.4/24/1', '1.2.3', '$(id)']) assert.throws(() => h.source(bad), h.InputError, bad);
  assert.equal(h.comment('web server'), 'web server');
  assert.throws(() => h.comment('x; rm -rf /'), h.InputError);
  assert.throws(() => h.jail('sshd;id'), h.InputError);
  assert.throws(() => h.ip('1.2.3.4 5.6.7.8'), h.InputError);
  assert.throws(() => h.ruleNum('0'), h.InputError);
});

test('ufw status output is parsed', () => {
  const numbered = `Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 22/tcp                     LIMIT IN    Anywhere                   # SSH (kapil-cloud)
[ 2] Anywhere on lxdbr0         ALLOW IN    Anywhere
[ 3] 443/tcp                    ALLOW IN    203.0.113.0/24             # web
[ 4] 22/tcp (v6)                LIMIT IN    Anywhere (v6)
`;
  const r = h.parseUfwNumbered(numbered);
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { num: 1, to: '22/tcp', action: 'LIMIT', direction: 'IN', from: 'Anywhere', comment: 'SSH (kapil-cloud)', v6: false });
  assert.equal(r[1].to, 'Anywhere on lxdbr0');
  assert.equal(r[2].from, '203.0.113.0/24');
  assert.equal(r[3].v6, true);
  const v = h.parseUfwVerbose('Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\n');
  assert.deepEqual(v, { active: true, defaults: { incoming: 'deny', outgoing: 'allow', routed: 'deny' } });
  assert.equal(h.parseUfwVerbose('Status: inactive').active, false);
});

test('SSH lock-out guard: which rules let the SSH port in', () => {
  const rule = (to, action = 'ALLOW') => ({ to, action, direction: 'IN' });
  assert.ok(h.allowsPort(rule('22/tcp', 'LIMIT'), 22));
  assert.ok(h.allowsPort(rule('22'), 22));
  assert.ok(h.allowsPort(rule('20:30/tcp'), 22));
  assert.ok(!h.allowsPort(rule('22/udp'), 22));
  assert.ok(!h.allowsPort(rule('22/tcp', 'DENY'), 22));
  assert.ok(!h.allowsPort(rule('Anywhere on lxdbr0'), 22));
  assert.ok(!h.allowsPort(rule('2222/tcp'), 22));
});

test('fail2ban, sshd and ss output are parsed', () => {
  assert.deepEqual(h.parseJailList('Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, recidive\n'), ['sshd', 'recidive']);
  const j = h.parseJail('sshd', `Status for the jail: sshd
|- Filter
|  |- Currently failed:\t3
|  |- Total failed:\t120
|  \`- File list:\t/var/log/auth.log
\`- Actions
   |- Currently banned:\t2
   |- Total banned:\t15
   \`- Banned IP list:\t203.0.113.9 198.51.100.4`);
  assert.deepEqual(j, { name: 'sshd', failed: 3, totalFailed: 120, banned: 2, totalBanned: 15, ips: ['203.0.113.9', '198.51.100.4'] });
  const s = h.parseSshd('port 22\nport 2222\npermitrootlogin prohibit-password\npasswordauthentication yes\nmaxauthtries 6\n');
  assert.deepEqual(s.ports, [22, 2222]);
  assert.equal(s.permitrootlogin, 'prohibit-password');
  const ss = h.parseSs(`tcp LISTEN 0 511 127.0.0.1:4000 0.0.0.0:* users:(("node",pid=1,fd=26))
tcp LISTEN 0 511 0.0.0.0:3001 0.0.0.0:* users:(("node",pid=2,fd=21))
tcp LISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=3,fd=4))
tcp LISTEN 0 4096 0.0.0.0:15432 0.0.0.0:* users:(("docker-proxy",pid=4,fd=4))
tcp LISTEN 0 4096 10.10.10.1:53 0.0.0.0:* users:(("dnsmasq",pid=5,fd=4))`);
  const by = Object.fromEntries(ss.map((x) => [x.port, x]));
  assert.equal(by[4000].public, false);
  assert.equal(by[3001].public, true);
  assert.equal(by[22].addr, '::');
  assert.equal(by[22].public, true);
  assert.equal(by[15432].process, 'docker-proxy');
  assert.equal(by[53].public, false, 'private bridge address');
});

test('CLI: unknown commands and bad input exit 2 with @@ERROR, before running anything', () => {
  for (const args of [['rm', '-rf', '/'], ['ufw-rule', 'allow', '22;id'], ['ufw-rule', 'open', '22'], ['ufw-delete', 'x'], ['f2b-unban', 'sshd', 'not-an-ip'], ['ufw-rule', 'allow', '22', 'any', 'x'.repeat(200)]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^@@ERROR /m);
    assert.equal(r.stdout, '');
  }
});
