// Tools for one container, open to its owner: the server's Access tab (accounts, passwords, SSH password login) and
// the PM2, Docker and Databases managers. Everything acts inside the chosen container, never on the host.
import { useEffect, useState } from 'react';
import { api, bytes, ago, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Note, Icon, Field, Copy, Tabs, href, go, useApi, useAction, useConfirm,
} from '../ui.jsx';
import { LogDialog } from './Pm2Page.jsx';

const STATUS = {
  password: ['good', 'Password set'], locked: ['warn', 'Locked'], 'no-password': ['bad', 'No password'], unknown: ['neutral', 'Unknown'],
};
const TONE = { online: 'good', running: 'good', stopped: 'neutral', exited: 'neutral', created: 'neutral', errored: 'bad', dead: 'bad', restarting: 'warn', launching: 'warn', stopping: 'warn', paused: 'warn' };

function PasswordDialog({ server, accounts, initial, onClose, onDone }) {
  const run = useAction();
  const isNew = initial === null;
  const [f, setF] = useState({ account: initial || '', mode: 'generate', password: '', confirm: '', sudo: false, mustChange: false });
  const [show, setShow] = useState(false);
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const mismatch = f.mode === 'type' && f.confirm && f.password !== f.confirm;

  async function submit(e) {
    e.preventDefault();
    if (f.mode === 'type' && f.password !== f.confirm) return;
    const r = await run(() => api(`/api/servers/${server}/access/password`, {
      method: 'POST',
      body: {
        account: f.account, create: isNew, sudo: isNew && f.sudo, mustChange: f.mustChange,
        ...(f.mode === 'generate' ? { generate: true } : { password: f.password }),
      },
    }), `Password changed for ${f.account}`);
    if (!r) return;
    onDone();
    if (r.password) setDone(r); else onClose();
  }

  if (done) {
    return (
      <Dialog open title={`New password for ${done.account}`} onClose={onClose}>
        <Note tone="warn">Copy it now. The panel does not keep it and cannot show it again.</Note>
        <p><code className="mono">{done.password}</code> <Copy text={done.password} /></p>
        <div className="dialog__buttons"><button type="button" className="btn btn--primary" onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }

  return (
    <Dialog open title={isNew ? 'Add a login account' : `Change password: ${initial}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {isNew && <Field label="Account name" hint="Created with a home folder and a bash shell"><input required value={f.account} onChange={set('account')} pattern="[a-z_][a-z0-9_\-]{0,31}" autoComplete="off" /></Field>}
        <div className="seg seg--small mb12">
          <button type="button" aria-pressed={f.mode === 'generate'} onClick={() => setF({ ...f, mode: 'generate' })}>Generate a strong password</button>
          <button type="button" aria-pressed={f.mode === 'type'} onClick={() => setF({ ...f, mode: 'type' })}>Type my own</button>
        </div>
        {f.mode === 'type' && (
          <>
            <Field label="New password"><input required type={show ? 'text' : 'password'} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
            <Field label="Repeat it" hint={mismatch ? 'The two passwords do not match' : undefined}><input required type={show ? 'text' : 'password'} value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
            <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
          </>
        )}
        {isNew && <label className="check"><input type="checkbox" checked={f.sudo} onChange={set('sudo')} /> Administrator (can use sudo)</label>}
        <label className="check"><input type="checkbox" checked={f.mustChange} onChange={set('mustChange')} /> Must choose a new password at next login</label>
        <div className="dialog__buttons">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={mismatch || (isNew && accounts.some((a) => a.name === f.account))}>{isNew ? 'Create account' : 'Change password'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function AccessTab({ c }) {
  const run = useAction();
  const confirm = useConfirm();
  const running = c.status === 'Running';
  const { data, error, reload } = useApi(running ? `/api/servers/${c.name}/access` : null);
  const [editing, setEditing] = useState(undefined); // undefined closed, null new account, string account name
  if (!running) return <Card><Empty icon="key" title="The server is stopped">Start it to manage its logins.</Empty></Card>;
  const accounts = data?.accounts || [];
  const ssh = data?.ssh;

  const lock = async (a, locked) => {
    if (locked && !(await confirm({ title: `Lock ${a.name}?`, body: 'Its password stops working until you unlock it or set a new one. SSH keys and the panel terminal keep working.', confirmLabel: 'Lock', danger: true }))) return;
    if (await run(() => api(`/api/servers/${c.name}/access/lock`, { method: 'POST', body: { account: a.name, locked } }), `${a.name} ${locked ? 'locked' : 'unlocked'}`)) reload();
  };
  const setSsh = async (passwordLogin, rootLogin) => {
    if (passwordLogin && rootLogin && !(await confirm({ title: 'Allow root to log in with a password?', body: 'Anyone who reaches SSH can try to guess it, so use a long generated password.', confirmLabel: 'Allow' }))) return;
    if (await run(() => api(`/api/servers/${c.name}/access/ssh`, { method: 'PUT', body: { passwordLogin, rootLogin } }), 'SSH settings saved')) reload();
  };

  return (
    <>
      <ErrorNote error={error} onRetry={reload} />
      <Card pad={false} title="Login accounts" sub="Passwords for the Linux accounts inside this server. Separate from your panel login."
        actions={<button type="button" className="btn btn--small" onClick={() => setEditing(null)}><Icon name="plus" size={14} /> Add account</button>}>
        {!data && !error ? <div className="pad"><SkeletonRows /></div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Account</th><th>Role</th><th>Password</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.name}>
                    <td className="mono">{a.name}</td>
                    <td>{a.uid === 0 ? 'Superuser' : a.sudo ? 'Administrator' : 'User'}</td>
                    <td><Badge tone={STATUS[a.status][0]} dot>{STATUS[a.status][1]}</Badge></td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn--small" onClick={() => setEditing(a.name)}>{a.status === 'password' ? 'Change password' : 'Set password'}</button>
                        {a.status === 'password' && <button type="button" className="btn btn--small" onClick={() => lock(a, true)}>Lock</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {ssh && (
        <Card title="SSH password login" sub={c.ssh ? <>Connect with <code>ssh root@{c.ssh}</code> <Copy text={`ssh root@${c.ssh}`} /></> : undefined}>
          {!ssh.installed ? <Note tone="warn">No SSH server is installed in this server. Install <code>openssh-server</code> from the terminal first.</Note> : (
            <>
              <p>Password login is <strong>{ssh.passwordLogin ? 'on' : 'off'}</strong>{ssh.passwordLogin ? `, and root ${ssh.rootPasswordLogin ? 'can' : 'cannot'} use it` : '. Only SSH keys can log in'}.</p>
              <div className="btn-row">
                {(!ssh.passwordLogin || ssh.rootPasswordLogin) && <button type="button" className="btn" onClick={() => setSsh(true, false)}>{ssh.passwordLogin ? 'Block root password login' : 'Turn on (not for root)'}</button>}
                {!ssh.rootPasswordLogin && <button type="button" className="btn" onClick={() => setSsh(true, true)}>Turn on for root too</button>}
                {ssh.passwordLogin && <button type="button" className="btn btn--danger" onClick={() => setSsh(false, false)}>Turn off</button>}
              </div>
            </>
          )}
        </Card>
      )}
      {editing !== undefined && <PasswordDialog server={c.name} accounts={accounts} initial={editing} onClose={() => setEditing(undefined)} onDone={reload} />}
    </>
  );
}

function TaskPanel({ task, reload }) {
  useEffect(() => {
    if (task?.status !== 'running') return undefined;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [task?.status, reload]);
  if (!task) return null;
  return (
    <Card title={task.label} actions={<Badge tone={task.status === 'running' ? 'warn' : task.status === 'success' ? 'good' : 'bad'} dot>{task.status}</Badge>}>
      <pre className="logbox mono">{task.log || 'Starting…'}</pre>
    </Card>
  );
}

function NewPm2({ server, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', cwd: '/srv/apps/', script: 'server.js', args: '', instances: 1, port: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    if (await run(() => api(`/api/servers/${server}/tools/pm2`, { method: 'POST', body: f }), `Started ${f.name}`)) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="Start a PM2 process" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
          <Field label="App folder"><input required value={f.cwd} onChange={set('cwd')} /></Field>
          <Field label="Script" hint="server.js, dist/main.js, or npm"><input required value={f.script} onChange={set('script')} /></Field>
          <Field label="Arguments" hint="e.g. start (for npm)"><input value={f.args} onChange={set('args')} /></Field>
          <Field label="Instances" hint="More than 1 runs in cluster mode and shares the port"><input type="number" min={1} max={16} value={f.instances} onChange={set('instances')} /></Field>
          <Field label="PORT (optional)"><input type="number" min={1} max={65535} value={f.port} onChange={set('port')} /></Field>
        </div>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Start</button></div>
      </form>
    </Dialog>
  );
}

function Pm2Tool({ server }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/servers/${server}/tools/pm2`, { interval: 8000, deps: [server] });
  const [logs, setLogs] = useState(null);
  const [creating, setCreating] = useState(false);
  const base = `/api/servers/${server}/tools/pm2`;
  const act = async (p, op, body) => { if (await run(() => api(`${base}/${p.name}/${op}`, { method: 'POST', body }), `${p.name}: ${op} done`)) reload(); };
  const remove = async (p) => { if (await confirm({ title: `Delete ${p.name} from PM2?`, body: 'The process stops and PM2 forgets it. Files stay on the disk.', confirmLabel: 'Delete', danger: true })) act(p, 'delete'); };
  const scale = (p) => {
    const n = Number(window.prompt(`How many instances of ${p.name}? (1-16)`, String(p.instances)));
    if (Number.isInteger(n) && n >= 1 && n <= 16 && n !== p.instances) act(p, 'scale', { instances: n });
  };
  const install = async () => { if (await run(() => api(`${base}/install`, { method: 'POST' }))) reload(); };
  const taskRunning = data?.task?.status === 'running';
  return (
    <>
      <ErrorNote error={error} onRetry={reload} />
      {data && !data.installed && <Card><Empty icon="cpu" title="PM2 is not installed on this server">
        <button type="button" className="btn btn--primary" disabled={taskRunning} onClick={install}>Install Node.js and PM2</button>
      </Empty></Card>}
      <TaskPanel task={data?.task} reload={reload} />
      {data?.installed && (
        <Card pad={false} title="PM2 processes" sub="Add instances to run a Node.js app across CPU cores, with PM2 balancing the load."
          actions={<button type="button" className="btn btn--small" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Start process</button>}>
          {!data.processes.length ? <Empty icon="cpu" title="No processes yet">Start one here or deploy from Applications.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Status</th><th>Mode</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Restarts</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {data.processes.map((p) => (
                    <tr key={p.name}>
                      <td className="mono">{p.name}</td>
                      <td><Badge tone={TONE[p.status] || 'neutral'} dot>{p.status}</Badge></td>
                      <td>{p.mode}{p.mode === 'cluster' ? ` ×${p.instances}` : ''}</td>
                      <td>{p.cpu}%</td>
                      <td>{bytes(p.memory)}</td>
                      <td>{p.uptime && p.status === 'online' ? ago(p.uptime).replace(' ago', '') : '–'}</td>
                      <td>{p.restarts}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn--small" onClick={() => setLogs(p.name)}>Logs</button>
                          {p.status === 'online'
                            ? <><button type="button" className="btn btn--small" onClick={() => act(p, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(p, 'stop')}>Stop</button></>
                            : <button type="button" className="btn btn--small" onClick={() => act(p, 'start')}>Start</button>}
                          {p.mode === 'cluster' && <button type="button" className="btn btn--small" onClick={() => scale(p)}>Scale</button>}
                          <button type="button" className="btn btn--small btn--danger" onClick={() => remove(p)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {logs && <LogDialog title={`Logs: ${logs}`} url={`${base}/${logs}/logs`} onClose={() => setLogs(null)} />}
      {creating && <NewPm2 server={server} onClose={() => setCreating(false)} onDone={reload} />}
    </>
  );
}

const DockerOff = ({ state }) => (
  <Note tone="warn">{state === 'stopped' ? 'Docker is installed but not running on this server.' : 'Docker is not enabled on this server. A super admin can turn it on from the server\'s Stack tab, because it changes the server\'s security settings.'}</Note>
);

function NewDocker({ server, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ image: '', name: '', ports: '', restart: 'unless-stopped', env: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    if (await run(() => api(`/api/servers/${server}/tools/docker`, { method: 'POST', body: f }))) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="Run a Docker container" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Image"><input required value={f.image} onChange={set('image')} placeholder="nginx:alpine" /></Field>
          <Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
          <Field label="Ports" hint="host:container, separated by spaces"><input value={f.ports} onChange={set('ports')} placeholder="8080:80" /></Field>
          <Field label="Restart"><select className="select" value={f.restart} onChange={set('restart')}>{['unless-stopped', 'always', 'on-failure', 'no'].map((r) => <option key={r}>{r}</option>)}</select></Field>
        </div>
        <Field label="Environment" hint="KEY=value per line" wide><textarea className="textarea mono" rows={4} value={f.env} onChange={set('env')} spellCheck={false} /></Field>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Run</button></div>
      </form>
    </Dialog>
  );
}

function DockerTool({ server }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/servers/${server}/tools/docker`, { interval: 8000, deps: [server] });
  const [logs, setLogs] = useState(null);
  const [creating, setCreating] = useState(false);
  const base = `/api/servers/${server}/tools/docker`;
  const act = async (c, op) => { if (await run(() => api(`${base}/${c.name}/${op}`, { method: 'POST' }), `${c.name}: ${op} done`)) reload(); };
  const remove = async (c) => { if (await confirm({ title: `Remove ${c.name}?`, body: 'The container and anything written outside a volume are deleted.', confirmLabel: 'Remove', danger: true })) act(c, 'remove'); };
  const list = (data?.containers || []).filter((c) => !c.database);
  return (
    <>
      <ErrorNote error={error} onRetry={reload} />
      {data && data.state !== 'ready' && <DockerOff state={data.state} />}
      <TaskPanel task={data?.task} reload={reload} />
      {data?.state === 'ready' && (
        <Card pad={false} title="Docker containers" actions={<button type="button" className="btn btn--small" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Run container</button>}>
          {!list.length ? <Empty icon="storage" title="No containers yet">Run an image to get started.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Image</th><th>State</th><th>Ports</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.name}</td>
                      <td className="mono">{c.image}</td>
                      <td><Badge tone={TONE[c.state] || 'neutral'} dot>{c.status}</Badge></td>
                      <td className="mono small">{c.ports || '–'}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn--small" onClick={() => setLogs(c.name)}>Logs</button>
                          {c.state === 'running'
                            ? <><button type="button" className="btn btn--small" onClick={() => act(c, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(c, 'stop')}>Stop</button></>
                            : <button type="button" className="btn btn--small" onClick={() => act(c, 'start')}>Start</button>}
                          <button type="button" className="btn btn--small btn--danger" onClick={() => remove(c)}>Remove</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {logs && <LogDialog title={`Logs: ${logs}`} url={`${base}/${logs}/logs`} onClose={() => setLogs(null)} />}
      {creating && <NewDocker server={server} onClose={() => setCreating(false)} onDone={reload} />}
    </>
  );
}

function NewDatabase({ server, engines, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', engine: engines[0]?.id || '', version: engines[0]?.versions.slice(-1)[0] || '' });
  const engine = engines.find((e) => e.id === f.engine);
  async function submit(e) {
    e.preventDefault();
    if (await run(() => api(`/api/servers/${server}/tools/databases`, { method: 'POST', body: f }))) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="Create a database" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} pattern="[a-z][a-z0-9\-]{0,30}" /></Field>
        <Field label="Engine"><select className="select" value={f.engine} onChange={(e) => { const x = engines.find((n) => n.id === e.target.value); setF({ ...f, engine: x.id, version: x.versions.slice(-1)[0] }); }}>{engines.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
        <Field label="Version"><select className="select" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })}>{engine?.versions.map((v) => <option key={v}>{v}</option>)}</select></Field>
        <p className="muted small">It listens on 127.0.0.1 inside this server, so only apps on this server can connect.</p>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Create</button></div>
      </form>
    </Dialog>
  );
}

function CredentialsDialog({ server, db, onClose }) {
  const { data, error } = useApi(`/api/servers/${server}/tools/databases/${db}/credentials`);
  const rows = data ? [['Host', data.host], ['Port', String(data.port)], ['Database', data.dbName], ['User', data.user], ['Password', data.password], ['Connection URL', data.url]] : [];
  return (
    <Dialog open title={`Credentials: ${db}`} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!data && !error ? <SkeletonRows /> : <dl className="dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd><code className="mono">{v}</code> <Copy text={v} /></dd></div>)}</dl>}
      <div className="dialog__buttons"><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function DatabaseTool({ server }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/servers/${server}/tools/databases`, { interval: 8000, deps: [server] });
  const [creds, setCreds] = useState(null);
  const [creating, setCreating] = useState(false);
  const base = `/api/servers/${server}/tools/databases`;
  const act = async (d, op, body) => { if (await run(() => api(`${base}/${d.name}/${op}`, { method: 'POST', body }), `${d.name}: ${op} done`)) reload(); };
  const remove = async (d) => {
    if (await confirm({ title: `Delete ${d.name} and all its data?`, typed: d.name, body: 'The database and its data volume are permanently deleted.', confirmLabel: 'Delete', danger: true })) act(d, 'remove', { deleteData: true });
  };
  const list = data?.databases || [];
  return (
    <>
      <ErrorNote error={error} onRetry={reload} />
      {data && data.state !== 'ready' && <DockerOff state={data.state} />}
      <TaskPanel task={data?.task} reload={reload} />
      {data?.state === 'ready' && (
        <Card pad={false} title="Databases" actions={<button type="button" className="btn btn--small" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Create database</button>}>
          {!list.length ? <Empty icon="disk" title="No databases yet">PostgreSQL, MySQL and MongoDB are available.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Engine</th><th>State</th><th>Port</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.name}>
                      <td className="mono">{d.name}</td>
                      <td>{d.engineLabel} <span className="muted small">{d.image}</span></td>
                      <td><Badge tone={TONE[d.state] || 'neutral'} dot>{d.status}</Badge></td>
                      <td className="mono">{d.port || '–'}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn--small" onClick={() => setCreds(d.name)}>Credentials</button>
                          {d.state === 'running'
                            ? <><button type="button" className="btn btn--small" onClick={() => act(d, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(d, 'stop')}>Stop</button></>
                            : <button type="button" className="btn btn--small" onClick={() => act(d, 'start')}>Start</button>}
                          <button type="button" className="btn btn--small btn--danger" onClick={() => remove(d)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {creds && <CredentialsDialog server={server} db={creds} onClose={() => setCreds(null)} />}
      {creating && data && <NewDatabase server={server} engines={data.engines} onClose={() => setCreating(false)} onDone={reload} />}
    </>
  );
}

const KINDS = {
  pm2: ['PM2 Manager', 'Run, scale and watch Node.js processes inside your server.', Pm2Tool],
  docker: ['Docker Manager', 'Run and manage Docker containers inside your server.', DockerTool],
  databases: ['Databases', 'PostgreSQL, MySQL and MongoDB inside your server.', DatabaseTool],
};

// `base` is the route of the page: 'pm2' etc. for users, 'container-tools/pm2' etc. for admins
export default function ContainerTools({ kind, name, base = kind, admin = false }) {
  const { me, cts } = useLive();
  const [title, sub, Tool] = KINDS[kind] || KINDS.pm2;
  const mine = Object.values(cts).filter((c) => me.isAdmin || me.containers.includes(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  const running = mine.filter((c) => c.status === 'Running');
  const target = name && cts[name] ? name : null;
  useEffect(() => { if (!name && running.length === 1) go(`${base}/${running[0].name}`); }, [name, running.length, base]);
  return (
    <>
      <PageHeader title={title} sub={sub}
        actions={mine.length > 0 && (
          <select className="select" value={target || ''} onChange={(e) => go(`${base}/${e.target.value}`)} aria-label="Server">
            <option value="" disabled>Choose a server…</option>
            {mine.map((c) => <option key={c.name} value={c.name} disabled={c.status !== 'Running'}>{c.name}{c.status !== 'Running' ? ` (${c.status.toLowerCase()})` : ''}</option>)}
          </select>
        )} />
      {admin && <Tabs tabs={Object.entries(KINDS).map(([id, k]) => [id, k[0]])} value={kind} hrefFor={(id) => href(`container-tools/${id}${target ? `/${target}` : ''}`)} />}
      {!mine.length && <Card><Empty icon="server" title="No servers">There is nothing to manage yet.</Empty></Card>}
      {target && cts[target].status !== 'Running' && <Note tone="warn">{target} is {cts[target].status.toLowerCase()}. <a href={href(`servers/${target}`)}>Start it</a> to manage it.</Note>}
      {target && cts[target].status === 'Running' && <Tool key={target} server={target} />}
      {!target && mine.length > 0 && <Card><Empty icon="server" title="Pick a server">Choose a running server above.</Empty></Card>}
    </>
  );
}
