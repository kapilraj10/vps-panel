// PM2 / Docker on other VPS servers (through their agents) and the "All servers" overview.
import { useState } from 'react';
import { api, bytes, ago } from '../lib.jsx';
import { useLive } from '../live.js';
import { Card, Badge, Empty, SkeletonRows, ErrorNote, Note, href, useApi, useAction, useConfirm } from '../ui.jsx';
import { useNodes } from './Fleet.jsx';
import { LogDialog } from './Pm2Page.jsx';

const PM2_TONE = { online: 'good', stopped: 'neutral', errored: 'bad', launching: 'warn' };
const DK_TONE = { running: 'good', exited: 'neutral', paused: 'warn', restarting: 'warn', dead: 'bad' };

export function HostPicker({ value, onChange }) {
  const { nodes } = useNodes();
  return (
    <select className="filter host-picker" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Server">
      <option value="local">This server (panel host)</option>
      <option value="all">All servers</option>
      {nodes.map((n) => <option key={n.id} value={n.id} disabled={!n.agentConnected}>{n.name}{n.agentConnected ? '' : ' (agent offline)'}</option>)}
    </select>
  );
}

export function FleetPm2({ nodeId }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const all = nodeId === 'all';
  const { data, error, reload } = useApi(all ? '/api/fleet/pm2' : `/api/nodes/${nodeId}/pm2`, { interval: all ? 15000 : 5000, deps: [nodeId] });
  const { nodes } = useNodes();
  const [logs, setLogs] = useState(null);
  const groups = all ? (data?.nodes || []) : data ? [{ id: Number(nodeId), name: nodes.find((n) => String(n.id) === String(nodeId))?.name, available: data.available, error: data.error, processes: data.processes || [], connected: true }] : [];
  const act = async (g, p, action) => {
    let body = {};
    if (action === 'delete') {
      const typed = await confirm({ title: `Delete ${p.name} on ${g.name}?`, typed: String(p.id), body: `Type the PM2 id (${p.id}).`, danger: true, confirmLabel: 'Delete' });
      if (!typed) return;
      body = { confirm: typed };
    }
    if (await run(() => api(`/api/nodes/${g.id}/pm2/${p.id}/${action}`, { method: 'POST', body }), `${g.name}: ${p.name} ${action} done`)) reload();
  };
  return (
    <>
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error && <SkeletonRows />}
      {all && <p className="muted small">From each agent's latest heartbeat (up to ~30 s old). Pick one server for a live list.</p>}
      {groups.map((g) => (
        <Card key={g.id} pad={false} title={<a href={href(`fleet/${g.id}`)}>{g.name}</a>} sub={!g.connected ? 'agent offline' : g.available === false ? g.error : `${g.processes.length} process(es)`}
          actions={sup && g.connected && g.available && <button type="button" className="btn btn--small" onClick={() => run(() => api(`/api/nodes/${g.id}/pm2/save`, { method: 'POST' }), `${g.name}: process list saved`)}>Save list</button>}>
          {g.available && !g.processes.length && <div className="pad muted">No PM2 processes.</div>}
          {g.processes.length > 0 && (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>PID</th><th>Mode</th><th>Port</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Restarts</th><th /></tr></thead>
              <tbody>{g.processes.map((p) => (
                <tr key={p.id}><td><strong>{p.name}</strong>{p.cwd && <><br /><small className="muted mono">{p.cwd}</small></>}</td>
                  <td><Badge tone={PM2_TONE[p.status] || 'neutral'} dot>{p.status}</Badge></td><td className="mono">{p.pid || '–'}</td>
                  <td>{p.mode}{p.mode === 'cluster' ? ` ×${p.instances}` : ''}</td><td className="mono">{p.port || '–'}</td><td>{p.cpu}%</td><td>{bytes(p.memory)}</td>
                  <td>{p.uptime ? ago(p.uptime).replace(' ago', '') : '–'}</td><td>{p.restarts}</td>
                  <td><div className="row-actions">
                    <button type="button" className="btn btn--small" onClick={() => setLogs({ g, p })}>Logs</button>
                    {sup && (p.status === 'online'
                      ? <><button type="button" className="btn btn--small" onClick={() => act(g, p, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(g, p, 'reload')}>Reload</button><button type="button" className="btn btn--small" onClick={() => act(g, p, 'stop')}>Stop</button></>
                      : <button type="button" className="btn btn--small" onClick={() => act(g, p, 'start')}>Start</button>)}
                    {sup && <button type="button" className="btn btn--small" onClick={() => act(g, p, 'flush')}>Clear logs</button>}
                    {sup && <button type="button" className="btn btn--small btn--danger" onClick={() => act(g, p, 'delete')}>Delete</button>}
                  </div></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      ))}
      {data && !groups.length && <Empty title="No servers registered" />}
      <Note>Actions only work on servers whose agent was installed with <code>--manage-pm2</code>; otherwise the agent refuses them (read-only).</Note>
      {logs && <LogDialog title={`Logs: ${logs.g.name} / ${logs.p.name}`} url={`/api/nodes/${logs.g.id}/pm2/${logs.p.id}/logs?lines=300`} onClose={() => setLogs(null)} />}
    </>
  );
}

export function FleetDocker({ nodeId }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const all = nodeId === 'all';
  const { data, error, reload } = useApi(all ? '/api/fleet/docker' : `/api/nodes/${nodeId}/docker`, { interval: all ? 15000 : 5000, deps: [nodeId] });
  const { nodes } = useNodes();
  const [logs, setLogs] = useState(null);
  const groups = all ? (data?.nodes || []) : data ? [{ id: Number(nodeId), name: nodes.find((n) => String(n.id) === String(nodeId))?.name, available: data.available, error: data.error, containers: data.containers || [], connected: true }] : [];
  const act = async (g, c, a) => { if (await run(() => api(`/api/nodes/${g.id}/docker/${c.id}/${a}`, { method: 'POST' }), `${g.name}: ${c.name} ${a} done`)) reload(); };
  return (
    <>
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error && <SkeletonRows />}
      {groups.map((g) => (
        <Card key={g.id} pad={false} title={<a href={href(`fleet/${g.id}`)}>{g.name}</a>} sub={!g.connected ? 'agent offline' : g.available === false ? g.error : `${g.containers.length} container(s)`}>
          {g.containers.length > 0 && (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Image</th><th>State</th><th>Ports</th><th>Created</th><th /></tr></thead>
              <tbody>{g.containers.map((c) => (
                <tr key={c.id}><td><strong>{c.name}</strong> {c.compose && <Badge>{c.compose}</Badge>}</td><td className="mono small">{c.image}</td>
                  <td><Badge tone={DK_TONE[c.state] || 'neutral'} dot>{c.state}</Badge><br /><small className="muted">{c.status}</small></td>
                  <td className="mono small">{c.ports.map((p) => `${p.ip || '0.0.0.0'}:${p.host}→${p.container}`).join(', ') || '–'}</td><td>{ago(c.createdAt)}</td>
                  <td><div className="row-actions">
                    <button type="button" className="btn btn--small" onClick={() => setLogs({ g, c })}>Logs</button>
                    {sup && (c.state === 'running'
                      ? <><button type="button" className="btn btn--small" onClick={() => act(g, c, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(g, c, 'stop')}>Stop</button></>
                      : <button type="button" className="btn btn--small" onClick={() => act(g, c, 'start')}>Start</button>)}
                  </div></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      ))}
      <Note>Remote servers support list, logs, start, stop and restart (agent installed with <code>--docker</code>, actions with <code>--manage-docker</code>). Create/remove/images are on “This server” for now.</Note>
      {logs && <LogDialog title={`Logs: ${logs.g.name} / ${logs.c.name}`} url={`/api/nodes/${logs.g.id}/docker/${logs.c.id}/logs?tail=300`} onClose={() => setLogs(null)} />}
    </>
  );
}
