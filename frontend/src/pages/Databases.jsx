// Databases: PostgreSQL, MySQL and MongoDB in Docker on the master server (create, connect, start/stop, logs, delete).
import { useState } from 'react';
import { api, ago, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Stat, Copy, useApi, useAction, useConfirm } from '../ui.jsx';
import { LogDialog } from './Pm2Page.jsx';

const BUSY = ['queued', 'pulling', 'creating'];
const STATE = { running: 'good', exited: 'neutral', restarting: 'warn', paused: 'warn', dead: 'bad' };

function NewDatabase({ options, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', engine: 'postgres', version: '', dbName: 'app', user: 'app', access: 'local', memoryMb: '', notes: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === 'engine' ? { version: '' } : {}) });
  const eng = options.engines[f.engine];
  async function submit(e) {
    e.preventDefault();
    const body = { ...f, version: f.version || eng.versions[0], memoryMb: f.memoryMb ? Number(f.memoryMb) : undefined };
    if (await run(() => api('/api/databases', { method: 'POST', body }), `${f.name}: creating (first time downloads the image, a few minutes)`)) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="New database" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name" hint="a-z, 0-9, dash (3-32)"><input required autoFocus pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" value={f.name} onChange={set('name')} placeholder="shop" /></Field>
          <Field label="Engine">
            <select value={f.engine} onChange={set('engine')}>{Object.entries(options.engines).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select>
          </Field>
          <Field label="Version"><select value={f.version || eng.versions[0]} onChange={set('version')}>{eng.versions.map((v) => <option key={v}>{v}</option>)}</select></Field>
          <Field label="Database name"><input required pattern="[a-z_][a-z0-9_]{0,30}" value={f.dbName} onChange={set('dbName')} /></Field>
          <Field label={f.engine === 'mongo' ? 'Admin user' : 'User'}><input required pattern="[a-z_][a-z0-9_]{0,30}" value={f.user} onChange={set('user')} /></Field>
          <Field label="Memory limit (MB)" hint="Empty = no limit"><input type="number" min={128} value={f.memoryMb} onChange={set('memoryMb')} placeholder="1024" /></Field>
        </div>
        <Field label="Who can connect" wide>
          <select value={f.access} onChange={set('access')}>{options.access.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
        </Field>
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

export default function Databases() {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/databases', { interval: 5000 });
  const options = useApi('/api/databases/options');
  const [creating, setCreating] = useState(false);
  const [creds, setCreds] = useState(null);
  const [logs, setLogs] = useState(null);
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
      <PageHeader title="Databases" sub="PostgreSQL, MySQL and MongoDB on this server (Docker)"
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
              <thead><tr><th>Name</th><th>Engine</th><th>Status</th><th>Address</th><th>Database / user</th><th>Created</th><th /></tr></thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.name}</strong>{d.notes && <><br /><small className="muted">{d.notes}</small></>}</td>
                    <td>{d.engineLabel} {d.version}<br /><small className="muted mono">{d.image}</small></td>
                    <td>
                      {BUSY.includes(d.status) ? <Badge tone="warn" dot>{d.status}…</Badge>
                        : d.status === 'error' ? <Badge tone="bad" dot>failed</Badge>
                          : <Badge tone={STATE[d.state] || 'bad'} dot>{d.state || 'missing'}</Badge>}
                      {d.error && <><br /><small className="bad">{d.error}</small></>}
                    </td>
                    <td className="mono small">{d.bindIp}:{d.port}</td>
                    <td className="mono small">{d.dbName} / {d.user}</td>
                    <td className="muted">{ago(d.createdAt)}<br /><small>{d.createdBy}</small></td>
                    <td>
                      <div className="row-actions">
                        {sup && d.status === 'ready' && <button type="button" className="btn btn--small btn--primary" onClick={() => setCreds(d)}>Connect</button>}
                        {d.status === 'ready' && <button type="button" className="btn btn--small" onClick={() => setLogs(d)}>Logs</button>}
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
      {creating && options.data && <NewDatabase options={options.data} onClose={() => setCreating(false)} onDone={reload} />}
      {creds && <Credentials db={creds} onClose={() => setCreds(null)} />}
      {logs && <LogDialog title={`Logs: ${logs.name}`} url={`/api/databases/${logs.id}/logs`} onClose={() => setLogs(null)} />}
    </>
  );
}
