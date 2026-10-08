// Run with: node --test system/test
// Covers the helper's input validation, path safety and retention rules. No root, no disk needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('../panel-backup');

const HELPER = path.join(__dirname, '..', 'panel-backup');
const run = (...args) => spawnSync(process.execPath, [HELPER, ...args], { encoding: 'utf8' });

test('defaults are valid and match the spec', () => {
  const c = h.normalizeConfig({});
  assert.deepEqual(c, h.DEFAULTS);
  assert.equal(c.optimizedStorage, false);
  assert.deepEqual(c.retention, { daily: 7, weekly: 4, monthly: 3 });
  assert.equal(h.onCalendar(c.schedule), '*-*-* 02:30:00 Asia/Kathmandu');
});

test('settings validation rejects unsafe or malformed values', () => {
  const bad = [
    { nope: 1 },
    { targets: { everything: true } },
    { targets: { containers: 'yes' } },
    { targets: { containers: false, host: false, databases: false, pm2: false } },
    { hostPaths: ['/'] },
    { hostPaths: ['/mnt'] },
    { hostPaths: ['/mnt/backup/host'] },
    { hostPaths: ['/proc/1'] },
    { hostPaths: ['relative/path'] },
    { hostPaths: ['/home/../etc'] },
    { hostPaths: ['/home/kapil;rm -rf /'] },
    { hostPaths: [] },
    { excludes: ['--delete'] },
    { excludes: ['+ keep'] },
    { excludes: ['a\nb'] },
    { containerExclude: ['Bad_Name'] },
    { schedule: { time: '25:00' } },
    { schedule: { time: '2:30' } },
    { schedule: { timezone: 'Mars/Olympus' } },
    { schedule: { timezone: '../../etc/passwd' } },
    { retention: { daily: 0 } },
    { retention: { weekly: 1.5 } },
    { pm2User: 'root' },
    { pm2User: 'Kapil' },
  ];
  for (const input of bad) assert.throws(() => h.normalizeConfig(input), undefined, JSON.stringify(input));
});

test('host paths are normalised and de-duplicated', () => {
  const c = h.normalizeConfig({ hostPaths: ['/etc/', '/etc', '/home//kapil'] });
  assert.deepEqual(c.hostPaths, ['/etc', '/home/kapil']);
});

test('targets must come from the whitelist', () => {
  assert.deepEqual(h.pickTargets(['host', 'containers'], h.DEFAULTS), ['containers', 'host']);
  assert.deepEqual(h.pickTargets(undefined, h.normalizeConfig({ targets: { pm2: false } })), ['containers', 'host', 'databases']);
  assert.throws(() => h.pickTargets(['host', 'rootfs'], h.DEFAULTS));
  assert.throws(() => h.pickTargets([], h.DEFAULTS));
});

test('snapshot paths can never escape', () => {
  assert.deepEqual(h.splitSafePath(''), []);
  assert.deepEqual(h.splitSafePath('/home//kapil/'), ['home', 'kapil']);
  for (const p of ['..', 'home/../../etc', './x', 'a/./b', 'a\0b', 'a\nb']) assert.throws(() => h.splitSafePath(p), undefined, p);
});

test('ids and names follow strict patterns', () => {
  assert.equal(h.makeId(new Date('2026-10-08T20:45:00Z'), 'Asia/Kathmandu'), '20261009-023000');
  assert.ok(h.ID_RE.test('20261009-023000'));
  for (const bad of ['2026-10-09', '20261009-0230', '20261009-023000/../x', '../20261009-023000']) assert.ok(!h.ID_RE.test(bad));
  assert.ok(h.CT_RE.test('animesh') && h.CT_RE.test('sachin'));
  assert.ok(!h.CT_RE.test('a b') && !h.CT_RE.test('--force') && !h.CT_RE.test('Sachin'));
  assert.ok(h.NEW_CT_RE.test('sachin-restored'));
  assert.ok(!h.NEW_CT_RE.test('1sachin') && !h.NEW_CT_RE.test('sachin-') && !h.NEW_CT_RE.test('-sachin'));
  assert.ok(h.DB_FILE_RE.test('db-postgres.sql.gz') && !h.DB_FILE_RE.test('../x.sql.gz'));
});

test('ISO weeks', () => {
  assert.equal(h.isoWeek('20260101-000000'), '2026-W01'); // Thursday
  assert.equal(h.isoWeek('20241230-000000'), '2025-W01'); // Monday of the week that holds Jan 2 2025
  assert.equal(h.isoWeek('20210103-000000'), '2020-W53'); // Sunday
  assert.equal(h.isoWeek('20261008-000000'), '2026-W41');
});

const dayIds = (start, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(...start) + i * 86_400_000);
  return `${d.toISOString().slice(0, 10).replace(/-/g, '')}-023000`;
});

test('retention never removes the only or the newest good backup', () => {
  assert.deepEqual(h.planRetention(['20261008-023000'], { daily: 1, weekly: 0, monthly: 0 }), { keep: ['20261008-023000'], remove: [] });
  assert.deepEqual(h.planRetention([], { daily: 7, weekly: 4, monthly: 3 }), { keep: [], remove: [] });
  const plan = h.planRetention(dayIds([2026, 0, 1], 30), { daily: 1, weekly: 0, monthly: 0 });
  assert.deepEqual(plan.keep, ['20260130-023000']);
  assert.equal(plan.remove.length, 29);
});

test('retention keeps 7 daily, 4 weekly and 3 monthly', () => {
  const ids = dayIds([2026, 5, 1], 130); // 1 Jun .. 8 Oct 2026, one per day
  const { keep, remove } = h.planRetention(ids, { daily: 7, weekly: 4, monthly: 3 });
  assert.equal(keep.length + remove.length, ids.length);
  // the 7 newest days
  for (const id of ids.slice(-7)) assert.ok(keep.includes(id), id);
  // newest backup of each of the last 3 months
  for (const id of ['20261008-023000', '20260930-023000', '20260831-023000']) assert.ok(keep.includes(id), id);
  // newest of each of the last 4 ISO weeks (Sundays, plus the current partial week)
  for (const id of ['20261004-023000', '20260927-023000', '20260920-023000']) assert.ok(keep.includes(id), id);
  assert.ok(remove.includes('20260601-023000'));
  assert.ok(keep.length <= 7 + 4 + 3);
});

test('retention keeps the newest of several runs on one day', () => {
  const { keep, remove } = h.planRetention(['20261008-023000', '20261008-140000', '20261007-023000'], { daily: 2, weekly: 0, monthly: 0 });
  assert.deepEqual(keep, ['20261008-140000', '20261007-023000']);
  assert.deepEqual(remove, ['20261008-023000']);
});

test('retention ignores anything that is not a backup id', () => {
  const { keep, remove } = h.planRetention(['../etc', '20261008-023000', 'x'], { daily: 7, weekly: 4, monthly: 3 });
  assert.deepEqual(keep, ['20261008-023000']);
  assert.deepEqual(remove, []);
});

test('database images are recognised', () => {
  const cases = {
    'postgres:16': 'postgres', 'postgis/postgis:16-3.4': 'postgres', 'timescale/timescaledb:latest-pg16': 'postgres',
    'pgvector/pgvector:pg16': 'postgres', 'mysql:8': 'mysql', 'mariadb:11': 'mysql', 'mongo:7': 'mongo',
    'mongodb/mongodb-community-server:7.0-ubuntu2204': 'mongo', 'mongo-express:latest': null, 'nginx:alpine': null,
    'redis:7': null, 'ghcr.io/me/postgres-backup-ui:1': 'postgres',
  };
  for (const [image, kind] of Object.entries(cases)) assert.equal(h.dbKind(image), kind, image);
});

test('rsync arguments are an array with the expected safety flags', () => {
  const a = h.rsyncArgs(h.DEFAULTS, { linkDest: '/mnt/backup/host/20261007-023000' });
  for (const flag of ['-aAXH', '--one-file-system', '--relative', '--delete', '--numeric-ids']) assert.ok(a.includes(flag), flag);
  assert.ok(a.includes('--exclude=node_modules') && a.includes('--exclude=.next/cache'));
  assert.ok(a.includes('--link-dest=/mnt/backup/host/20261007-023000'));
  assert.ok(h.rsyncArgs(h.DEFAULTS, { dryRun: true }).includes('--dry-run'));
});

test('CLI rejects unknown commands, options and bad arguments before doing anything', () => {
  const cases = [
    ['rm', '-rf', '/'],
    ['run', '--force'],
    ['run', '--targets=host,etc'],
    ['start', '--by=root;id'],
    ['ls', '../x'],
    ['ls', '20261008-023000', '../../etc'],
    ['download', '20261008-023000', 'home/../../etc/shadow'],
    ['db-download', '20261008-023000', '../../etc/shadow'],
    ['restore-container', '20261008-023000', '--force', 'new-one'],
    ['restore-container', '20261008-023000', 'sachin', 'sachin'.padEnd(70, 'x')],
    ['verify'],
    ['download', '20261008-023000'],
    ['get-config', 'extra'],
    ['restore-container', '20261008-023000'],
    ['constructor'],
    ['__proto__'],
  ];
  for (const args of cases) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /@@ERROR /);
  }
});

test('dry run refuses to go on when /mnt/backup is not a separate mounted disk', { skip: spawnSync('mountpoint', ['-q', '/mnt/backup']).status === 0 && 'the backup disk is mounted here' }, () => {
  const r = run('run', '--dry-run', '--targets=host');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /@@ERROR The backup disk is not mounted at \/mnt\/backup/);
  assert.match(r.stdout, /Would abort/);
});

test('commands other than dry run require root', { skip: process.getuid() === 0 && 'running as root' }, () => {
  const r = run('get-config');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must run as root/);
});
