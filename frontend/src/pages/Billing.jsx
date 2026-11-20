// Billing: admin (wallets, top-ups, plans, prices, settings) and the user's own wallet.
// Money comes from the API in paisa; it is shown and typed in rupees (2 decimals).
import { useState } from 'react';
import { api, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Stat, Tabs, href, useApi, useAction, useConfirm } from '../ui.jsx';

export const fmtMoney = (paisa, cur = 'NPR') => `${cur} ${((paisa || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toPaisa = (rupees) => Math.round(Number(rupees) * 100);
const STATE = { ok: ['good', 'Active'], grace: ['warn', 'Grace period'], stopped: ['bad', 'Stopped (unpaid)'] };

function WalletState({ w }) {
  const [tone, label] = STATE[w.state] || STATE.ok;
  return <Badge tone={w.low && w.state === 'ok' ? 'warn' : tone} dot>{w.low && w.state === 'ok' ? 'Low balance' : label}</Badge>;
}

function TxTable({ list, cur }) {
  if (!list?.length) return <Empty icon="audit" title="No transactions yet" />;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>When</th><th>Kind</th><th>Details</th><th className="num">Amount</th></tr></thead>
      <tbody>{list.map((t) => (
        <tr key={t.id}><td className="muted">{dateTime(t.createdAt)}</td><td><Badge tone={t.amount >= 0 ? 'good' : 'neutral'}>{t.kind}</Badge></td>
          <td>{t.note || '–'}{t.byUser && <small className="block muted">by {t.byUser}</small>}</td>
          <td className={`num ${t.amount < 0 ? 'bad' : ''}`}>{t.amount > 0 ? '+' : ''}{fmtMoney(t.amount, cur)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

function ResourceTable({ list, cur, onEnd }) {
  if (!list?.length) return <Empty icon="server" title="Nothing billed" />;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Resource</th><th>Plan</th><th className="num">Per day</th><th className="num">Per month (30 d)</th><th>Since</th><th className="num">Charged</th>{onEnd && <th />}</tr></thead>
      <tbody>{list.map((r) => (
        <tr key={r.id}><td><Icon name={{ server: 'server', app: 'app' }[r.kind] || 'disk'} size={14} /> <strong>{r.name}</strong> {r.paused && <Badge tone="bad">paused</Badge>}</td>
          <td className="muted">{r.planName || 'custom price'}</td><td className="num">{fmtMoney(r.priceDay, cur)}</td><td className="num muted">{fmtMoney(r.priceDay * 30, cur)}</td>
          <td className="muted">{ago(r.startedAt)}</td><td className="num">{fmtMoney(r.charged, cur)}</td>
          {onEnd && <td><button type="button" className="btn btn--small" onClick={() => onEnd(r)}>Stop billing</button></td>}</tr>
      ))}</tbody>
    </table></div>
  );
}

// ---------- invoices ----------
function InvoiceView({ id, onClose }) {
  const { data, error } = useApi(`/api/billing/invoices/${id}`);
  const i = data?.invoice;
  const cur = data?.currency;
  return (
    <Dialog open wide title={i ? `Invoice ${i.number}` : 'Invoice'} onClose={onClose}>
      <ErrorNote error={error} />
      {!i ? <SkeletonRows /> : (
        <div className="invoice">
          <div className="invoice__head"><div><strong>Sampanna Cloud</strong><br /><span className="muted">Kathmandu, Nepal</span></div>
            <div className="num"><strong>{i.number}</strong><br />Period {i.period}<br /><span className="muted">{i.fullName || i.username}{i.email ? ` · ${i.email}` : ''}</span></div></div>
          <table className="table"><thead><tr><th>Service</th><th>Plan</th><th className="num">Hours billed</th><th className="num">Amount</th></tr></thead>
            <tbody>{i.lines.map((l) => <tr key={`${l.kind}-${l.name}`}><td>{l.kind} {l.name}</td><td className="muted">{l.plan || 'custom'}</td><td className="num">{l.hours}</td><td className="num">{fmtMoney(l.amount, cur)}</td></tr>)}
              {!i.lines.length && <tr><td colSpan={4} className="muted">No usage this month</td></tr>}</tbody></table>
          <dl className="invoice__sum">
            <dt>Opening balance</dt><dd>{fmtMoney(i.opening, cur)}</dd>
            <dt>Top-ups and credits</dt><dd>+{fmtMoney(i.topups, cur)}</dd>
            <dt>Charges</dt><dd>−{fmtMoney(i.charges, cur)}</dd>
            {i.adjustments !== 0 && <><dt>Corrections</dt><dd>{fmtMoney(i.adjustments, cur)}</dd></>}
            <dt><strong>Closing balance</strong></dt><dd><strong>{fmtMoney(i.closing, cur)}</strong></dd>
          </dl>
          <p className="muted small">Prepaid statement: charges were taken from the wallet hourly. Prices in {cur}.</p>
        </div>
      )}
      <div className="dialog__buttons"><button type="button" className="btn" onClick={() => window.print()}>Print / save as PDF</button><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function Invoices({ user }) {
  const { data, error } = useApi(`/api/billing/invoices${user ? `?user=${user}` : ''}`);
  const [open, setOpen] = useState(null);
  const cur = data?.currency;
  return (
    <Card title="Invoices" sub="A statement is made for every month with activity (Nepal time)" pad={false}>
      <ErrorNote error={error} />
      {!data ? <div className="pad"><SkeletonRows rows={2} /></div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Month</th><th>Number</th><th className="num">Charges</th><th className="num">Top-ups</th><th className="num">Closing balance</th><th /></tr></thead>
          <tbody>
            {data.current && <tr><td>{data.current.period} <Badge tone="warn">so far</Badge></td><td className="muted">–</td><td className="num">{fmtMoney(data.current.charges, cur)}</td><td className="num">{fmtMoney(data.current.topups, cur)}</td><td className="num">{fmtMoney(data.current.closing, cur)}</td><td /></tr>}
            {data.invoices.map((i) => <tr key={i.id}><td>{i.period}</td><td className="mono small">{i.number}</td><td className="num">{fmtMoney(i.charges, cur)}</td><td className="num">{fmtMoney(i.topups, cur)}</td><td className="num">{fmtMoney(i.closing, cur)}</td>
              <td><button type="button" className="btn btn--small" onClick={() => setOpen(i.id)}>View</button></td></tr>)}
          </tbody>
        </table></div>
      )}
      {open && <InvoiceView id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function HostingPackage() {
  const run = useAction();
  const { data, reload } = useApi('/api/hosting');
  const [pick, setPick] = useState('');
  if (!data) return null;
  const pkg = data.package;
  return (
    <Card title="Hosting package (main server)" sub={pkg ? 'Covers all your apps on the main server' : 'Starts with your first app on the main server (Applications → New application → Main server)'}>
      {pkg ? (
        <>
          <p><strong>{pkg.name}</strong> · {pkg.cpu} CPU · {pkg.memoryMb >= 1024 ? `${pkg.memoryMb / 1024} GB` : `${pkg.memoryMb} MB`} RAM · {pkg.diskGb} GB · {data.appsUsed} of {pkg.maxApps ?? '∞'} apps · {fmtMoney(pkg.priceDay)}/day</p>
          <div className="inline-form">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Change package…</option>
              {data.packages.filter((p) => p.id !== pkg.id).map((p) => <option key={p.id} value={p.id}>{p.name}: {p.maxApps ?? '∞'} apps, {p.cpu} CPU, {p.memoryMb} MB, {p.diskGb} GB · {fmtMoney(p.priceDay)}/day</option>)}
            </select>
            <button type="button" className="btn btn--primary" disabled={!pick} onClick={async () => { if (await run(() => api('/api/hosting', { method: 'PUT', body: { planId: Number(pick) } }), 'Package changed')) { setPick(''); reload(); } }}>Change</button>
          </div>
        </>
      ) : <p className="muted">No package yet.</p>}
    </Card>
  );
}

// ---------- user ----------
export function Wallet() {
  const { data, error, reload } = useApi('/api/billing/me', { interval: 60_000 });
  const plans = useApi('/api/billing/plans');
  const w = data?.wallet;
  const cur = w?.currency || plans.data?.currency;
  return (
    <>
      <PageHeader title="Wallet & billing" sub="Prepaid balance. Your servers and databases are charged by the hour from it." />
      <ErrorNote error={error} onRetry={reload} />
      {w?.state === 'grace' && <Note tone="warn">Your balance is empty. Your services keep running until <strong>{dateTime(w.graceEndsAt)}</strong>, then they are stopped (not deleted). Ask the administrator to top up your wallet.</Note>}
      {w?.state === 'stopped' && <Note tone="bad">Your services are stopped because the balance is empty. Nothing was deleted. After a top-up you can start them again.</Note>}
      {w?.low && w.state === 'ok' && <Note tone="warn">Low balance: about {w.daysLeft} day(s) left. Ask the administrator to top up.</Note>}
      <div className="kpis">
        <Stat label="Balance" icon="storage" value={w ? fmtMoney(w.balance, cur) : null} sub={w && <WalletState w={w} />} />
        <Stat label="Cost per day" icon="chart" value={w ? fmtMoney(w.burnPerDay, cur) : null} sub={w ? `${fmtMoney(w.burnPerDay * 30, cur)} per 30 days` : ''} />
        <Stat label="Days left" icon="activity" value={w ? (w.daysLeft ?? '∞') : null} sub="at the current cost" />
        <Stat label="Billed services" icon="server" value={w ? w.resources.length : null} />
      </div>
      <Card title="What you pay for" pad={false}>{!data ? <div className="pad"><SkeletonRows /></div> : <ResourceTable list={w.resources} cur={cur} />}</Card>
      <Card title="Prices" sub="Create a server from My servers → New server, or a database from Managed databases." pad={false}>
        {!plans.data ? <div className="pad"><SkeletonRows /></div> : <PlanTable plans={plans.data.plans} cur={cur} />}
      </Card>
      <HostingPackage />
      <Invoices />
      <Card title="Transactions" pad={false}>{!data ? <div className="pad"><SkeletonRows /></div> : <TxTable list={data.transactions} cur={cur} />}</Card>
    </>
  );
}

function PlanTable({ plans, cur, onEdit, onDelete }) {
  if (!plans.length) return <Empty icon="chart" title="No plans yet" />;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Plan</th><th>Kind</th><th>Size</th><th className="num">Per day</th><th className="num">Per month (30 d)</th>{onEdit && <th />}</tr></thead>
      <tbody>{plans.map((p) => (
        <tr key={p.id}><td><strong>{p.name}</strong> {!p.active && <Badge>hidden</Badge>}{p.description && <small className="block muted">{p.description}</small>}</td>
          <td>{{ server: 'Server', app: 'Hosting package', database: 'Database' }[p.kind] || p.kind}</td>
          <td className="muted">{p.kind === 'app' && <strong>{p.maxApps == null ? 'Unlimited apps' : `${p.maxApps} app${p.maxApps === 1 ? '' : 's'}`} · </strong>}{p.kind !== 'database' ? `${p.cpu} CPU · ${p.memoryMb >= 1024 ? `${p.memoryMb / 1024} GB` : `${p.memoryMb} MB`} RAM · ${p.diskGb} GB disk` : `${p.memoryMb} MB RAM`}</td>
          <td className="num">{fmtMoney(p.priceDay, cur)}</td><td className="num muted">{fmtMoney(p.priceDay * 30, cur)}</td>
          {onEdit && <td><div className="row-actions"><button type="button" className="btn btn--small" onClick={() => onEdit(p)}>Edit</button>
            <button type="button" className="btn btn--small btn--danger" onClick={() => onDelete(p)}>Delete</button></div></td>}</tr>
      ))}</tbody>
    </table></div>
  );
}

// ---------- admin ----------
function PlanDialog({ plan, rates, cur, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState(() => ({
    kind: plan?.kind || 'server', name: plan?.name || '', cpu: plan?.cpu ?? 1, memoryMb: plan?.memoryMb ?? 1024, diskGb: plan?.diskGb ?? 20,
    price: plan ? (plan.priceDay / 100).toFixed(2) : '', active: plan ? plan.active : true, maxApps: plan?.maxApps ?? '', description: plan?.description || '', sort: plan?.sort ?? 0, applyToExisting: false,
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const suggested = Math.round((rates.cpuDay || 0) * (f.kind !== 'database' ? Number(f.cpu) : 0) + ((rates.ramGbDay || 0) * Number(f.memoryMb)) / 1024
    + (f.kind !== 'database' ? (rates.diskGbDay || 0) * Number(f.diskGb) : 0) + (f.kind === 'database' ? rates.dbDay || 0 : 0));
  async function submit(e) {
    e.preventDefault();
    const body = { kind: f.kind, name: f.name, memoryMb: Number(f.memoryMb), priceDay: toPaisa(f.price), active: f.active, description: f.description, sort: Number(f.sort) || 0,
      ...(f.kind !== 'database' ? { cpu: Number(f.cpu), diskGb: Number(f.diskGb) } : {}), applyToExisting: f.applyToExisting,
      ...(f.kind === 'app' ? { maxApps: f.maxApps === '' ? null : Number(f.maxApps) } : {}) };
    const ok = await run(() => api(plan ? `/api/billing/plans/${plan.id}` : '/api/billing/plans', { method: plan ? 'PUT' : 'POST', body }), plan ? 'Plan saved' : 'Plan created');
    if (ok) { onDone(); onClose(); }
  }
  return (
    <Dialog open title={plan ? `Edit plan ${plan.name}` : 'New plan'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Kind"><select value={f.kind} disabled={!!plan} onChange={set('kind')}><option value="server">Server (LXD VPS)</option><option value="app">Hosting package (apps on the main server)</option><option value="database">Managed database</option></select></Field>
          <Field label="Name"><input required maxLength={40} value={f.name} onChange={set('name')} placeholder="Small" /></Field>
          {f.kind !== 'database' && <Field label="CPU cores"><input type="number" min={1} max={64} required value={f.cpu} onChange={set('cpu')} /></Field>}
          <Field label="Memory (MB)"><input type="number" min={128} step={128} required value={f.memoryMb} onChange={set('memoryMb')} /></Field>
          {f.kind !== 'database' && <Field label="Disk (GB)"><input type="number" min={1} required value={f.diskGb} onChange={set('diskGb')} /></Field>}
          <Field label={`Price per day (${cur})`} hint={suggested ? `From your rates: ${fmtMoney(suggested, cur)}/day` : `${fmtMoney(toPaisa(f.price || 0) * 30, cur)} per 30 days`}>
            <input type="number" min={0} step="0.01" required value={f.price} onChange={set('price')} placeholder="50.00" />
          </Field>
          {f.kind === 'app' && <Field label="Apps included" hint="Empty = unlimited"><input type="number" min={1} value={f.maxApps} onChange={set('maxApps')} placeholder="5" /></Field>}
          <Field label="Order"><input type="number" min={0} value={f.sort} onChange={set('sort')} /></Field>
        </div>
        <Field label="Description (shown to users)" wide><input maxLength={200} value={f.description} onChange={set('description')} placeholder="Good for a small website" /></Field>
        {suggested > 0 && <button type="button" className="btn btn--small" onClick={() => setF({ ...f, price: (suggested / 100).toFixed(2) })}>Use the price from rates</button>}
        <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Users can pick this plan</label>
        {plan && <label className="check"><input type="checkbox" checked={f.applyToExisting} onChange={set('applyToExisting')} /> Also change the price of servers/databases already on this plan (from now on)</label>}
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Save</button></div>
      </form>
    </Dialog>
  );
}

function TopUp({ w, cur, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ kind: 'topup', amount: '', note: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    const ok = await run(() => api(`/api/billing/users/${w.userId}/tx`, { method: 'POST', body: { kind: f.kind, amount: toPaisa(f.amount), note: f.note || undefined } }), 'Saved');
    if (ok) { onDone(); onClose(); }
  }
  return (
    <Dialog open title={`Wallet of ${w.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p>Balance now: <strong>{fmtMoney(w.balance, cur)}</strong></p>
        <Field label="Kind"><select value={f.kind} onChange={set('kind')}><option value="topup">Top up (payment received)</option><option value="refund">Refund / credit</option><option value="adjust">Correction (may be negative)</option></select></Field>
        <Field label={`Amount (${cur})`}><input type="number" step="0.01" min={f.kind === 'adjust' ? undefined : 0.01} required autoFocus value={f.amount} onChange={set('amount')} placeholder="500" /></Field>
        <Field label="Note" hint="e.g. eSewa / Khalti / bank reference"><input maxLength={200} value={f.note} onChange={set('note')} /></Field>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Save</button></div>
      </form>
    </Dialog>
  );
}

function UserWallet({ id, cur, onClose }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/billing/users/${id}`);
  const [f, setF] = useState({ kind: 'server', name: '', price: '' });
  const end = async (r) => {
    if (await confirm({ title: `Stop billing ${r.name}?`, body: 'It is charged up to now and then no more. The server or database itself is not touched.' })) {
      if (await run(() => api(`/api/billing/resources/${r.id}`, { method: 'DELETE' }), 'Billing stopped')) reload();
    }
  };
  const add = async (e) => {
    e.preventDefault();
    if (await run(() => api('/api/billing/resources', { method: 'POST', body: { userId: id, kind: f.kind, name: f.name.trim(), priceDay: toPaisa(f.price) } }), 'Billing set')) { setF({ ...f, name: '', price: '' }); reload(); }
  };
  return (
    <Dialog open wide title={data ? `Billing: ${data.wallet.username}` : 'Billing'} onClose={onClose}>
      <ErrorNote error={error} />
      {!data ? <SkeletonRows /> : (
        <>
          <p>Balance <strong>{fmtMoney(data.wallet.balance, cur)}</strong> · {fmtMoney(data.wallet.burnPerDay, cur)}/day · <WalletState w={data.wallet} /></p>
          <h3>Billed resources</h3>
          <ResourceTable list={data.wallet.resources} cur={cur} onEnd={end} />
          <form className="inline-form mt12" onSubmit={add}>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="server">Server</option><option value="database">Database</option></select>
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="their server name" />
            <input required type="number" min={0} step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder={`${cur}/day`} />
            <button type="submit" className="btn">Bill it / set price</button>
          </form>
          <p className="muted small">Use this for servers you assigned before billing existed, or to give one user a special price.</p>
          <h3>Transactions</h3>
          <TxTable list={data.transactions} cur={cur} />
          <Invoices user={id} />
        </>
      )}
      <div className="dialog__buttons"><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function SettingsForm({ s, onDone }) {
  const run = useAction();
  const [f, setF] = useState(() => ({
    enabled: s.enabled, currency: s.currency, graceHours: s.graceHours, minDays: s.minDays, lowDays: s.lowDays,
    cpuDay: ((s.rates.cpuDay || 0) / 100).toFixed(2), ramGbDay: ((s.rates.ramGbDay || 0) / 100).toFixed(2), diskGbDay: ((s.rates.diskGbDay || 0) / 100).toFixed(2), dbDay: ((s.rates.dbDay || 0) / 100).toFixed(2),
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function submit(e) {
    e.preventDefault();
    const body = { enabled: f.enabled, currency: f.currency, graceHours: Number(f.graceHours), minDays: Number(f.minDays), lowDays: Number(f.lowDays),
      rates: { cpuDay: toPaisa(f.cpuDay), ramGbDay: toPaisa(f.ramGbDay), diskGbDay: toPaisa(f.diskGbDay), dbDay: toPaisa(f.dbDay) } };
    if (await run(() => api('/api/billing/settings', { method: 'PUT', body }), 'Billing settings saved')) onDone();
  }
  return (
    <form className="form" onSubmit={submit}>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Billing on (charge wallets, stop services when unpaid)</label>
      <div className="fgrid">
        <Field label="Currency"><input required maxLength={6} value={f.currency} onChange={set('currency')} /></Field>
        <Field label="Grace period (hours)" hint="Balance 0 → services keep running this long, then stop"><input type="number" min={0} max={720} value={f.graceHours} onChange={set('graceHours')} /></Field>
        <Field label="Balance needed to create (days)" hint="Days of all their services the balance must cover"><input type="number" min={0} max={90} value={f.minDays} onChange={set('minDays')} /></Field>
        <Field label="Low-balance warning (days left)"><input type="number" min={0} max={90} value={f.lowDays} onChange={set('lowDays')} /></Field>
      </div>
      <h3>Pay-per-resource rates (per day)</h3>
      <p className="muted small">Like AWS: these suggest a plan's price from its size. Plans keep the price you save on them.</p>
      <div className="fgrid">
        <Field label={`Per CPU core (${f.currency})`}><input type="number" min={0} step="0.01" value={f.cpuDay} onChange={set('cpuDay')} /></Field>
        <Field label={`Per GB RAM (${f.currency})`}><input type="number" min={0} step="0.01" value={f.ramGbDay} onChange={set('ramGbDay')} /></Field>
        <Field label={`Per GB disk (${f.currency})`}><input type="number" min={0} step="0.01" value={f.diskGbDay} onChange={set('diskGbDay')} /></Field>
        <Field label={`Per database (${f.currency})`}><input type="number" min={0} step="0.01" value={f.dbDay} onChange={set('dbDay')} /></Field>
      </div>
      <div><button type="submit" className="btn btn--primary">Save settings</button></div>
    </form>
  );
}

export default function Billing({ tab = 'wallets' }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const ov = useApi('/api/billing/overview', { interval: 60_000 });
  const plans = useApi('/api/billing/plans');
  const [edit, setEdit] = useState(null);
  const [top, setTop] = useState(null);
  const [open, setOpen] = useState(null);
  const s = ov.data?.settings;
  const cur = s?.currency || 'NPR';
  const t = ov.data?.totals;
  const delPlan = async (p) => {
    if (await confirm({ title: `Delete plan ${p.name}?`, danger: true, confirmLabel: 'Delete', body: 'Servers and databases on it keep their current price. Users can no longer pick it.' })) {
      if (await run(() => api(`/api/billing/plans/${p.id}`, { method: 'DELETE' }), 'Plan deleted')) plans.reload();
    }
  };
  return (
    <>
      <PageHeader title="Billing" sub="Prepaid wallets, plans and daily prices for users who deploy on your servers"
        actions={sup && tab === 'plans' && <div className="btn-row">
          <button type="button" className="btn" onClick={async () => { const r = await run(() => api('/api/billing/plans/starter', { method: 'POST' }), (x) => (x.created.length ? `Added ${x.created.length} plans` : 'All starter plans already exist')); if (r) plans.reload(); }}>Add starter plans</button>
          <button type="button" className="btn btn--primary" onClick={() => setEdit({})}><Icon name="plus" /> New plan</button></div>} />
      <ErrorNote error={ov.error || plans.error} onRetry={() => { ov.reload(); plans.reload(); }} />
      {s && !s.enabled && <Note tone="warn">Billing is off: nothing is charged and nobody is stopped.</Note>}
      <div className="kpis">
        <Stat label="Money in wallets" icon="storage" value={t ? fmtMoney(t.balance, cur) : null} />
        <Stat label="Earning per day" icon="chart" value={t ? fmtMoney(t.burnPerDay, cur) : null} sub={t ? `${fmtMoney(t.burnPerDay * 30, cur)} per 30 days` : ''} />
        <Stat label="Charged, last 30 days" icon="activity" value={t ? fmtMoney(t.charged30d, cur) : null} />
        <Stat label="Top-ups, last 30 days" icon="plus" value={t ? fmtMoney(t.topups30d, cur) : null} />
      </div>
      <Tabs tabs={[['wallets', 'Users & wallets'], ['plans', 'Plans & prices'], ['settings', 'Settings']]} value={tab} hrefFor={(id) => href(`billing/${id}`)} />
      {tab === 'wallets' && (
        <Card pad={false}>
          {!ov.data ? <div className="pad"><SkeletonRows /></div> : !ov.data.wallets.length ? <Empty icon="users" title="No user accounts yet">Create users on the Users page; give them an ID and password, then top up their wallet here.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>User</th><th>State</th><th className="num">Balance</th><th className="num">Per day</th><th className="num">Days left</th><th>Services</th><th /></tr></thead>
              <tbody>{ov.data.wallets.map((w) => (
                <tr key={w.userId}><td><strong>{w.username}</strong></td><td><WalletState w={w} />{w.graceEndsAt && <small className="block muted">stops {dateTime(w.graceEndsAt)}</small>}</td>
                  <td className={`num ${w.balance <= 0 ? 'bad' : ''}`}>{fmtMoney(w.balance, cur)}</td><td className="num">{fmtMoney(w.burnPerDay, cur)}</td>
                  <td className="num">{w.daysLeft ?? '–'}</td><td className="muted">{w.resources.map((r) => r.name).join(', ') || '–'}</td>
                  <td><div className="row-actions">{sup && <button type="button" className="btn btn--small btn--primary" onClick={() => setTop(w)}>Top up</button>}
                    <button type="button" className="btn btn--small" onClick={() => setOpen(w.userId)}>Details</button></div></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}
      {tab === 'plans' && (
        <Card pad={false} sub="Users pick these when they create a server or database themselves. Admins can still create any size.">
          {!plans.data ? <div className="pad"><SkeletonRows /></div> : <PlanTable plans={plans.data.plans} cur={cur} onEdit={sup ? setEdit : null} onDelete={delPlan} />}
        </Card>
      )}
      {tab === 'settings' && <Card>{!s ? <SkeletonRows /> : sup ? <SettingsForm s={s} onDone={ov.reload} /> : <p className="muted">Only a super admin can change billing settings.</p>}</Card>}
      {edit && s && <PlanDialog plan={edit.id ? edit : null} rates={s.rates} cur={cur} onClose={() => setEdit(null)} onDone={plans.reload} />}
      {top && <TopUp w={top} cur={cur} onClose={() => setTop(null)} onDone={ov.reload} />}
      {open && <UserWallet id={open} cur={cur} onClose={() => { setOpen(null); ov.reload(); }} />}
    </>
  );
}
