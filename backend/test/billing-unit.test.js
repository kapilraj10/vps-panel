// Unit tests for billing.js against a throwaway database: idempotent settlement, exact daily totals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-billing-unit-'));
process.env.DB_PATH = path.join(tmp, 'panel.db');
process.env.SESSION_SECRET = 'u'.repeat(64);
const { db, users } = await import('../db.js');
const { createBilling } = await import('../billing.js');
const billing = createBilling();
const HOUR = 3_600_000;

const uid = users.create({ username: 'tenant', passwordHash: 'x', role: 'user' });
db.prepare('UPDATE users SET balance = 100000 WHERE id = ?').run(uid);

test('a duplicate or stale settlement never charges the same period twice', () => {
  const r = billing.start({ userId: uid, kind: 'server', name: 'web', priceDay: 2400 });
  const past = Date.now() - 10 * HOUR;
  db.prepare('UPDATE billed_resources SET billed_until = ? WHERE id = ?').run(past, r.id);
  const stale = db.prepare('SELECT * FROM billed_resources WHERE id = ?').get(r.id);
  const now = Date.now();
  const first = billing.settle(stale, now);
  const second = billing.settle(stale, now); // same old row object, as a duplicate job would have
  assert.ok(first >= 999 && first <= 1001, `10 h of 2400/day ≈ 1000 (got ${first})`);
  assert.equal(second, 0);
  const sum = db.prepare("SELECT SUM(amount) AS s, COUNT(*) AS n FROM wallet_tx WHERE user_id = ? AND kind = 'charge'").get(uid);
  assert.equal(sum.n, 1);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance, 100000 + sum.s);
});

test('many small settlements add up to exactly the daily price', () => {
  const r = billing.start({ userId: uid, kind: 'database', name: 'db1', priceDay: 1000 });
  const start = Date.now() - 24 * HOUR;
  db.prepare('UPDATE billed_resources SET billed_until = ?, started_at = ? WHERE id = ?').run(start, start, r.id);
  for (let t = start + 7 * 60_000; t <= start + 24 * HOUR; t += 7 * 60_000) billing.settle(db.prepare('SELECT * FROM billed_resources WHERE id = ?').get(r.id), t);
  billing.settle(db.prepare('SELECT * FROM billed_resources WHERE id = ?').get(r.id), start + 24 * HOUR);
  assert.equal(db.prepare('SELECT charged FROM billed_resources WHERE id = ?').get(r.id).charged, 1000);
});

test('migration 9 schema: Redis allowed, customer servers, invoices', () => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('plans').includes('max_apps'));
  assert.ok(cols('databases').includes('target') && cols('databases').includes('server_id'));
  assert.ok(cols('customer_servers').includes('secret_enc'));
  assert.ok(cols('invoices').includes('closing'));
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'databases'").get().sql.includes("'redis'"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
