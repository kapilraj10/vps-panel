// My VPS servers: customers connect their own servers over SSH (verified before saving), prepare them, and deploy there.
import { useEffect, useState } from 'react';
import { api, ago, bytes, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, useApi, useAction, useConfirm } from '../ui.jsx';

const TONE = { online: 'good', offline: 'bad', host_key_changed: 'bad', new: 'neutral' };
const LABEL = { online: 'online', offline: 'unreachable', host_key_changed: 'host key changed', new: 'new' };

function ConnectDialog({ onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', host: '', port: 22, username: 'root', authType: 'key', privateKey: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const body = { name: f.name, host: f.host.trim(), port: Number(f.port), username: f.username.trim(), authType: f.authType, ...(f.authType === 'key' ? { privateKey: f.privateKey } : { password: f.password }) };
    const r = await run(() => api('/api/my-servers', { method: 'POST', body }), (x) => `${x.server.name} connected`);
    setBusy(false);
    if (r) { onDone(); onClose(); }
  }
  return (
    <Dialog open wide title="Connect your VPS" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name"><input required autoFocus maxLength={40} value={f.name} onChange={set('name')} placeholder="my-vps" /></Field>
          <Field label="IP address or host name"><input required value={f.host} onChange={set('host')} placeholder="203.0.113.10" /></Field>
          <Field label="SSH port"><input required type="number" min={1} max={65535} value={f.port} onChange={set('port')} /></Field>
          <Field label="SSH user" hint="root, or a user with passwordless sudo, can install software"><input required value={f.username} onChange={set('username')} /></Field>
          <Field label="Login with">
            <select value={f.authType} onChange={set('authType')}><option value="key">Private key (recommended)</option><option value="password">Password</option></select>
          </Field>
        </div>
        {f.authType === 'key'
          ? <Field label="Private key" hint="A key without a passphrase, made just for Sampanna Cloud. Its .pub goes into ~/.ssh/authorized_keys on the server." wide>
            <textarea className="textarea mono" rows={6} required value={f.privateKey} onChange={set('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
          </Field>
          : <Field label="Password" wide><input required type="password" autoComplete="off" value={f.password} onChange={set('password')} /></Field>}
        <Note>We log in once to check it works before saving. The key or password is stored encrypted and is never shown again. The server's host key is remembered, so a different machine on that address is refused.</Note>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Checking the connection…' : 'Verify and connect'}</button></div>
      </form>
    </Dialog>
  );
}

function TaskLog({ id, onClose }) {
  const { socket } = useLive();
  const { data, reload } = useApi(`/api/my-servers/${id}`, { interval: 3000 });
  const [live, setLive] = useState('');
  useEffect(() => {
    const on = (m) => { if (m.id === id) setLive((x) => x + m.text); };
    socket.on('myserver:log', on);
    return () => socket.off('myserver:log', on);
  }, [socket, id]);
  const t = data?.task;
  return (
    <Dialog open wide title={`Prepare ${data?.server.name || ''}`} onClose={onClose}>
      {t && <p><Badge tone={t.status === 'success' ? 'good' : t.status === 'failed' ? 'bad' : 'warn'} dot>{t.status}</Badge></p>}
      <pre className="log">{(t?.log || live) || 'Starting…'}</pre>
      <div className="dialog__buttons"><button type="button" className="btn" onClick={reload}>Refresh</button><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

export default function MyServers() {
  const { me } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/my-servers', { interval: 30_000 });
  const [adding, setAdding] = useState(false);
  const [task, setTask] = useState(null);
  const list = data?.servers || [];
  const check = async (s) => { if (await run(() => api(`/api/my-servers/${s.id}/check`, { method: 'POST' }), (r) => `${s.name}: ${LABEL[r.server.status] || r.server.status}`)) reload(); };
  const prepare = async (s) => {
    const docker = await confirm({ title: `Prepare ${s.name}?`, confirmLabel: 'Install', body: <p>Installs git, Node.js, PM2 and Python on the server (Ubuntu/Debian, needs root or passwordless sudo). This can take a few minutes.</p> });
    if (docker && await run(() => api(`/api/my-servers/${s.id}/prepare`, { method: 'POST', body: { docker: true } }))) setTask(s.id);
  };
  const remove = async (s) => {
    const typed = await confirm({ title: `Remove ${s.name}?`, typed: s.name, danger: true, confirmLabel: 'Remove', body: <p>Only the connection is removed from Sampanna Cloud. Nothing on the server is touched.</p> });
    if (typed && await run(() => api(`/api/my-servers/${s.id}`, { method: 'DELETE', body: { confirm: typed } }), `${s.name} removed`)) reload();
  };
  return (
    <>
      <PageHeader title={me.isAdmin ? 'Customer VPS servers' : 'My VPS servers'} sub={me.isAdmin ? 'Servers customers connected to deploy on' : 'Connect your own server and deploy apps and databases to it'}
        actions={!me.isAdmin && <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}><Icon name="plus" /> Connect a VPS</button>} />
      <ErrorNote error={error} onRetry={reload} />
      <Card pad={false}>
        {!data ? <div className="pad"><SkeletonRows /></div> : !list.length ? (
          <Empty icon="server" title={me.isAdmin ? 'No customer servers yet' : 'No VPS connected yet'}
            action={!me.isAdmin && <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>Connect your first VPS</button>}>
            Don't have one? Deploy on the main server instead: New application → Main server.
          </Empty>
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Server</th>{me.isAdmin && <th>Owner</th>}<th>Status</th><th>System</th><th>Resources</th><th>Uses</th><th /></tr></thead>
            <tbody>{list.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><small className="block muted mono">{s.username}@{s.host}:{s.port}</small></td>
                {me.isAdmin && <td>{s.owner}</td>}
                <td><Badge tone={TONE[s.status] || 'neutral'} dot>{LABEL[s.status] || s.status}</Badge>{s.lastCheckAt && <small className="block muted">checked {ago(s.lastCheckAt)}</small>}
                  {s.lastError && <small className="block bad">{s.lastError}</small>}</td>
                <td className="muted small">{s.facts?.os || '–'}<br />{s.facts && `root: ${s.facts.root}`}{s.facts?.tools && ` · ${Object.entries(s.facts.tools).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no tools yet'}`}</td>
                <td className="muted small">{s.facts ? <>{s.facts.cpus} CPU · load {s.facts.load}<br />{bytes(s.facts.memAvailable)} free of {bytes(s.facts.memTotal)} RAM<br />{bytes(s.facts.diskAvailable)} free disk</> : '–'}</td>
                <td className="muted">{s.apps} apps · {s.databases} DBs</td>
                <td><div className="row-actions">
                  <button type="button" className="btn btn--small" onClick={() => check(s)}>Check</button>
                  {!me.isAdmin && <button type="button" className="btn btn--small" onClick={() => prepare(s)}>Prepare</button>}
                  <button type="button" className="btn btn--small btn--danger" onClick={() => remove(s)}>Remove</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {!me.isAdmin && <Note>Apps on your VPS listen on their port on that server (e.g. http://your-ip:3000). Point your own domain at it, or put Nginx in front. Run "Prepare" once on a new server to install git, Node.js and PM2.</Note>}
      {adding && <ConnectDialog onClose={() => setAdding(false)} onDone={reload} />}
      {task && <TaskLog id={task} onClose={() => { setTask(null); reload(); }} />}
    </>
  );
}
