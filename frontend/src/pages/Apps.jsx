import { useEffect, useRef, useState } from 'react';
import { api, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Note, Icon, Field, Tabs, href, go, useApi, useAction, useConfirm,
} from '../ui.jsx';

const STATUS_TONE = { running: 'good', deploying: 'warn', failed: 'bad', stopped: 'neutral', new: 'neutral' };

function AppForm({ open, onClose, app, onSaved }) {
  const { me, cts } = useLive();
  const run = useAction();
  const types = useApi('/api/apps/types');
  const [f, setF] = useState(null);
  const [envText, setEnvText] = useState('');
  const servers = Object.values(cts).filter((c) => me.isAdmin || me.containers.includes(c.name)).map((c) => c.name).sort();
  useEffect(() => {
    if (!open) return;
    if (app) {
      setF({ ...app, gitToken: '' });
      api(`/api/apps/${app.id}/env`).then((d) => setEnvText(Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join('\n'))).catch(() => setEnvText(''));
    } else {
      setF({ container: servers[0] || '', name: '', type: 'node', repoUrl: '', branch: 'main', rootDir: '', outputDir: '', installCmd: '', buildCmd: '', startCmd: '', port: '', gitToken: '' });
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
    const body = { ...f, port: Number(f.port), env: envText };
    if (!f.gitToken) delete body.gitToken;
    const r = app ? await run(() => api(`/api/apps/${app.id}`, { method: 'PUT', body }), 'Application saved')
      : await run(() => api('/api/apps', { method: 'POST', body }), `Created ${f.name}`);
    if (r) { onSaved(r.app); onClose(); }
  }
  return (
    <Dialog open={open} title={app ? `Edit ${app.name}` : 'New application'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          {!app && <Field label="Server"><select required value={f.container} onChange={set('container')}>{servers.map((s) => <option key={s}>{s}</option>)}</select></Field>}
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
          <button type="submit" className="btn btn--primary">{app ? 'Save' : 'Create application'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function AppDetail({ id }) {
  const { socket, cts } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/apps/${id}`);
  const [tab, setTab] = useState('deploy');
  const [liveLog, setLiveLog] = useState('');
  const [viewDep, setViewDep] = useState(null);
  const [logs, setLogs] = useState(null);
  const [editing, setEditing] = useState(false);
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
  const serverUp = cts[a.container]?.status === 'Running';
  const op = async (kind) => { setLiveLog(''); setTab('deploy'); await run(() => api(`/api/apps/${a.id}/${kind}`, { method: 'POST' })); reload(); };
  const showLogs = async () => { setTab('logs'); setLogs(null); const r = await run(() => api(`/api/apps/${a.id}/logs`)); setLogs(r ? r.text : ''); };
  const del = async () => {
    const typed = await confirm({ title: `Delete ${a.name}?`, typed: a.name, danger: true, confirmLabel: 'Delete app', body: 'Its PM2 process is stopped and removed. The code folder in the server is kept.' });
    if (typed && await run(() => api(`/api/apps/${a.id}`, { method: 'DELETE', body: { confirm: typed } }), `Deleted ${a.name}`)) go('apps');
  };

  return (
    <>
      <PageHeader back={href('apps')} title={<span className="title-with-badge">{a.name} <Badge tone={STATUS_TONE[a.status]} dot>{a.deploying ? 'deploying' : a.status}</Badge></span>}
        sub={`${a.typeLabel} on ${a.container} · port ${a.port}${a.lastDeployAt ? ` · deployed ${ago(a.lastDeployAt)}` : ''}`}
        actions={(
          <div className="btn-row">
            <button type="button" className="btn btn--primary" disabled={a.deploying || !serverUp} onClick={() => op('deploy')}><Icon name="git" size={14} /> Deploy</button>
            <button type="button" className="btn" disabled={a.deploying || !serverUp} onClick={() => op('restart')}><Icon name="refresh" size={14} /> Restart</button>
            <button type="button" className="btn" disabled={a.deploying || !serverUp} onClick={() => op('start')}><Icon name="play" size={14} /> Start</button>
            <button type="button" className="btn" disabled={a.deploying || !serverUp} onClick={() => op('stop')}><Icon name="stop" size={14} /> Stop</button>
            <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="btn btn--danger" onClick={del} aria-label="Delete app"><Icon name="trash" size={14} /></button>
          </div>
        )} />
      {!serverUp && <Note tone="warn">{a.container} is not running. Start the server to deploy or control this app.</Note>}
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
    </>
  );
}

export default function Apps({ selected }) {
  const { me } = useLive();
  const { data, error, reload } = useApi('/api/apps', { interval: 20000 });
  const [creating, setCreating] = useState(false);
  if (selected) return <AppDetail id={selected} />;
  const apps = data?.apps || [];
  return (
    <>
      <PageHeader title="Applications" sub="Deploy from Git into your servers. Each app runs under PM2 inside its server."
        actions={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New application</button>} />
      <ErrorNote error={error} onRetry={reload} />
      <Card pad={false}>
        {!data ? <div className="pad"><SkeletonRows /></div> : apps.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Application</th><th>Server</th><th>Status</th><th>Repository</th><th>Domains</th><th>Last deploy</th>{me.isAdmin && <th>Owner</th>}</tr></thead>
            <tbody>{apps.map((a) => (
              <tr key={a.id} className="click" onClick={() => go(`apps/${a.id}`)}>
                <td><a href={href(`apps/${a.id}`)}><strong>{a.name}</strong></a><small className="block muted">{a.typeLabel} · port {a.port}</small></td>
                <td>{a.container}</td>
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
