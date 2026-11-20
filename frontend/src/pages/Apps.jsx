import { useEffect, useRef, useState } from 'react';
import { api, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Note, Icon, Field, Tabs, Stat, href, go, useApi, useAction, useConfirm,
} from '../ui.jsx';
import { fmtMoney } from './Billing.jsx';
import { UserCreateServer } from './Servers.jsx';

const STATUS_TONE = { running: 'good', deploying: 'warn', provisioning: 'warn', failed: 'bad', stopped: 'neutral', new: 'neutral' };
const where = (a) => (a.target === 'main' ? 'Main server' : a.target === 'vps' ? `My VPS: ${a.serverName}` : a.container);
const priceText = (a) => (a.target === 'main' ? (a.planName ? `in your ${a.planName} package` : 'hosting package') : a.target === 'vps' ? 'your own server' : 'included in the server');
const memText = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.round(b / 1048576)} MB`);

// Where to deploy: 1) one of my servers, 2) the main server (no VPS needed, the panel sets it up), 3) a new server
function TargetPicker({ value, onChange, hasServers, hasVps, hosting, planId, onPlan, onNewServer }) {
  const pkg = hosting?.package;
  const plans = hosting?.packages;
  const opts = [
    ['main', 'Main server (managed)', 'No VPS needed. Sampanna Cloud runs it for you, with a free subdomain.', false],
    ['vps', 'My VPS', hasVps ? 'Your own server connected over SSH' : 'Connect your server first (My VPS servers)', !hasVps],
    ['server', 'My cloud server', hasServers ? 'A server you rent from Sampanna Cloud' : 'You have no cloud server', !hasServers],
    ['new', 'New server', 'Rent a cloud server from a plan first', false],
  ];
  return (
    <>
      <div className="plan-grid">
        {opts.map(([id, label, sub, disabled]) => (
          <label key={id} className={`plan-card ${value === id ? 'is-on' : ''} ${disabled ? 'is-off' : ''}`}>
            <input type="radio" name="target" value={id} disabled={disabled} checked={value === id} onChange={() => onChange(id)} />
            <strong>{label}</strong><small className="muted">{sub}</small>
          </label>
        ))}
      </div>
      {value === 'main' && pkg && (
        <Note tone={pkg.maxApps != null && hosting.appsUsed >= pkg.maxApps ? 'warn' : 'info'}>
          Your hosting package: <strong>{pkg.name}</strong> ({pkg.cpu} CPU, {pkg.memoryMb >= 1024 ? `${pkg.memoryMb / 1024} GB` : `${pkg.memoryMb} MB`} RAM, {pkg.diskGb} GB),
          {' '}{hosting.appsUsed} of {pkg.maxApps ?? '∞'} apps used, {fmtMoney(pkg.priceDay)}/day.
          {pkg.maxApps != null && hosting.appsUsed >= pkg.maxApps && <> Upgrade it in <a href={href('wallet')}>Wallet &amp; billing</a> to add more apps.</>}
        </Note>
      )}
      {value === 'main' && !pkg && (
        <>
          <p className="muted small">Pick a hosting package. It covers all your apps on the main server; you pay it per day while you have at least one app there.</p>
          <div className="plan-grid">
            {(plans || []).map((p) => (
              <label key={p.id} className={`plan-card ${String(planId) === String(p.id) ? 'is-on' : ''}`}>
                <input type="radio" name="pkg" value={p.id} checked={String(planId) === String(p.id)} onChange={() => onPlan(String(p.id))} />
                <strong>{p.name}</strong>
                <span>{p.cpu} CPU · {p.memoryMb >= 1024 ? `${p.memoryMb / 1024} GB` : `${p.memoryMb} MB`} RAM · {p.diskGb} GB</span>
                <span>{p.maxApps == null ? 'Unlimited apps' : `${p.maxApps} app${p.maxApps === 1 ? '' : 's'}`}</span>
                <span className="plan-card__price">{fmtMoney(p.priceDay)}<small>/day</small></span>
              </label>
            ))}
            {plans && !plans.length && <Note tone="warn">No hosting packages yet. Ask the administrator.</Note>}
          </div>
        </>
      )}
      {value === 'new' && (
        <Note>Create the server first; when it is running, come back to New application and pick it under “My server”.
          <button type="button" className="btn btn--small btn--primary mt8" onClick={onNewServer}>Create a new server</button></Note>
      )}
    </>
  );
}

// Live CPU / RAM of the app's process (refreshes every 10 s)
function AppStats({ id }) {
  const { data } = useApi(`/api/apps/${id}/stats`, { interval: 10_000 });
  if (!data?.running) return null;
  return (
    <div className="kpis">
      <Stat label="Process" icon="activity" value={data.status || '–'} sub={data.uptime ? `up ${ago(data.uptime).replace(' ago', '')}` : ''} />
      <Stat label="CPU" icon="cpu" value={data.cpu != null ? `${data.cpu}%` : '–'} />
      <Stat label="Memory" icon="memory" value={data.memory != null ? memText(data.memory) : '–'} />
      <Stat label="Restarts" icon="refresh" value={data.restarts ?? '–'} />
    </div>
  );
}

// Super admin: move an app to another place of the same customer
function MoveDialog({ a, onClose, onDone }) {
  const run = useAction();
  const vps = useApi('/api/my-servers');
  const plans = useApi('/api/billing/plans?kind=app');
  const [f, setF] = useState({ target: 'main', serverId: '', container: '', planId: '' });
  const theirs = (vps.data?.servers || []).filter((s) => s.userId === a.userId);
  async function submit(e) {
    e.preventDefault();
    const body = { target: f.target, ...(f.target === 'vps' ? { serverId: Number(f.serverId || theirs[0]?.id) } : {}), ...(f.target === 'server' ? { container: f.container } : {}), ...(f.planId ? { planId: Number(f.planId) } : {}) };
    if (await run(() => api(`/api/apps/${a.id}/move`, { method: 'POST', body }), (r) => `Moved. ${r.oldCopyStopped ? 'Old copy stopped.' : 'The old place could not be reached.'}`)) { onDone(); onClose(); }
  }
  return (
    <Dialog open title={`Move ${a.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">Now on {where(a)}. The old copy is stopped (its files stay there); the app is deployed at the new place. Its automatic subdomain is made again after the first deploy.</p>
        <Field label="Move to"><select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}>
          <option value="main">Main server (owner's hosting package)</option><option value="vps">Owner's VPS</option><option value="server">Owner's cloud server</option></select></Field>
        {f.target === 'main' && <Field label="Package if the owner has none"><select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}><option value="">Use the owner's package</option>
          {(plans.data?.plans || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {f.target === 'vps' && <Field label="VPS"><select required value={f.serverId || theirs[0]?.id || ''} onChange={(e) => setF({ ...f, serverId: e.target.value })}>{theirs.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}</select></Field>}
        {f.target === 'server' && <Field label="Cloud server name"><input required value={f.container} onChange={(e) => setF({ ...f, container: e.target.value })} /></Field>}
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Move</button></div>
      </form>
    </Dialog>
  );
}

function AppForm({ open, onClose, app, onSaved }) {
  const { me, cts } = useLive();
  const run = useAction();
  const types = useApi('/api/apps/types');
  const [f, setF] = useState(null);
  const [envText, setEnvText] = useState('');
  const servers = Object.values(cts).filter((c) => me.isAdmin || me.containers.includes(c.name)).map((c) => c.name)
    .filter((n) => !/^apps-/.test(n) || me.isAdmin).sort();
  const hosting = useApi(open && !app ? '/api/hosting' : null);
  const myVps = useApi(open && !app && !me.isAdmin ? '/api/my-servers' : null);
  const vpsList = myVps.data?.servers || [];
  const [newServer, setNewServer] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (app) {
      setF({ ...app, gitToken: '' });
      api(`/api/apps/${app.id}/env`).then((d) => setEnvText(Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join('\n'))).catch(() => setEnvText(''));
    } else {
      setF({ target: 'main', serverId: '', planId: '', container: servers[0] || '', name: '', type: 'node', repoUrl: '', branch: 'main', rootDir: '', outputDir: '', installCmd: '', buildCmd: '', startCmd: '', port: '', gitToken: '' });
      setEnvText('');
    }
  }, [open, app?.id]);
  useEffect(() => {
    // Fill the type's defaults when creating
    if (!f || app || !types.data) return;
    const t = types.data.types.find((x) => x.id === f.type);
    if (t) setF((x) => ({ ...x, installCmd: t.install, buildCmd: t.build, startCmd: t.start, port: t.port, outputDir: t.output || '' }));
  }, [f?.type, types.data]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const t = types.data?.types.find((x) => x.id === f.type);
  async function submit(e) {
    e.preventDefault();
    if (!app && f.target === 'new') return;
    const body = { ...f, port: Number(f.port), env: envText, planId: f.planId ? Number(f.planId) : undefined };
    if (!f.gitToken) delete body.gitToken;
    if (!app && f.target !== 'server') delete body.container;
    if (!app && f.target === 'vps') body.serverId = Number(f.serverId || vpsList[0]?.id);
    if (!app && f.target !== 'vps') delete body.serverId;
    const r = app ? await run(() => api(`/api/apps/${app.id}`, { method: 'PUT', body }), 'Application saved')
      : await run(() => api('/api/apps', { method: 'POST', body }), `Created ${f.name}`);
    if (r) { onSaved(r.app); onClose(); }
  }
  return (
    <Dialog open={open} title={app ? `Edit ${app.name}` : 'New application'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        {!app && <TargetPicker value={f.target} onChange={(target) => setF({ ...f, target })} hasServers={servers.length > 0} hasVps={vpsList.length > 0}
          hosting={hosting.data} planId={f.planId} onPlan={(planId) => setF({ ...f, planId })} onNewServer={() => setNewServer(true)} />}
        <div className="fgrid">
          {!app && f.target === 'vps' && <Field label="Your VPS"><select required value={f.serverId || vpsList[0]?.id || ''} onChange={set('serverId')}>{vpsList.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host}){s.status !== 'online' ? ` · ${s.status}` : ''}</option>)}</select></Field>}
          {!app && f.target === 'server' && <Field label="Server"><select required value={f.container} onChange={set('container')}>{servers.map((s) => <option key={s}>{s}</option>)}</select></Field>}
          {!app && <Field label="App name" hint="Also the PM2 process name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]" /></Field>}
          {!app && <Field label="Type"><select value={f.type} onChange={set('type')}>{(types.data?.types || []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>}
          <Field label="Git repository (https)" wide><input required type="url" value={f.repoUrl} onChange={set('repoUrl')} placeholder="https://github.com/you/app.git" /></Field>
          <Field label="Branch"><input required value={f.branch} onChange={set('branch')} /></Field>
          <Field label="Folder in the repo" hint="Empty = repository root"><input value={f.rootDir} onChange={set('rootDir')} placeholder="apps/web" /></Field>
          <Field label="Port inside the server" hint="Your app must listen on $PORT"><input required type="number" min={1024} max={65535} value={f.port} onChange={set('port')} /></Field>
          <Field label="Install command"><input value={f.installCmd} onChange={set('installCmd')} /></Field>
          <Field label="Build command"><input value={f.buildCmd} onChange={set('buildCmd')} /></Field>
          {t?.static ? <Field label="Folder to serve" hint="Build output, e.g. dist or build"><input value={f.outputDir} onChange={set('outputDir')} /></Field>
            : <Field label="Start command"><input required value={f.startCmd} onChange={set('startCmd')} /></Field>}
          <Field label="Access token (private repos)" hint={app?.hasGitToken ? 'A token is saved. Leave empty to keep it.' : 'Stored encrypted. Read-only token recommended.'}>
            <input type="password" value={f.gitToken} onChange={set('gitToken')} autoComplete="off" />
          </Field>
        </div>
        <Field label="Environment variables" hint="KEY=value per line. Stored encrypted; values shown as ******** keep their saved value." wide>
          <textarea className="textarea mono" rows={6} value={envText} onChange={(e) => setEnvText(e.target.value)} spellCheck={false} />
        </Field>
        <div className="dialog__buttons">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!app && f.target === 'new'}>{app ? 'Save' : f.target === 'main' ? 'Create and deploy' : 'Create application'}</button>
        </div>
        {!app && f.target === 'main' && <p className="muted small">The first app on the main server takes a few minutes: the panel prepares a private, isolated space for your apps, installs the runtime and deploys. Follow it on the app page.</p>}
      </form>
      {newServer && <UserCreateServer open onClose={() => setNewServer(false)} />}
    </Dialog>
  );
}

function AppDetail({ id }) {
  const { socket, cts, me } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/apps/${id}`);
  const [tab, setTab] = useState('deploy');
  const [liveLog, setLiveLog] = useState('');
  const [viewDep, setViewDep] = useState(null);
  const [logs, setLogs] = useState(null);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    const onLog = (m) => { if (String(m.appId) === String(id)) setLiveLog((t) => (t + m.text).slice(-200_000)); };
    const onUpd = (a) => { if (String(a.id) === String(id)) reload(); };
    socket.on('app:log', onLog);
    socket.on('app:update', onUpd);
    return () => { socket.off('app:log', onLog); socket.off('app:update', onUpd); };
  }, [socket, id]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [liveLog]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <SkeletonRows />;
  const a = data.app;
  const serverUp = a.target === 'vps' || cts[a.container]?.status === 'Running'; // VPS reachability shows on deploy
  const op = async (kind) => { setLiveLog(''); setTab('deploy'); await run(() => api(`/api/apps/${a.id}/${kind}`, { method: 'POST' })); reload(); };
  const showLogs = async () => { setTab('logs'); setLogs(null); const r = await run(() => api(`/api/apps/${a.id}/logs`)); setLogs(r ? r.text : ''); };
  const del = async () => {
    const typed = await confirm({ title: `Delete ${a.name}?`, typed: a.name, danger: true, confirmLabel: 'Delete app', body: 'Its PM2 process is stopped and removed. The code folder in the server is kept.' });
    if (typed && await run(() => api(`/api/apps/${a.id}`, { method: 'DELETE', body: { confirm: typed } }), `Deleted ${a.name}`)) go('apps');
  };

  return (
    <>
      <PageHeader back={href('apps')} title={<span className="title-with-badge">{a.name} <Badge tone={STATUS_TONE[a.status]} dot>{a.deploying ? 'deploying' : a.status}</Badge></span>}
        sub={`${a.typeLabel} on ${where(a)} · ${priceText(a)} · port ${a.port}${a.lastDeployAt ? ` · deployed ${ago(a.lastDeployAt)}` : ''}`}
        actions={(
          <div className="btn-row">
            <button type="button" className="btn btn--primary" disabled={a.deploying || !serverUp} onClick={() => op('deploy')}><Icon name="git" size={14} /> Deploy</button>
            <button type="button" className="btn" disabled={a.deploying || !serverUp} onClick={() => op('restart')}><Icon name="refresh" size={14} /> Restart</button>
            <button type="button" className="btn" disabled={a.deploying || !serverUp} onClick={() => op('start')}><Icon name="play" size={14} /> Start</button>
            <button type="button" className="btn" disabled={a.deploying || !serverUp} onClick={() => op('stop')}><Icon name="stop" size={14} /> Stop</button>
            <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
            {me.role === 'super_admin' && <button type="button" className="btn" onClick={() => setMoving(true)}>Move</button>}
            <button type="button" className="btn btn--danger" onClick={del} aria-label="Delete app"><Icon name="trash" size={14} /></button>
          </div>
        )} />
      {serverUp && <AppStats id={a.id} />}
      {a.directUrl && <Note>On your VPS this app listens at <a href={a.directUrl} target="_blank" rel="noreferrer noopener">{a.directUrl}</a> (open the port in the server's firewall, or point your domain at it).</Note>}
      {!serverUp && a.status === 'provisioning' && <Note>Preparing the main server for this app. The first deploy starts by itself; watch the Deploy log.</Note>}
      {!serverUp && a.status !== 'provisioning' && <Note tone="warn">{where(a)} is not running. Start the server to deploy or control this app.</Note>}
      <div className="grid2">
        <Card title="Source">
          <dl className="facts">
            <div><dt>Repository</dt><dd><a href={a.repoUrl} target="_blank" rel="noreferrer noopener">{a.repoUrl}</a></dd></div>
            <div><dt>Branch</dt><dd>{a.branch}{a.rootDir ? ` · /${a.rootDir}` : ''}</dd></div>
            <div><dt>Install</dt><dd><code>{a.installCmd || '–'}</code></dd></div>
            <div><dt>Build</dt><dd><code>{a.buildCmd || '–'}</code></dd></div>
            <div><dt>{a.type === 'react' || a.type === 'static' ? 'Serves' : 'Start'}</dt><dd><code>{a.type === 'react' || a.type === 'static' ? a.outputDir : a.startCmd}</code></dd></div>
            <div><dt>Environment</dt><dd>{a.envKeys.length ? a.envKeys.join(', ') : 'none'}</dd></div>
          </dl>
        </Card>
        <Card title="Domains" actions={<a className="btn btn--small" href={href('domains')}>Manage domains</a>}>
          {a.domains.length ? <ul className="plain">{a.domains.map((d) => <li key={d.hostname}><a href={`https://${d.hostname}`} target="_blank" rel="noreferrer noopener">{d.hostname}</a> <Badge tone={d.status === 'active' ? 'good' : 'warn'}>{d.status}</Badge></li>)}</ul>
            : <Empty icon="globe" title="No domain yet">Add a domain to make this app reachable on the internet.</Empty>}
          <p className="muted small">Runtime missing in the server? <button type="button" className="linkish" disabled={a.deploying || !serverUp} onClick={() => op('runtime')}>Install runtime</button> (git, Node.js, PM2{a.type === 'python' ? ', Python' : a.type === 'laravel' ? ', PHP, Composer' : ''}).</p>
        </Card>
      </div>
      <Tabs tabs={[['deploy', 'Deploy output'], ['history', `History (${data.deployments.length})`], ['logs', 'App logs']]} value={tab} onChange={(t) => (t === 'logs' ? showLogs() : setTab(t))} />
      {tab === 'deploy' && <Card><pre className="log log--tall" ref={logRef}>{liveLog || (a.deploying ? 'Waiting for output…' : 'Press Deploy to pull the latest code, build it and (re)start it with PM2. Output streams here.')}</pre></Card>}
      {tab === 'history' && (
        <Card pad={false}>
          {data.deployments.length ? <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Kind</th><th>By</th><th>Result</th><th>Commit</th><th className="num" /></tr></thead>
            <tbody>{data.deployments.map((d) => (
              <tr key={d.id}>
                <td className="muted">{dateTime(d.started_at)}</td><td>{d.kind}</td><td>{d.by_user}</td>
                <td><Badge tone={d.status === 'success' ? 'good' : d.status === 'failed' ? 'bad' : 'warn'} dot>{d.status}</Badge></td>
                <td><code>{d.commit_sha ? d.commit_sha.slice(0, 8) : '–'}</code></td>
                <td className="num"><button type="button" className="btn btn--small" onClick={async () => setViewDep((await api(`/api/apps/${a.id}/deployments/${d.id}`)).deployment)}>Log</button></td>
              </tr>
            ))}</tbody>
          </table></div> : <Empty icon="git" title="Nothing deployed yet" />}
        </Card>
      )}
      {tab === 'logs' && <Card actions={<button type="button" className="btn btn--small" onClick={showLogs}><Icon name="refresh" size={14} /> Refresh</button>} title="Last 300 lines from PM2">
        {logs == null ? <SkeletonRows /> : <pre className="log log--tall">{logs || 'No output yet.'}</pre>}</Card>}
      <Dialog open={!!viewDep} title={viewDep ? `${viewDep.kind} · ${dateTime(viewDep.started_at)}` : ''} onClose={() => setViewDep(null)} wide>
        <pre className="log">{viewDep?.log || 'No output recorded.'}</pre>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={() => setViewDep(null)}>Close</button></div>
      </Dialog>
      <AppForm open={editing} app={a} onClose={() => setEditing(false)} onSaved={reload} />
      {moving && <MoveDialog a={a} onClose={() => setMoving(false)} onDone={reload} />}
    </>
  );
}

export default function Apps({ selected }) {
  const { me } = useLive();
  const { data, error, reload } = useApi('/api/apps', { interval: 20000 });
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState('all');
  if (selected) return <AppDetail id={selected} />;
  const apps = (data?.apps || [])
    .filter((a) => target === 'all' || (a.target || 'server') === target)
    .filter((a) => !q || `${a.name} ${a.owner} ${a.repoUrl} ${where(a)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title="Applications" sub="Deploy from Git into your servers. Each app runs under PM2 inside its server."
        actions={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New application</button>} />
      <ErrorNote error={error} onRetry={reload} />
      {(data?.apps || []).length > 3 && (
        <div className="filters">
          <div className="input-icon"><Icon name="search" size={16} /><input placeholder={me.isAdmin ? 'Filter by app, owner or repository' : 'Filter'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="seg">{[['all', 'all'], ['main', 'main server'], ['vps', 'VPS'], ['server', 'cloud server']].map(([id, label]) => <button key={id} type="button" aria-pressed={target === id} onClick={() => setTarget(id)}>{label}</button>)}</div>
        </div>
      )}
      <Card pad={false}>
        {!data ? <div className="pad"><SkeletonRows /></div> : apps.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Application</th><th>Server</th><th>Price</th><th>Status</th><th>Repository</th><th>Domains</th><th>Last deploy</th>{me.isAdmin && <th>Owner</th>}</tr></thead>
            <tbody>{apps.map((a) => (
              <tr key={a.id} className="click" onClick={() => go(`apps/${a.id}`)}>
                <td><a href={href(`apps/${a.id}`)}><strong>{a.name}</strong></a><small className="block muted">{a.typeLabel} · port {a.port}</small></td>
                <td>{where(a)}</td>
                <td className="muted">{priceText(a)}</td>
                <td><Badge tone={STATUS_TONE[a.status]} dot>{a.deploying ? 'deploying' : a.status}</Badge></td>
                <td className="muted ellipsis">{a.repoUrl.replace(/^https:\/\//, '')}#{a.branch}</td>
                <td>{a.domains.map((d) => <span key={d.hostname} className="chip">{d.hostname}</span>)}</td>
                <td className="muted">{a.lastDeployAt ? ago(a.lastDeployAt) : 'never'}</td>
                {me.isAdmin && <td className="muted">{a.owner}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="app" title="No applications yet" action={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>Create your first app</button>}>
          Node.js, Next.js, React, NestJS, Express, Python, Laravel and static sites are supported.
        </Empty>}
      </Card>
      <AppForm open={creating} onClose={() => setCreating(false)} onSaved={(a) => { reload(); if (a) go(`apps/${a.id}`); }} />
    </>
  );
}
