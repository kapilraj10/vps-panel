// Replicas & Load Balancer: host applications running as several PM2 processes or Docker containers behind Nginx.
import { useEffect, useState } from 'react';
import { api, bytes, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Stat, TimeChart, href, go, useApi, useAction, useConfirm,
} from '../ui.jsx';
import { LogDialog } from './Pm2Page.jsx';

const HEALTH = { healthy: 'good', unhealthy: 'bad', unknown: 'neutral' };
const label = (r) => (r.idx === 0 ? 'Primary' : `Replica ${r.idx}`);

function useHostAppEvents(reload) {
  const { socket } = useLive();
  useEffect(() => {
    const on = () => reload();
    socket.on('hostapp', on);
    return () => socket.off('hostapp', on);
  }, [socket, reload]);
}

function NewApp({ onClose }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', runtime: 'pm2', cwd: '', script: 'server.js', args: '', image: '', containerPort: '3000', replicas: 3, basePort: '', healthPath: '/', maxMemoryMb: '', cpus: '', serverName: '', env: '', loadBalancer: true });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function submit(e) {
    e.preventDefault();
    const body = { ...f, replicas: Number(f.replicas), basePort: f.basePort ? Number(f.basePort) : undefined, containerPort: Number(f.containerPort), maxMemoryMb: f.maxMemoryMb ? Number(f.maxMemoryMb) : undefined, cpus: f.cpus || undefined };
    const r = await run(() => api('/api/infra/apps', { method: 'POST', body }), `${f.name}: starting ${f.replicas} instance(s)`);
    if (r) { onClose(); go(`replicas/${r.app.id}`); }
  }
  const n = Number(f.replicas) || 1;
  return (
    <Dialog open title="New replicated application" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]" placeholder="sampanna-pos" /></Field>
          <Field label="Runs as"><select value={f.runtime} onChange={set('runtime')}><option value="pm2">PM2 processes</option><option value="docker">Docker containers</option></select></Field>
          <Field label="Instances" hint={`Primary + ${n - 1} replica(s)`}><input type="number" min={1} max={10} value={f.replicas} onChange={set('replicas')} /></Field>
          <Field label="First port (optional)" hint={f.basePort ? `Uses ${Array.from({ length: n }, (_, i) => Number(f.basePort) + i).join(', ')}` : 'Free ports are picked from 5000-5999'}><input type="number" min={1024} max={65535} value={f.basePort} onChange={set('basePort')} placeholder="5000" /></Field>
          {f.runtime === 'pm2' ? <>
            <Field label="App folder (absolute)" hint="Inside HOST_APP_ROOTS"><input required value={f.cwd} onChange={set('cwd')} placeholder="/home/kapil/apps/sampanna-pos" /></Field>
            <Field label="Script / binary"><input required value={f.script} onChange={set('script')} /></Field>
            <Field label="Arguments"><input value={f.args} onChange={set('args')} placeholder="start" /></Field>
          </> : <>
            <Field label="Image"><input required value={f.image} onChange={set('image')} placeholder="ghcr.io/you/pos:1.4.0" /></Field>
            <Field label="Port inside the container"><input required type="number" min={1} max={65535} value={f.containerPort} onChange={set('containerPort')} /></Field>
            <Field label="CPUs per replica"><input type="number" step="0.1" min={0.1} value={f.cpus} onChange={set('cpus')} /></Field>
          </>}
          <Field label="Health check path" hint="Must answer < 500"><input value={f.healthPath} onChange={set('healthPath')} /></Field>
          <Field label="Memory per instance (MB)"><input type="number" min={32} value={f.maxMemoryMb} onChange={set('maxMemoryMb')} /></Field>
          <Field label="Domain(s) for Nginx (optional)" hint="Space separated"><input value={f.serverName} onChange={set('serverName')} placeholder="pos.example.com" /></Field>
        </div>
        <Field label="Environment (shared by every instance)" hint="KEY=value per line. Stored encrypted, never shown again. Point all instances at the same DATABASE_URL." wide>
          <textarea className="textarea mono" rows={4} value={f.env} onChange={set('env')} spellCheck={false} />
        </Field>
        <label className="check"><input type="checkbox" checked={f.loadBalancer} onChange={set('loadBalancer')} /> Put an Nginx load balancer in front (listens on 127.0.0.1; point your Cloudflare Tunnel route at it)</label>
        <p className="muted small">Each instance gets its own <code>PORT</code>. PM2 instances are processes named <code>kc-&lt;app&gt;-&lt;n&gt;</code>; Docker ones are containers with the same names.</p>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Create and start</button></div>
      </form>
    </Dialog>
  );
}

function TrafficEditor({ app, replicas, onSaved }) {
  const run = useAction();
  const [rows, setRows] = useState(() => replicas.map((r) => ({ idx: r.idx, weight: r.weight, enabled: !!r.enabled })));
  useEffect(() => setRows(replicas.map((r) => ({ idx: r.idx, weight: r.weight, enabled: !!r.enabled }))), [replicas.map((r) => `${r.idx}:${r.weight}:${r.enabled}`).join()]);
  const total = rows.filter((r) => r.enabled && r.weight > 0).reduce((s, r) => s + Number(r.weight), 0);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const preset = (w) => setRows(rows.map((r, i) => ({ ...r, weight: w(i), enabled: true })));
  const dirty = rows.some((r, i) => r.weight !== replicas[i]?.weight || r.enabled !== !!replicas[i]?.enabled);
  async function save() {
    if (await run(() => api(`/api/infra/apps/${app.id}/traffic`, { method: 'PUT', body: { replicas: rows.map((r) => ({ ...r, weight: Number(r.weight) })) } }), 'Traffic updated (nginx -t passed, reloaded)')) onSaved();
  }
  return (
    <Card title="Traffic split" sub="Weights are relative. 0 = hot standby (only used if the others fail). Unhealthy instances are removed automatically."
      actions={<>
        <button type="button" className="btn btn--small" onClick={() => preset(() => 1)}>Equal</button>
        <button type="button" className="btn btn--small" onClick={() => preset((i) => (i === 0 ? 1 : 0))}>Primary only</button>
        {rows.length === 3 && <button type="button" className="btn btn--small" onClick={() => preset((i) => (i === 0 ? 50 : 25))}>50/25/25</button>}
      </>}>
      <div className="traffic">
        {rows.map((r, i) => {
          const share = r.enabled && r.weight > 0 && total ? Math.round((r.weight / total) * 100) : 0;
          return (
            <div key={r.idx} className="traffic__row">
              <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => set(i, 'enabled', e.target.checked)} /> {label(replicas[i])}</label>
              <input type="range" min={0} max={100} value={r.weight} disabled={!r.enabled} onChange={(e) => set(i, 'weight', Number(e.target.value))} aria-label={`Weight for ${label(replicas[i])}`} />
              <input type="number" min={0} max={100} value={r.weight} disabled={!r.enabled} onChange={(e) => set(i, 'weight', Number(e.target.value))} className="traffic__num" />
              <span className="traffic__share">{!r.enabled ? 'off' : r.weight === 0 ? 'standby' : `${share}%`}</span>
            </div>
          );
        })}
      </div>
      <div className="btn-row mt8"><button type="button" className="btn btn--primary" disabled={!dirty} onClick={save}>Apply traffic split</button>{dirty && <button type="button" className="btn" onClick={() => setRows(replicas.map((r) => ({ idx: r.idx, weight: r.weight, enabled: !!r.enabled })))}>Reset</button>}</div>
    </Card>
  );
}

function TrafficCharts({ app }) {
  const { data, error } = useApi(`/api/infra/apps/${app.id}/traffic`, { interval: 10000 });
  if (error) return <ErrorNote error={error} />;
  if (!data) return <SkeletonRows />;
  const l = data.last5m;
  const shares = Object.entries(l.byPort).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div className="kpis">
        <Stat label="Requests / s" icon="activity" value={l.rps} sub={`${l.requests} in the last 5 min`} />
        <Stat label="Avg response" icon="chart" value={`${l.avgMs} ms`} sub="Nginx request time" />
        <Stat label="Errors (5xx)" icon="alert" tone={l.codes.s5xx ? 'bad' : ''} value={l.codes.s5xx} sub={`2xx ${l.codes.s2xx} · 3xx ${l.codes.s3xx} · 4xx ${l.codes.s4xx}`} />
        <Stat label="Active connections" icon="network" value={data.connections ? data.connections.active : 'n/a'} sub="all Nginx sites (stub_status)" />
      </div>
      <div className="grid2">
        <Card title="Requests per second"><TimeChart data={data.series} series={[{ key: 'rps', name: 'req/s', color: 's1' }]} height={180} /></Card>
        <Card title="Response time"><TimeChart data={data.series} series={[{ key: 'avgMs', name: 'avg', color: 's1' }, { key: 'p95Ms', name: 'p95', color: 's2' }]} unit=" ms" height={180} /></Card>
        <Card title="Status codes"><TimeChart data={data.series} series={[{ key: 's2xx', name: '2xx', color: 'good' }, { key: 's4xx', name: '4xx', color: 'warn' }, { key: 's5xx', name: '5xx', color: 'alarm' }]} height={180} /></Card>
        <Card title="Where traffic went (last 5 min)">
          {!shares.length ? <p className="muted">No requests logged yet{data.logging ? '' : ' (the access log appears after the first request through Nginx)'}.</p> : (
            <div className="dist">
              {shares.map(([port, n]) => (
                <div key={port} className="dist__row"><span className="mono">:{port}</span><div className="dist__bar"><i style={{ width: `${Math.round((n / l.requests) * 100)}%` }} /></div><span>{Math.round((n / l.requests) * 100)}%</span></div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function AppDetail({ id }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/infra/apps/${id}`, { interval: 5000 });
  const [logs, setLogs] = useState(null);
  const [showConf, setShowConf] = useState(false);
  const [image, setImage] = useState('');
  useHostAppEvents(reload);
  if (error && !data) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return <SkeletonRows rows={6} />;
  const { app, replicas, events } = data;
  const act = async (r, a) => { if (await run(() => api(`/api/infra/apps/${id}/replicas/${r.idx}/${a}`, { method: 'POST' }), `${label(r)}: ${a} done`)) reload(); };
  async function removeReplica(r) {
    const typed = await confirm({ title: `Remove ${label(r)}?`, body: `It is taken out of the load balancer first, then its ${app.runtime === 'pm2' ? 'PM2 process' : 'container'} is deleted. Port ${r.port} is freed.`, typed: label(r).toLowerCase(), danger: true, confirmLabel: 'Remove' });
    if (typed && await run(() => api(`/api/infra/apps/${id}/replicas/${r.idx}`, { method: 'DELETE', body: { confirm: typed } }), `${label(r)} removed`)) reload();
  }
  async function removeApp() {
    const typed = await confirm({ title: `Delete ${app.name}?`, body: `All ${replicas.length} instance(s) are stopped and deleted and the Nginx site is removed. App files${app.runtime === 'docker' ? ' and images' : ''} stay.`, typed: app.name, danger: true, confirmLabel: 'Delete application' });
    if (typed && await run(() => api(`/api/infra/apps/${id}`, { method: 'DELETE', body: { confirm: typed } }), `${app.name} deleted`)) go('replicas');
  }
  const rolling = async (img) => {
    const ok = await confirm({ title: img ? `Roll out ${img}?` : 'Rolling restart?', body: img ? 'One instance at a time: drained from the load balancer, recreated with the new image, health-checked, put back. If one fails its health check it is rolled back and the rollout stops.' : 'One instance at a time: drained, restarted, health-checked, put back. No downtime when there are 2+ healthy instances.', confirmLabel: 'Start' });
    if (ok && await run(() => api(`/api/infra/apps/${id}/rolling`, { method: 'POST', body: img ? { image: img } : {} }), 'Started; progress shows below')) reload();
  };
  const healthy = replicas.filter((r) => r.health === 'healthy' && r.desired === 'running').length;
  return (
    <>
      <PageHeader back={href('replicas')} title={app.name} sub={`${app.runtime === 'pm2' ? 'PM2' : 'Docker'} · ${replicas.length} instance(s) · ${app.lb_port ? `load balancer 127.0.0.1:${app.lb_port}` : 'no load balancer'}${app.server_name ? ` · ${app.server_name}` : ''}`}
        actions={sup && <>
          <button type="button" className="btn" disabled={!!app.busy} onClick={() => rolling(null)}><Icon name="refresh" /> Rolling restart</button>
          <button type="button" className="btn" disabled={!!app.busy || replicas.length >= 10} onClick={() => run(() => api(`/api/infra/apps/${id}/replicas`, { method: 'POST', body: {} }), 'Adding a replica').then(reload)}><Icon name="plus" /> Add replica</button>
          <button type="button" className="btn btn--danger" onClick={removeApp}><Icon name="trash" /> Delete</button>
        </>} />
      {app.busy && <Note tone="warn">Running: {app.busy}…</Note>}
      {!app.busy && app.op_status === 'failed' && <Note tone="bad"><strong>{app.op} failed:</strong> {app.op_message}</Note>}
      {data.runtimeError && <Note tone="bad">Could not read {app.runtime === 'pm2' ? 'PM2' : 'Docker'}: {data.runtimeError}</Note>}
      <div className="kpis">
        <Stat label="Healthy" icon="check" tone={healthy === 0 ? 'bad' : healthy < replicas.filter((r) => r.desired === 'running').length ? 'warn' : ''} value={`${healthy} / ${replicas.length}`} sub={`health check ${app.health_path}`} />
        <Stat label="CPU" icon="cpu" value={`${Math.round(replicas.reduce((s, r) => s + (r.runtime?.cpu || 0), 0) * 10) / 10}%`} sub="all instances" />
        <Stat label="Memory" icon="memory" value={bytes(replicas.reduce((s, r) => s + (r.runtime?.memory || 0), 0))} sub={app.max_memory_mb ? `limit ${app.max_memory_mb} MB each` : 'no limit'} />
        <Stat label="Version" icon="git" value={<span className="mono small">{app.version || '–'}</span>} sub={app.runtime === 'pm2' ? app.cwd : 'image'} />
      </div>
      <Card pad={false} title="Instances">
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Instance</th><th>Port</th><th>Process</th><th>Health</th><th>In load balancer</th><th>CPU / RAM</th><th>Response</th><th /></tr></thead>
          <tbody>{replicas.map((r) => (
            <tr key={r.id}>
              <td><strong>{label(r)}</strong><br /><small className="muted mono">kc-{app.name}-{r.idx}</small></td>
              <td className="mono">{r.port}</td>
              <td>{r.runtime ? <Badge tone={['online', 'running'].includes(r.runtime.status) ? 'good' : 'neutral'} dot>{r.runtime.status}</Badge> : <Badge>missing</Badge>}{r.runtime?.restarts ? <small className="muted"> · {r.runtime.restarts} restarts</small> : null}</td>
              <td><Badge tone={HEALTH[r.health]} dot>{r.desired === 'stopped' ? 'stopped' : r.health}</Badge>{r.last_error && r.health === 'unhealthy' && <><br /><small className="muted">{r.last_error}</small></>}</td>
              <td>{r.draining ? <Badge tone="warn">draining</Badge> : <Badge tone={r.lbState === 'active' ? 'good' : r.lbState === 'backup' ? 'info' : 'neutral'}>{r.lbState === 'active' ? `weight ${r.weight}` : r.lbState}</Badge>}</td>
              <td>{r.runtime ? `${r.runtime.cpu ?? 0}% · ${bytes(r.runtime.memory || 0)}` : '–'}</td>
              <td>{r.response_ms != null ? `${r.response_ms} ms` : '–'}<br /><small className="muted">{r.last_check_at ? ago(r.last_check_at) : ''}</small></td>
              <td><div className="row-actions">
                <button type="button" className="btn btn--small" onClick={() => setLogs(r)}>Logs</button>
                {sup && (r.desired === 'running'
                  ? <><button type="button" className="btn btn--small" onClick={() => act(r, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(r, 'stop')}>Stop</button></>
                  : <button type="button" className="btn btn--small" onClick={() => act(r, 'start')}>Start</button>)}
                {sup && replicas.length > 1 && <button type="button" className="btn btn--small btn--danger" onClick={() => removeReplica(r)}>Remove</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
      {sup && app.lb_port && <TrafficEditor app={app} replicas={replicas} onSaved={reload} />}
      {sup && app.runtime === 'docker' && (
        <Card title="Deploy a new version" sub="Rolling update with automatic rollback">
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); rolling(image); }}>
            <input required value={image} onChange={(e) => setImage(e.target.value)} placeholder={app.version || 'repo/image:tag'} />
            <button type="submit" className="btn btn--primary" disabled={!!app.busy}>Roll out</button>
          </form>
        </Card>
      )}
      {app.lb_port && <TrafficCharts app={app} />}
      <div className="grid2">
        <Card title="Events" sub="Health changes, failovers, traffic switches, deploys">
          {!events.length ? <p className="muted">No events yet.</p> : (
            <ul className="events">{events.map((e) => (
              <li key={e.id} className={`events__item events__item--${e.level}`}><span className="muted small" title={dateTime(e.ts)}>{ago(e.ts)}</span> <Badge tone={e.level === 'error' ? 'bad' : 'neutral'}>{e.kind}</Badge> {e.message}{e.by_user && <small className="muted"> · {e.by_user}</small>}</li>
            ))}</ul>
          )}
        </Card>
        <Card title="Nginx" sub={app.lb_port ? `Upstream for 127.0.0.1:${app.lb_port}` : 'No load balancer'} actions={app.lb_port && <>
          <button type="button" className="btn btn--small" onClick={() => setShowConf((v) => !v)}>{showConf ? 'Hide' : 'Show'} config</button>
          {sup && <button type="button" className="btn btn--small" onClick={() => run(() => api(`/api/infra/apps/${id}/lb/apply`, { method: 'POST' }), (r) => (r.changed ? 'Nginx config applied' : 'Already up to date')).then(reload)}>Re-apply</button>}
        </>}>
          {app.lb_port && <p className="small">Cloudflare Tunnel: route your hostname to <code>http://localhost:{app.lb_port}</code>.</p>}
          {showConf && <pre className="logbox mono">{data.nginx || 'Not written yet (load balancer not set up on this server?).'}</pre>}
        </Card>
      </div>
      {logs && <LogDialog title={`Logs: ${app.name} ${label(logs)}`} url={`/api/infra/apps/${id}/replicas/${logs.idx}/logs?lines=300`} onClose={() => setLogs(null)} />}
    </>
  );
}

function AppList() {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const { data, error, reload } = useApi('/api/infra/apps', { interval: 10000 });
  const lb = useApi('/api/infra/lb/status');
  const [creating, setCreating] = useState(false);
  useHostAppEvents(reload);
  return (
    <>
      <PageHeader title="Replicas & Load Balancer" sub="Applications running as several instances on this server, behind Nginx"
        actions={sup && <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" /> New application</button>} />
      {lb.data && (!lb.data.writable || !lb.data.nginx) && (
        <Note tone="warn">
          <strong>Load balancer not set up on this server.</strong> {!lb.data.nginx ? 'Nginx was not found. ' : ''}{!lb.data.writable ? `${lb.data.confDir} is missing or not writable by the panel. ` : ''}
          Replicas still run, but traffic switching needs it. On the server run <code>sudo bash ~/vps-panel/system/install-lb.sh</code> (see docs/HOST_APPS.md).
        </Note>
      )}
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error && <SkeletonRows />}
      {data && !data.apps.length && <Empty icon="app" title="No replicated applications yet" action={sup && <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>New application</button>}>Run an app as a primary and replicas (PM2 or Docker), each on its own port, with Nginx spreading traffic and taking unhealthy instances out.</Empty>}
      <div className="cards">
        {(data?.apps || []).map((a) => {
          const running = a.replicas.filter((r) => r.desired === 'running');
          const ok = running.filter((r) => r.health === 'healthy').length;
          return (
            <a key={a.id} className="card card--link" href={href(`replicas/${a.id}`)}>
              <div className="card__head"><div><h2 className="card__title">{a.name}</h2><p className="card__sub">{a.runtime === 'pm2' ? 'PM2' : 'Docker'}{a.lb_port ? ` · LB :${a.lb_port}` : ''}{a.server_name ? ` · ${a.server_name}` : ''}</p></div>
                <Badge tone={!running.length ? 'neutral' : ok === running.length ? 'good' : ok ? 'warn' : 'bad'} dot>{ok}/{a.replicas.length} healthy</Badge></div>
              <div className="pad replica-dots">
                {a.replicas.map((r) => <span key={r.id} className={`rdot rdot--${r.desired === 'stopped' ? 'stopped' : r.health}`} title={`${label(r)} :${r.port} ${r.health}`}>{r.idx === 0 ? 'P' : r.idx}<small>:{r.port}</small></span>)}
              </div>
              {a.busy && <div className="pad"><Badge tone="warn">{a.busy}…</Badge></div>}
            </a>
          );
        })}
      </div>
      {creating && <NewApp onClose={() => setCreating(false)} />}
    </>
  );
}

export default function HostApps({ selected }) {
  return selected ? <AppDetail key={selected} id={selected} /> : <AppList />;
}
