// PM2 Manager: the host's PM2 processes. Admins see; super admins act.
import { useState } from 'react';
import { api, bytes, ago, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, useApi, useAction, useConfirm, Stat } from '../ui.jsx';

const TONE = { online: 'good', stopped: 'neutral', errored: 'bad', launching: 'warn', stopping: 'warn' };

export function LogDialog({ title, url, onClose }) {
  const { data, error, reload } = useApi(url, { interval: 5000 });
  const text = data ? (data.logs ?? [data.out && `── stdout ──\n${data.out}`, data.err && `── stderr ──\n${data.err}`].filter(Boolean).join('\n\n')) : '';
  return (
    <Dialog open title={title} onClose={onClose} wide>
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error ? <SkeletonRows /> : <pre className="logbox mono">{text || 'No log lines yet.'}</pre>}
      <div className="dialog__buttons"><button type="button" className="btn" onClick={reload}>Refresh</button><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function NewProcess({ onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', cwd: '', script: 'server.js', args: '', instances: 1, port: '', maxMemoryMb: '', env: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    const body = { ...f, instances: Number(f.instances), port: f.port ? Number(f.port) : undefined, maxMemoryMb: f.maxMemoryMb ? Number(f.maxMemoryMb) : undefined };
    if (await run(() => api('/api/pm2/processes', { method: 'POST', body }), `Started ${f.name}`)) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="Start a PM2 process" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name"><input required value={f.name} onChange={set('name')} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" /></Field>
          <Field label="App folder (absolute)" hint="Must be inside HOST_APP_ROOTS"><input required value={f.cwd} onChange={set('cwd')} placeholder="/home/kapil/apps/pos" /></Field>
          <Field label="Script / binary" hint="server.js, dist/main.js, or npm"><input required value={f.script} onChange={set('script')} /></Field>
          <Field label="Arguments" hint="e.g. start (for npm)"><input value={f.args} onChange={set('args')} /></Field>
          <Field label="Instances" hint=">1 = cluster mode"><input type="number" min={1} max={32} value={f.instances} onChange={set('instances')} /></Field>
          <Field label="PORT (optional)"><input type="number" min={1024} max={65535} value={f.port} onChange={set('port')} /></Field>
          <Field label="Restart above (MB)"><input type="number" min={32} value={f.maxMemoryMb} onChange={set('maxMemoryMb')} /></Field>
        </div>
        <Field label="Environment" hint="KEY=value per line" wide><textarea className="textarea mono" rows={4} value={f.env} onChange={set('env')} spellCheck={false} /></Field>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Start</button></div>
      </form>
    </Dialog>
  );
}

export default function Pm2Page() {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/pm2/processes', { interval: 5000 });
  const [q, setQ] = useState('');
  const [logs, setLogs] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = (data?.processes || []).filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const act = async (p, action) => { if (await run(() => api(`/api/pm2/processes/${p.id}/${action}`, { method: 'POST' }), `${p.name}: ${action} done`)) reload(); };
  async function scale(p) {
    const n = window.prompt(`Instances for ${p.name}`, String(p.instances));
    if (n && await run(() => api(`/api/pm2/processes/${p.id}/scale`, { method: 'POST', body: { instances: Number(n) } }), `${p.name} scaled to ${n}`)) reload();
  }
  async function remove(p) {
    const typed = await confirm({ title: `Delete ${p.name} from PM2?`, body: 'The process stops and is removed from PM2. Files are not touched.', typed: p.name, danger: true, confirmLabel: 'Delete' });
    if (typed && await run(() => api(`/api/pm2/processes/${p.id}`, { method: 'DELETE', body: { confirm: typed } }), `${p.name} deleted`)) reload();
  }
  const online = (data?.processes || []).filter((p) => p.status === 'online');
  return (
    <>
      <PageHeader title="PM2 Manager" sub="Node.js processes managed by PM2 on this server"
        actions={sup && (
          <>
            <button type="button" className="btn" onClick={() => run(() => api('/api/pm2/save', { method: 'POST' }), 'Process list saved (restored on reboot)')}>Save list</button>
            <button type="button" className="btn" onClick={() => run(() => api('/api/pm2/resurrect', { method: 'POST' }), 'Saved processes restored').then(reload)}>Resurrect</button>
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" /> New process</button>
          </>
        )} />
      <div className="kpis">
        <Stat label="Processes" icon="app" value={data ? data.processes.length : null} sub={data ? `${online.length} online` : ''} />
        <Stat label="CPU" icon="cpu" value={data ? `${Math.round(online.reduce((s, p) => s + p.cpu, 0))}%` : null} sub="sum of processes" />
        <Stat label="Memory" icon="memory" value={data ? bytes(online.reduce((s, p) => s + p.memory, 0)) : null} sub="resident" />
        <Stat label="Restarts" icon="refresh" value={data ? data.processes.reduce((s, p) => s + p.restarts, 0) : null} sub="since start" tone={(data?.processes || []).some((p) => p.status === 'errored') ? 'bad' : ''} />
      </div>
      <Card pad={false} title="Processes" actions={<input className="filter" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <ErrorNote error={error} onRetry={reload} />
        {!data && !error && <div className="pad"><SkeletonRows /></div>}
        {data && !list.length && <Empty icon="app" title="No PM2 processes">Start one with “New process”, or create a replicated app under Applications.</Empty>}
        {list.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>PID</th><th>Mode</th><th>Port</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Restarts</th><th /></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong> {p.managed && <Badge tone="info">replica</Badge>} {p.self && <Badge tone="info">this panel</Badge>}<br /><small className="muted mono">{p.cwd}</small></td>
                    <td><Badge tone={TONE[p.status] || 'neutral'} dot>{p.status}</Badge></td>
                    <td className="mono">{p.pid || '–'}</td>
                    <td>{p.mode}{p.mode === 'cluster' ? ` ×${p.instances}` : ''}</td>
                    <td className="mono">{p.port || '–'}</td>
                    <td>{p.cpu}%</td>
                    <td>{bytes(p.memory)}</td>
                    <td>{p.uptime ? ago(p.uptime).replace(' ago', '') : '–'}</td>
                    <td>{p.restarts}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn--small" onClick={() => setLogs(p)}>Logs</button>
                        {sup && (p.status === 'online'
                          ? <><button type="button" className="btn btn--small" onClick={() => act(p, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(p, 'reload')} title="Zero-downtime reload (cluster mode)">Reload</button>{!p.self && <button type="button" className="btn btn--small" onClick={() => act(p, 'stop')}>Stop</button>}</>
                          : <button type="button" className="btn btn--small" onClick={() => act(p, 'start')}>Start</button>)}
                        {sup && p.mode === 'cluster' && <button type="button" className="btn btn--small" onClick={() => scale(p)}>Scale</button>}
                        {sup && <button type="button" className="btn btn--small" onClick={() => act(p, 'flush')}>Clear logs</button>}
                        {sup && !p.managed && !p.self && <button type="button" className="btn btn--small btn--danger" onClick={() => remove(p)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {logs && <LogDialog title={`Logs: ${logs.name}`} url={`/api/pm2/processes/${logs.id}/logs?lines=300`} onClose={() => setLogs(null)} />}
      {creating && <NewProcess onClose={() => setCreating(false)} onDone={reload} />}
    </>
  );
}
