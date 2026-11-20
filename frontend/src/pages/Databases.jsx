// Databases: PostgreSQL, MySQL and MongoDB in Docker on the master server (create, connect, start/stop, logs, delete).
import { useState } from 'react';
import { api, ago, bytes, getCsrf, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Stat, Copy, useApi, useAction, useConfirm } from '../ui.jsx';
import { LogDialog } from './Pm2Page.jsx';
import { fmtMoney } from './Billing.jsx';

const BUSY = ['queued', 'pulling', 'creating'];
const STATE = { running: 'good', exited: 'neutral', restarting: 'warn', paused: 'warn', dead: 'bad' };

function NewDatabase({ options, onClose, onDone, self = false }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', engine: 'postgres', version: '', dbName: 'app', user: 'app', access: self ? 'containers' : 'local', memoryMb: '', notes: '', planId: '', target: 'main', serverId: '' });
  const vps = useApi(self ? '/api/my-servers' : null);
  const myVps = vps.data?.servers || [];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === 'engine' ? { version: '' } : {}) });
  const eng = options.engines[f.engine];
  async function submit(e) {
    e.preventDefault();
    const body = { ...f, version: f.version || eng.versions[0], memoryMb: f.memoryMb ? Number(f.memoryMb) : undefined, planId: f.planId ? Number(f.planId) : undefined };
    if (f.target === 'vps') { body.serverId = Number(f.serverId || myVps[0]?.id); delete body.planId; } else delete body.serverId;
    if (await run(() => api('/api/databases', { method: 'POST', body }), `${f.name}: creating (first time downloads the image, a few minutes)`)) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="New database" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        {self && (
          <div className="plan-grid">
            {[['main', 'Main server (managed)', 'Runs on Sampanna Cloud, backed up every night, billed per day'], ['vps', 'My VPS', myVps.length ? 'Docker on your own connected server, no charge' : 'Connect a VPS first (My VPS servers)']].map(([id, label, sub]) => (
              <label key={id} className={`plan-card ${f.target === id ? 'is-on' : ''} ${id === 'vps' && !myVps.length ? 'is-off' : ''}`}>
                <input type="radio" name="dbtarget" disabled={id === 'vps' && !myVps.length} checked={f.target === id} onChange={() => setF({ ...f, target: id })} />
                <strong>{label}</strong><small className="muted">{sub}</small>
              </label>
            ))}
          </div>
        )}
        <div className="fgrid">
          <Field label="Name" hint="a-z, 0-9, dash (3-32)"><input required autoFocus pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" value={f.name} onChange={set('name')} placeholder="shop" /></Field>
          <Field label="Engine">
            <select value={f.engine} onChange={set('engine')}>{Object.entries(options.engines).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select>
          </Field>
          <Field label="Version"><select value={f.version || eng.versions[0]} onChange={set('version')}>{eng.versions.map((v) => <option key={v}>{v}</option>)}</select></Field>
          <Field label="Database name"><input required pattern="[a-z_][a-z0-9_]{0,30}" value={f.dbName} onChange={set('dbName')} /></Field>
          <Field label={f.engine === 'mongo' ? 'Admin user' : 'User'}><input required pattern="[a-z_][a-z0-9_]{0,30}" value={f.user} onChange={set('user')} /></Field>
          {self && f.target === 'vps' ? (
            <>
              <Field label="Your VPS"><select required value={f.serverId || myVps[0]?.id || ''} onChange={set('serverId')}>{myVps.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.host})</option>)}</select></Field>
              <Field label="Memory limit (MB)" hint="Empty = no limit"><input type="number" min={128} value={f.memoryMb} onChange={set('memoryMb')} placeholder="512" /></Field>
            </>
          ) : self ? (
            <Field label="Plan" hint="Charged by the hour from your wallet">
              <select required value={f.planId} onChange={set('planId')}><option value="">Pick a plan</option>
                {options.plans.map((p) => <option key={p.id} value={p.id}>{p.name}: {p.memoryMb} MB RAM, {fmtMoney(p.priceDay)}/day</option>)}</select>
            </Field>
          ) : <Field label="Memory limit (MB)" hint="Empty = no limit"><input type="number" min={128} value={f.memoryMb} onChange={set('memoryMb')} placeholder="1024" /></Field>}
        </div>
        {!self && (
          <Field label="Who can connect" wide>
            <select value={f.access} onChange={set('access')}>{options.access.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
          </Field>
        )}
        {self && f.target === 'main' && <Note>Your servers reach it on the private network address shown under Connect. It is never open to the internet.</Note>}
        {self && f.target === 'vps' && <Note>Created with Docker on your VPS, listening on 127.0.0.1 there (apps on that server use it). Back it up on your server; the nightly backups cover main-server databases only.</Note>}
        <Field label="Notes" wide><input maxLength={300} value={f.notes} onChange={set('notes')} placeholder="Used by the shop API" /></Field>
        <Note>A strong password is generated and stored encrypted. The port is never opened to the internet. Daily backups include it automatically (Backups → Databases).</Note>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Create</button></div>
      </form>
    </Dialog>
  );
}

function Credentials({ db, onClose }) {
  const { data, error } = useApi(`/api/databases/${db.id}/credentials`);
  const [show, setShow] = useState(false);
  const mask = (s) => (show ? s : s.replace(/:[^:@]+@/, ':••••••••@'));
  return (
    <Dialog open title={`Connect to ${db.name}`} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!data ? <SkeletonRows rows={3} /> : (
        <>
          <dl className="kv">
            <dt>Host</dt><dd className="mono">{data.host}</dd>
            <dt>Port</dt><dd className="mono">{data.port}</dd>
            <dt>Database</dt><dd className="mono">{data.dbName}</dd>
            <dt>User</dt><dd className="mono">{data.user}</dd>
            <dt>Password</dt><dd className="mono">{show ? data.password : '••••••••••••'} <Copy text={data.password} /></dd>
            {data.rootPassword && <><dt>MySQL root</dt><dd className="mono">{show ? data.rootPassword : '••••••••••••'} <Copy text={data.rootPassword} /></dd></>}
            <dt>URL</dt><dd className="mono small">{mask(data.url)} <Copy text={data.url} /></dd>
          </dl>
          <Note>{data.note} Viewing this is recorded in the audit log.</Note>
        </>
      )}
      <div className="dialog__buttons">
        {data && <button type="button" className="btn" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'} passwords</button>}
        <button type="button" className="btn btn--primary" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}

function Usage({ d }) {
  const { data } = useApi(d.status === 'ready' ? `/api/databases/${d.id}/stats` : null, { interval: 15_000 });
  if (!data?.running) return <span className="muted">–</span>;
  return <span className="small">{Math.round(data.cpu * 10) / 10}% CPU<br />{bytes(data.memory)}{data.memoryLimit ? ` / ${bytes(data.memoryLimit)}` : ''}</span>;
}

function Restore({ d, onClose }) {
  const [file, setFile] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function go(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch(`/api/databases/${d.id}/restore?confirm=${encodeURIComponent(typed)}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': getCsrf(), 'content-type': 'application/octet-stream' }, body: file });
      setResult(await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })));
    } catch (err) { setResult({ ok: false, error: err.message }); }
    setBusy(false);
  }
  return (
    <Dialog open wide title={`Restore ${d.name}`} onClose={onClose}>
      <form className="form" onSubmit={go}>
        <Note tone="warn">The dump is loaded into the running database and can overwrite tables with the same names{d.engine === 'mongo' ? ' (MongoDB: collections in the dump are dropped first)' : ''}. Download a fresh dump first if unsure.</Note>
        <Field label="Dump file" hint=".sql / .sql.gz (PostgreSQL, MySQL) or .archive / .archive.gz (MongoDB), e.g. from Backups or Download dump"><input type="file" required onChange={(e) => setFile(e.target.files[0] || null)} /></Field>
        <Field label={`Type ${d.name} to confirm`}><input required value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
        {result && (result.ok ? <Note>Restored ({bytes(result.bytes)}).</Note> : <ErrorNote error={result.error || 'Restore failed'} />)}
        {result?.output && <pre className="log">{result.output}</pre>}
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn--primary btn--danger" disabled={busy || typed !== d.name || !file}>{busy ? 'Restoring…' : 'Restore'}</button></div>
      </form>
    </Dialog>
  );
}

export default function Databases() {
  const { me } = useLive();
  const self = !me.isAdmin;
  const sup = me.role === 'super_admin' || self; // users manage their own databases
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/databases', { interval: 5000 });
  const options = useApi('/api/databases/options');
  const [creating, setCreating] = useState(false);
  const [creds, setCreds] = useState(null);
  const [logs, setLogs] = useState(null);
  const [restore, setRestore] = useState(null);
  const list = data?.databases || [];
  const act = async (d, a) => { if (await run(() => api(`/api/databases/${d.id}/${a}`, { method: 'POST' }), `${d.name}: ${a} done`)) reload(); };
  async function remove(d) {
    const typed = await confirm({
      title: `Delete ${d.name}?`, danger: true, typed: d.name, confirmLabel: 'Delete',
      body: <>The container is removed. Its data volume <code>{d.volume}</code> is <strong>kept</strong>, so the data can be recovered. To delete the data too, use “Delete with data”.</>,
    });
    if (typed && await run(() => api(`/api/databases/${d.id}`, { method: 'DELETE', body: { confirm: typed } }), `${d.name} deleted, data volume kept`)) reload();
  }
  async function removeAll(d) {
    const typed = await confirm({
      title: `Delete ${d.name} AND its data?`, danger: true, typed: d.name, confirmLabel: 'Delete everything',
      body: <>The container and the volume <code>{d.volume}</code> are deleted. <strong>The data cannot be recovered</strong> except from a backup.</>,
    });
    if (typed && await run(() => api(`/api/databases/${d.id}`, { method: 'DELETE', body: { confirm: typed, deleteData: true } }), `${d.name} and its data deleted`)) reload();
  }
  const by = (e) => list.filter((d) => d.engine === e).length;
  return (
    <>
      <PageHeader title={self ? 'Managed databases' : 'Databases'} sub={self ? 'PostgreSQL, MySQL and MongoDB run for you on the cloud, backed up every night, billed per day' : 'PostgreSQL, MySQL and MongoDB on this server (Docker)'}
        actions={sup && options.data && <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" /> New database</button>} />
      <div className="kpis">
        <Stat label="Databases" icon="storage" value={data ? list.length : null} sub={data ? `${list.filter((d) => d.state === 'running').length} running` : ''} />
        <Stat label="PostgreSQL" icon="disk" value={data ? by('postgres') : null} />
        <Stat label="MySQL" icon="disk" value={data ? by('mysql') : null} />
        <Stat label="MongoDB" icon="disk" value={data ? by('mongo') : null} />
      </div>
      <ErrorNote error={error || data?.dockerError || options.error} onRetry={reload} />
      <Card pad={false} title="All databases">
        {!data && !error && <div className="pad"><SkeletonRows /></div>}
        {data && !list.length && <Empty icon="storage" title="No databases yet" action={sup && options.data && <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>Create the first one</button>}>Each database runs in its own container with its own volume, password and port.</Empty>}
        {list.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Engine</th><th>Where</th><th>Status</th><th>Usage</th><th>Address</th><th>Database / user</th><th>Created</th><th /></tr></thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.name}</strong>{d.notes && <><br /><small className="muted">{d.notes}</small></>}</td>
                    <td>{d.engineLabel} {d.version}<br /><small className="muted mono">{d.image}</small></td>
                    <td>{d.target === 'vps' ? <>My VPS<br /><small className="muted">{d.serverName}</small></> : 'Main server'}{!self && d.ownerId && <small className="block muted">customer</small>}</td>
                    <td>
                      {BUSY.includes(d.status) ? <Badge tone="warn" dot>{d.status}…</Badge>
                        : d.status === 'error' ? <Badge tone="bad" dot>failed</Badge>
                          : <Badge tone={STATE[d.state] || 'bad'} dot>{d.state || 'missing'}</Badge>}
                      {d.error && <><br /><small className="bad">{d.error}</small></>}
                    </td>
                    <td><Usage d={d} /></td>
                    <td className="mono small">{d.bindIp}:{d.port}</td>
                    <td className="mono small">{d.dbName} / {d.user}</td>
                    <td className="muted">{ago(d.createdAt)}<br /><small>{d.createdBy}</small></td>
                    <td>
                      <div className="row-actions">
                        {sup && d.status === 'ready' && <button type="button" className="btn btn--small btn--primary" onClick={() => setCreds(d)}>Connect</button>}
                        {d.status === 'ready' && <button type="button" className="btn btn--small" onClick={() => setLogs(d)}>Logs</button>}
                        {sup && d.status === 'ready' && d.target !== 'vps' && <a className="btn btn--small" href={`/api/databases/${d.id}/dump`} download>Download dump</a>}
                        {sup && d.status === 'ready' && d.target !== 'vps' && options.data?.engines[d.engine]?.restore && <button type="button" className="btn btn--small" onClick={() => setRestore(d)}>Restore</button>}
                        {sup && d.status === 'ready' && (d.state === 'running'
                          ? <><button type="button" className="btn btn--small" onClick={() => act(d, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(d, 'stop')}>Stop</button></>
                          : <button type="button" className="btn btn--small" onClick={() => act(d, 'start')}>Start</button>)}
                        {sup && !BUSY.includes(d.status) && <>
                          <button type="button" className="btn btn--small btn--danger" onClick={() => remove(d)}>Delete</button>
                          <button type="button" className="btn btn--small btn--danger" onClick={() => removeAll(d)}>Delete with data</button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Note>Apps on this server connect to <code>127.0.0.1:&lt;port&gt;</code>. Apps inside LXD containers need a database created with “LXD containers” access and connect to the bridge address. To reach a database from your laptop, use an SSH tunnel: <code>ssh -L 5432:127.0.0.1:&lt;port&gt; kapil@ssh.your-domain</code>.</Note>
      {creating && options.data && <NewDatabase self={self} options={options.data} onClose={() => setCreating(false)} onDone={reload} />}
      {creds && <Credentials db={creds} onClose={() => setCreds(null)} />}
      {restore && <Restore d={restore} onClose={() => { setRestore(null); reload(); }} />}
      {logs && <LogDialog title={`Logs: ${logs.name}`} url={`/api/databases/${logs.id}/logs`} onClose={() => setLogs(null)} />}
    </>
  );
}
