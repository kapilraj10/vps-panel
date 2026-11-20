// Billing: prepaid wallets, plans with a daily price, and pay-as-you-go charging (AWS style).
//
// Money is kept in paisa (1/100 of the currency unit) as whole numbers, so nothing is lost to floating point.
// Every billed thing (a user's LXD server or managed database) is a row in billed_resources with its own daily price.
// The charge loop bills each row by the hour: exact = price_day * elapsed / 24h + carry, charge floor(exact), keep
// the fraction as carry. So many small charges always add up to exactly price_day per day.
//
// When a user's balance reaches 0 they get a grace period (setting billing_grace_hours). If it is still not topped up,
// their billed servers and databases are STOPPED (never deleted) and charging pauses until the admin tops them up.
// Admins and super admins are never billed.
import express from 'express';
import { db, users, audit, settings } from './db.js';
import { clientIp, isAdmin, requireAdmin, requireSuperAdmin } from './auth.js';
import { wrap, bad, notFound, conflict, int, str, HttpError } from './http.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,39}$/;
const KINDS = ['server', 'database', 'app'];

export const paymentRequired = (msg) => new HttpError(402, msg);

const planView = (p) => p && ({
  id: p.id, kind: p.kind, name: p.name, cpu: p.cpu, memoryMb: p.memory_mb, diskGb: p.disk_gb, maxApps: p.max_apps ?? null, maxDatabases: p.max_databases ?? null,
  priceDay: p.price_day, active: !!p.active, sort: p.sort, description: p.description || '',
});
const resView = (r) => ({
  id: r.id, userId: r.user_id, username: r.username, kind: r.kind, name: r.name, planId: r.plan_id, planName: r.plan_name || null,
  priceDay: r.price_day, startedAt: r.started_at, endedAt: r.ended_at, billedUntil: r.billed_until, charged: r.charged, paused: !!r.paused,
});

export const plans = {
  get: (id) => db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id)),
  list: ({ kind = null, activeOnly = false } = {}) => db.prepare(`SELECT * FROM plans WHERE (@kind IS NULL OR kind = @kind)
    AND (@a = 0 OR active = 1) ORDER BY kind, sort, price_day, name`).all({ kind, a: activeOnly ? 1 : 0 }),
};

export function createBilling({ stopServer = async () => {}, stopDatabase = async () => {} } = {}) {
  const router = express.Router();
  const who = (req) => ({ username: req.session.username, ip: clientIp(req) });
  const cfg = () => ({
    enabled: settings.get('billing_enabled') !== false,
    currency: settings.get('billing_currency') || 'NPR',
    graceHours: Number(settings.get('billing_grace_hours') ?? 24),
    minDays: Number(settings.get('billing_min_days') ?? 1),
    lowDays: Number(settings.get('billing_low_days') ?? 3),
    rates: settings.get('billing_rates') || {},
  });

  // ---------- ledger ----------
  const balanceOf = (userId) => db.prepare('SELECT balance FROM users WHERE id = ?').get(userId)?.balance ?? 0;
  const addTx = db.transaction((userId, amount, kind, { resourceId = null, note = null, by = null } = {}) => {
    db.prepare('INSERT INTO wallet_tx (user_id, amount, kind, resource_id, note, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, amount, kind, resourceId, note, by, Date.now());
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
    return balanceOf(userId);
  });

  const activeFor = (userId) => db.prepare('SELECT * FROM billed_resources WHERE user_id = ? AND ended_at IS NULL').all(userId);
  const burnPerDay = (userId) => activeFor(userId).filter((r) => !r.paused).reduce((s, r) => s + r.price_day, 0);
  const findActive = (kind, name) => db.prepare('SELECT * FROM billed_resources WHERE kind = ? AND name = ? AND ended_at IS NULL').get(kind, name);

  // Bills one resource up to `now` (or its pause/end). Returns the amount charged.
  function settle(r, now = Date.now()) {
    const until = Math.min(now, r.ended_at || now);
    const elapsed = until - r.billed_until;
    if (elapsed <= 0) return 0;
    if (r.paused) { db.prepare('UPDATE billed_resources SET billed_until = ? WHERE id = ? AND billed_until = ?').run(until, r.id, r.billed_until); return 0; }
    const exact = (r.price_day * elapsed) / DAY + (r.carry || 0);
    const amount = Math.floor(exact + 1e-6); // tolerance: float carries must not lose a paisa over many settlements
    let charged = 0;
    db.transaction(() => {
      // Idempotent: only the settlement that still sees the old billed_until moves it and charges. A second run for the
      // same period (a retry, a duplicate job, a stale row object) changes nothing.
      const moved = db.prepare('UPDATE billed_resources SET billed_until = ?, carry = ?, charged = charged + ? WHERE id = ? AND billed_until = ?')
        .run(until, Math.max(0, exact - amount), amount, r.id, r.billed_until).changes;
      if (moved && amount > 0) {
        charged = amount;
        const hours = Math.round((elapsed / HOUR) * 100) / 100;
        addTx(r.user_id, -amount, 'charge', { resourceId: r.id, note: `${r.kind} ${r.name}: ${hours} h` });
      }
    })();
    return charged;
  }

  // Starts billing a resource for a user (idempotent per kind+name)
  function start({ userId, kind, name, planId = null, priceDay, by = null }) {
    if (!KINDS.includes(kind)) throw new Error(`bad kind ${kind}`);
    const u = users.byId(userId);
    if (!u || u.role !== 'user') return null; // admins are not billed
    const old = findActive(kind, name);
    if (old) return old;
    const now = Date.now();
    const id = db.prepare(`INSERT INTO billed_resources (user_id, kind, name, plan_id, price_day, started_at, billed_until, charged, carry, paused, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`).run(userId, kind, name, planId, priceDay, now, now, by).lastInsertRowid;
    audit.log({ username: by, action: 'billing_start', target: `${kind}:${name}`, result: 'success', detail: `${u.username}, ${priceDay} paisa/day` });
    return db.prepare('SELECT * FROM billed_resources WHERE id = ?').get(id);
  }

  // Final charge up to now, then closes the row
  function end(kind, name, by = null) {
    const r = findActive(kind, name);
    if (!r) return null;
    const now = Date.now();
    settle(r, now);
    db.prepare('UPDATE billed_resources SET ended_at = ? WHERE id = ?').run(now, r.id);
    audit.log({ username: by, action: 'billing_end', target: `${kind}:${name}`, result: 'success', detail: `charged ${r.charged} so far` });
    return r;
  }
  const rename = (kind, from, to) => db.prepare('UPDATE billed_resources SET name = ? WHERE kind = ? AND name = ? AND ended_at IS NULL').run(to, kind, from);

  // Can this user add something costing priceDay? Balance must cover minDays of everything (old + new).
  function assertCanAfford(userId, priceDay) {
    const c = cfg();
    if (!c.enabled) return;
    const u = users.byId(userId);
    if (!u || u.role !== 'user') return;
    const state = db.prepare('SELECT billing_state FROM users WHERE id = ?').get(userId)?.billing_state;
    if (state === 'stopped') throw paymentRequired('Your services are stopped for an unpaid balance. Ask the administrator to top up your wallet.');
    const need = Math.ceil((burnPerDay(userId) + priceDay) * c.minDays);
    const bal = balanceOf(userId);
    if (bal < need) {
      throw paymentRequired(`Not enough balance: this needs ${money(need, c.currency)} for ${c.minDays} day(s) of all your services, you have ${money(bal, c.currency)}. Ask the administrator to top up your wallet.`);
    }
  }
  // Starting a server/database: refused while services are stopped for non-payment or the balance is 0 or less
  function assertCanRun(session) {
    if (!cfg().enabled || isAdmin(session)) return;
    const row = db.prepare('SELECT balance, billing_state FROM users WHERE id = ?').get(session.id);
    if (row?.billing_state === 'stopped' || (row && row.balance <= 0 && burnPerDay(session.id) > 0)) {
      throw paymentRequired('Your wallet is empty. Ask the administrator to top it up, then start your services again.');
    }
  }

  // ---------- charge + enforcement loop ----------
  async function tick(now = Date.now()) {
    const c = cfg();
    if (!c.enabled) return;
    for (const r of db.prepare('SELECT * FROM billed_resources WHERE ended_at IS NULL').all()) {
      if (now - r.billed_until >= HOUR || r.paused) settle(r, now);
    }
    for (const u of db.prepare("SELECT id, username, balance, billing_state, billing_grace_since FROM users WHERE role = 'user'").all()) {
      const burn = burnPerDay(u.id);
      if (u.balance > 0) {
        if (u.billing_state) {
          db.prepare('UPDATE users SET billing_state = NULL, billing_grace_since = NULL WHERE id = ?').run(u.id);
          db.prepare('UPDATE billed_resources SET paused = 0, billed_until = ? WHERE user_id = ? AND ended_at IS NULL AND paused = 1').run(now, u.id);
          audit.log({ action: 'billing_resume', target: u.username, result: 'success', detail: `balance ${u.balance}` });
        }
        continue;
      }
      if (!burn && u.billing_state !== 'stopped') continue;
      if (!u.billing_state) {
        db.prepare("UPDATE users SET billing_state = 'grace', billing_grace_since = ? WHERE id = ?").run(now, u.id);
        audit.log({ action: 'billing_grace', target: u.username, result: 'warning', detail: `balance ${u.balance}, services stop in ${c.graceHours} h unless topped up` });
      } else if (u.billing_state === 'grace' && now - u.billing_grace_since >= c.graceHours * HOUR) {
        await suspendServices(u, now);
      }
    }
  }

  async function suspendServices(u, now = Date.now()) {
    const list = activeFor(u.id);
    const failed = [];
    for (const r of list) {
      settle(r, now);
      try {
        if (r.kind === 'server') await stopServer(r.name);
        else if (r.kind === 'app') await stopServer(r.name.split('/')[0]); // app on the main server: stop its app host
        else await stopDatabase(r.name);
      } catch (err) { failed.push(`${r.name}: ${err.message}`); }
    }
    db.prepare("UPDATE users SET billing_state = 'stopped' WHERE id = ?").run(u.id);
    db.prepare('UPDATE billed_resources SET paused = 1 WHERE user_id = ? AND ended_at IS NULL').run(u.id);
    audit.log({ action: 'billing_suspend', target: u.username, result: failed.length ? 'failure' : 'success',
      detail: `stopped ${list.map((r) => r.name).join(', ') || 'nothing'}${failed.length ? `; failed: ${failed.join('; ')}` : ''}` });
  }

  let timer = null;
  function startLoop(everyMs = Number(process.env.BILLING_TICK_MS) || 5 * 60_000) {
    const loop = () => tick().catch((e) => console.error('Billing tick failed:', e.message)).finally(() => { timer = setTimeout(loop, everyMs); timer.unref(); });
    timer = setTimeout(loop, Math.min(everyMs, 10_000));
    timer.unref();
  }

  // ---------- views ----------
  function walletOf(userId) {
    const c = cfg();
    const u = db.prepare('SELECT id, username, balance, billing_state, billing_grace_since FROM users WHERE id = ?').get(userId);
    const burn = burnPerDay(userId);
    const resources = db.prepare(`SELECT r.*, p.name AS plan_name FROM billed_resources r LEFT JOIN plans p ON p.id = r.plan_id
      WHERE r.user_id = ? AND r.ended_at IS NULL ORDER BY r.kind, r.name`).all(userId).map(resView);
    return {
      userId: u.id, username: u.username, balance: u.balance, currency: c.currency, burnPerDay: burn,
      daysLeft: burn > 0 ? Math.max(0, Math.round((u.balance / burn) * 10) / 10) : null,
      low: burn > 0 && u.balance < burn * c.lowDays,
      state: u.billing_state || 'ok', graceEndsAt: u.billing_state === 'grace' ? u.billing_grace_since + c.graceHours * HOUR : null,
      resources,
    };
  }
  const txList = (userId, limit = 100) => db.prepare(`SELECT id, amount, kind, resource_id AS resourceId, note, by_user AS byUser, created_at AS createdAt
    FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit);

  // ---------- routes: everyone ----------
  router.get('/billing/plans', (req, res) => {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    res.set('Cache-Control', 'no-store');
    res.json({ plans: plans.list({ kind, activeOnly: !isAdmin(req.session) }).map(planView), currency: cfg().currency, enabled: cfg().enabled });
  });

  router.get('/billing/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (isAdmin(req.session)) return res.json({ admin: true, currency: cfg().currency });
    for (const r of activeFor(req.session.id)) settle(r); // show an up-to-the-minute balance
    return res.json({ wallet: walletOf(req.session.id), transactions: txList(req.session.id) });
  });

  // ---------- routes: admin ----------
  router.get('/billing/overview', requireAdmin, (_req, res) => {
    const c = cfg();
    const list = db.prepare("SELECT id FROM users WHERE role = 'user' ORDER BY username").all().map((u) => walletOf(u.id));
    const since = Date.now() - 30 * DAY;
    const sum = (kind) => db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_tx WHERE kind = ? AND created_at > ?').get(kind, since).s;
    res.set('Cache-Control', 'no-store');
    res.json({
      settings: c,
      wallets: list,
      totals: { balance: list.reduce((s, w) => s + w.balance, 0), burnPerDay: list.reduce((s, w) => s + w.burnPerDay, 0), charged30d: -sum('charge'), topups30d: sum('topup') },
    });
  });

  router.get('/billing/users/:id', requireAdmin, (req, res) => {
    const u = users.byId(Number(req.params.id));
    if (!u || u.role !== 'user') throw notFound('No such user');
    res.set('Cache-Control', 'no-store');
    res.json({ wallet: walletOf(u.id), transactions: txList(u.id, 300) });
  });

  // Top up / refund / adjust. amount in paisa; adjust may be negative.
  router.post('/billing/users/:id/tx', requireSuperAdmin, wrap(async (req, res) => {
    const u = users.byId(Number(req.params.id));
    if (!u || u.role !== 'user') throw notFound('No such user');
    const b = req.body || {};
    const kind = b.kind || 'topup';
    if (!['topup', 'refund', 'adjust'].includes(kind)) throw bad('Kind must be topup, refund or adjust');
    const amount = int(b.amount, { min: kind === 'adjust' ? -1e11 : 1, max: 1e11, name: 'Amount (paisa)' });
    if (!amount) throw bad('Amount cannot be 0');
    const note = b.note ? str(b.note, { max: 200, name: 'Note', re: /^[^<>]*$/ }) : null;
    const balance = addTx(u.id, amount, kind, { note, by: req.session.username });
    audit.log({ ...who(req), action: `billing_${kind}`, target: u.username, result: 'success', detail: `${amount} paisa${note ? `: ${note}` : ''}; balance ${balance}` });
    await tick().catch(() => {}); // clears grace / stopped state right away
    res.json({ wallet: walletOf(u.id) });
  }));

  // Plans
  function parsePlan(b, old = {}) {
    const kind = b.kind ?? old.kind;
    if (!KINDS.includes(kind)) throw bad('Kind must be server, database or app');
    const sized = kind !== 'database'; // servers and apps have CPU + disk
    const out = {
      kind,
      name: str(b.name ?? old.name, { max: 40, name: 'Name', re: NAME_RE }),
      cpu: sized ? int(b.cpu ?? old.cpu, { min: 1, max: 64, name: 'CPU cores' }) : null,
      memory_mb: int(b.memoryMb ?? old.memory_mb, { min: 128, max: 262_144, name: 'Memory (MB)' }),
      disk_gb: sized ? int(b.diskGb ?? old.disk_gb, { min: 1, max: 10_000, name: 'Disk (GB)' }) : null,
      price_day: int(b.priceDay ?? old.price_day, { min: 0, max: 1e9, name: 'Price per day (paisa)' }),
      active: (b.active ?? (old.active ?? 1) ? 1 : 0),
      sort: int(b.sort ?? old.sort ?? 0, { min: 0, max: 9999, name: 'Order' }),
      // packages: how many apps / databases it includes (empty = no limit)
      max_apps: kind === 'app' ? int(b.maxApps !== undefined ? b.maxApps : old.max_apps, { min: 1, max: 1000, name: 'Max apps', optional: true }) : null,
      max_databases: int(b.maxDatabases !== undefined ? b.maxDatabases : old.max_databases, { min: 0, max: 1000, name: 'Max databases', optional: true }),
      description: b.description !== undefined ? (b.description ? str(b.description, { max: 200, name: 'Description', re: /^[^<>]*$/ }) : null) : old.description ?? null,
    };
    return out;
  }
  router.post('/billing/plans', requireSuperAdmin, (req, res) => {
    const p = parsePlan(req.body || {});
    if (db.prepare('SELECT 1 FROM plans WHERE kind = ? AND name = ?').get(p.kind, p.name)) throw conflict('A plan with that name exists');
    const now = Date.now();
    const id = db.prepare(`INSERT INTO plans (kind, name, cpu, memory_mb, disk_gb, price_day, active, sort, description, max_apps, max_databases, created_at, updated_at)
      VALUES (@kind, @name, @cpu, @memory_mb, @disk_gb, @price_day, @active, @sort, @description, @max_apps, @max_databases, @now, @now)`).run({ ...p, now }).lastInsertRowid;
    audit.log({ ...who(req), action: 'plan_create', target: p.name, result: 'success', detail: `${p.kind}, ${p.price_day} paisa/day` });
    res.status(201).json({ plan: planView(plans.get(id)) });
  });
  // One click: a sensible set of plans for every kind (prices in paisa per day; edit them afterwards). Existing names are kept.
  const STARTER = [
    ['server', 'Server Small', 1, 1024, 20, 4000, 'A small VPS for one website or API'],
    ['server', 'Server Medium', 2, 2048, 40, 7500, 'Several apps, or one busy app'],
    ['server', 'Server Large', 4, 4096, 80, 14000, 'Heavy apps and builds'],
    ['app', 'Starter', 1, 1024, 5, 2000, 'One website or API, no server to manage', 1],
    ['app', 'Professional', 2, 2048, 20, 6000, 'Up to 5 apps', 5],
    ['app', 'Business', 4, 8192, 50, 18000, 'Up to 15 apps with heavy builds', 15],
    ['database', 'DB Mini', null, 256, null, 1500, 'Small PostgreSQL / MySQL / MongoDB'],
    ['database', 'DB Standard', null, 1024, null, 3000, 'Production database'],
  ];
  router.post('/billing/plans/starter', requireSuperAdmin, (req, res) => {
    const now = Date.now();
    const made = [];
    STARTER.forEach(([kind, name, cpu, mem, disk, price, description, maxApps = null], i) => {
      if (db.prepare('SELECT 1 FROM plans WHERE kind = ? AND name = ?').get(kind, name)) return;
      db.prepare(`INSERT INTO plans (kind, name, cpu, memory_mb, disk_gb, price_day, active, sort, description, max_apps, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(kind, name, cpu, mem, disk, price, i, description, maxApps, now, now);
      made.push(name);
    });
    audit.log({ ...who(req), action: 'plan_starter', result: 'success', detail: made.join(', ') || 'all existed' });
    res.json({ created: made, plans: plans.list().map(planView) });
  });

  router.put('/billing/plans/:id', requireSuperAdmin, (req, res) => {
    const old = plans.get(req.params.id);
    if (!old) throw notFound('No such plan');
    const p = parsePlan({ ...req.body, kind: old.kind }, old);
    if (db.prepare('SELECT 1 FROM plans WHERE kind = ? AND name = ? AND id != ?').get(p.kind, p.name, old.id)) throw conflict('A plan with that name exists');
    db.prepare(`UPDATE plans SET name = @name, cpu = @cpu, memory_mb = @memory_mb, disk_gb = @disk_gb, price_day = @price_day, active = @active,
      sort = @sort, description = @description, max_apps = @max_apps, max_databases = @max_databases, updated_at = @now WHERE id = @id`).run({ ...p, now: Date.now(), id: old.id });
    // New price applies to resources on this plan from now on (they are settled at the old price first)
    if (p.price_day !== old.price_day && req.body?.applyToExisting === true) {
      for (const r of db.prepare('SELECT * FROM billed_resources WHERE plan_id = ? AND ended_at IS NULL').all(old.id)) settle(r);
      db.prepare('UPDATE billed_resources SET price_day = ? WHERE plan_id = ? AND ended_at IS NULL').run(p.price_day, old.id);
    }
    audit.log({ ...who(req), action: 'plan_update', target: p.name, result: 'success', detail: `${old.price_day} -> ${p.price_day} paisa/day${req.body?.applyToExisting ? ' (existing too)' : ''}` });
    res.json({ plan: planView(plans.get(old.id)) });
  });
  router.delete('/billing/plans/:id', requireSuperAdmin, (req, res) => {
    const old = plans.get(req.params.id);
    if (!old) throw notFound('No such plan');
    // Resources keep their own price; the plan link is cleared by ON DELETE SET NULL
    db.prepare('DELETE FROM plans WHERE id = ?').run(old.id);
    audit.log({ ...who(req), action: 'plan_delete', target: old.name, result: 'success' });
    res.json({ ok: true });
  });

  // Bill something that already exists (e.g. a server the admin made for a user before billing), or change its price
  router.post('/billing/resources', requireSuperAdmin, (req, res) => {
    const b = req.body || {};
    const u = users.byId(int(b.userId, { min: 1, max: 1e9, name: 'User' }));
    if (!u || u.role !== 'user') throw bad('Pick a user account (admins are not billed)');
    if (!['server', 'database'].includes(b.kind)) throw bad('Kind must be server or database');
    const name = str(b.name, { max: 63, name: 'Name', re: /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/ });
    if (b.kind === 'server' && !u.containers.includes(name)) throw bad(`${name} is not one of ${u.username}'s servers`);
    if (b.kind === 'database' && !db.prepare('SELECT 1 FROM databases WHERE name = ? AND owner_id = ?').get(name, u.id)) throw bad(`${name} is not one of ${u.username}'s databases`);
    const plan = b.planId ? plans.get(b.planId) : null;
    const priceDay = b.priceDay !== undefined && b.priceDay !== '' ? int(b.priceDay, { min: 0, max: 1e9, name: 'Price per day (paisa)' }) : plan?.price_day;
    if (priceDay == null) throw bad('Give a plan or a price per day');
    const old = findActive(b.kind, name);
    if (old) {
      settle(old);
      db.prepare('UPDATE billed_resources SET price_day = ?, plan_id = ? WHERE id = ?').run(priceDay, plan?.id ?? old.plan_id, old.id);
      audit.log({ ...who(req), action: 'billing_price', target: `${b.kind}:${name}`, result: 'success', detail: `${old.price_day} -> ${priceDay} paisa/day` });
    } else start({ userId: u.id, kind: b.kind, name, planId: plan?.id ?? null, priceDay, by: req.session.username });
    res.json({ wallet: walletOf(u.id) });
  });
  router.delete('/billing/resources/:id', requireSuperAdmin, (req, res) => {
    const r = db.prepare('SELECT * FROM billed_resources WHERE id = ? AND ended_at IS NULL').get(Number(req.params.id));
    if (!r) throw notFound('No such billed resource');
    end(r.kind, r.name, req.session.username);
    res.json({ wallet: walletOf(r.user_id) });
  });

  router.put('/billing/settings', requireSuperAdmin, (req, res) => {
    const b = req.body || {};
    const by = req.session.username;
    if (b.enabled !== undefined) settings.set('billing_enabled', b.enabled === true, by);
    if (b.currency !== undefined) settings.set('billing_currency', str(b.currency, { max: 6, name: 'Currency', re: /^[A-Za-z$₹€£]{1,6}$/ }), by);
    if (b.graceHours !== undefined) settings.set('billing_grace_hours', int(b.graceHours, { min: 0, max: 720, name: 'Grace hours' }), by);
    if (b.minDays !== undefined) settings.set('billing_min_days', int(b.minDays, { min: 0, max: 90, name: 'Minimum days' }), by);
    if (b.lowDays !== undefined) settings.set('billing_low_days', int(b.lowDays, { min: 0, max: 90, name: 'Low balance days' }), by);
    if (b.rates !== undefined) {
      const r = b.rates || {};
      const n = (v, name) => int(v ?? 0, { min: 0, max: 1e9, name });
      settings.set('billing_rates', { cpuDay: n(r.cpuDay, 'Rate per CPU'), ramGbDay: n(r.ramGbDay, 'Rate per GB RAM'), diskGbDay: n(r.diskGbDay, 'Rate per GB disk'), dbDay: n(r.dbDay, 'Rate per database') }, by);
    }
    audit.log({ ...who(req), action: 'billing_settings', result: 'success', detail: JSON.stringify(b).slice(0, 300) });
    res.json({ settings: cfg() });
  });

  // Price from the AWS-style rates for a spec (used when a plan has no fixed price, and shown as a hint)
  const priceFromRates = ({ cpu = 0, memoryMb = 0, diskGb = 0, database = false }) => {
    const r = cfg().rates;
    return Math.round((r.cpuDay || 0) * cpu + ((r.ramGbDay || 0) * memoryMb) / 1024 + (r.diskGbDay || 0) * diskGb + (database ? r.dbDay || 0 : 0));
  };

  // A deleted server takes its main-server apps with it
  const endPrefix = (kind, prefix, by = null) => {
    for (const r of db.prepare('SELECT kind, name FROM billed_resources WHERE kind = ? AND ended_at IS NULL').all(kind)) if (r.name.startsWith(prefix)) end(r.kind, r.name, by);
  };

  // Welcome credit for self-registered users
  const credit = (userId, amount) => addTx(userId, amount, 'topup', { note: 'Welcome credit', by: 'system' });

  return { router, credit, start, end, endPrefix, rename, settle, tick, startLoop, assertCanAfford, assertCanRun, walletOf, priceFromRates, cfg };
}

export const money = (paisa, cur = 'NPR') => `${cur} ${(paisa / 100).toFixed(2)}`;
