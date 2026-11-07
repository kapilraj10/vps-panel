// VPS Fleet: all registered servers, add/edit, live facts from each node's agent, history, agent + SSH setup, incidents.
import { useEffect, useMemo, useState } from 'react';
import { api, bytes, ago, dateTime, uptime as fmtUptime, pct, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Stat, Tabs, Bar, Copy, TimeChart, href, go,
  useApi, useAction, useConfirm,
} from '../ui.jsx';

export const STATUS = {
  online: ['good', 'Online'], degraded: ['warn', 'Degraded'], maintenance: ['info', 'Maintenance'], agent_disconnected: ['warn', 'Agent disconnected'],
  offline: ['bad', 'Offline'], unreachable: ['bad', 'Unreachable'], no_agent: ['neutral', 'Reachable, no agent'], pending: ['neutral', 'Not checked yet'],
};
export const NodeStatus = ({ s }) => <Badge tone={(STATUS[s] || STATUS.pending)[0]} dot>{(STATUS[s] || [null, s])[1]}</Badge>;
const mbit = (b) => (b == null ? '–' : `${((b * 8) / 1e6).toFixed(b * 8 >= 1e7 ? 0 : 2)} Mbit/s`);
const upPct = (v) => (v == null ? '–' : `${v.toFixed(v >= 99.9 ? 3 : 2)}%`);

// Live list + updates over the socket
export function useNodes() {
  const { socket } = useLive();
  const q = useApi('/api/nodes', { interval: 15000 });
  const [over, setOver] = useState({});
  useEffect(() => {
    const onNode = (n) => setOver((o) => ({ ...o, [n.id]: n }));
    const onFacts = ({ id, summary }) => setOver((o) => ({ ...o, [id]: { ...(o[id] || {}), live: summary, _factsOnly: true } }));
    socket.on('node', onNode);
    socket.on('node:facts', onFacts);
    return () => { socket.off('node', onNode); socket.off('node:facts', onFacts); };
  }, [socket]);
  const list = (q.data?.nodes || []).map((n) => {
    const o = over[n.id];
    if (!o) return n;
    if (o.deleted) return null;
    return o._factsOnly ? { ...n, live: o.live } : { ...n, ...o };
  }).filter(Boolean);
  return { ...q, nodes: list };
}

function NodeForm({ node, onClose, onSaved }) {
  const run = useAction();
  const [f, setF] = useState(() => ({
    name: node?.name || '', provider: node?.provider || '', location: node?.location || '', publicIp: node?.public_ip || '', privateIp: node?.private_ip || '',
    netZone: node?.net_zone || '', sshPort: node?.ssh_port || 22, sshUser: node?.ssh_user || 'root', notes: node?.notes || '',
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    const body = { ...f, sshPort: Number(f.sshPort) };
    const r = node ? await run(() => api(`/api/nodes/${node.id}`, { method: 'PUT', body }), 'Saved')
      : await run(() => api('/api/nodes', { method: 'POST', body }), `${f.name} added`);
    if (r) { onSaved(r.node); onClose(); }
  }
  return (
    <Dialog open title={node ? `Edit ${node.name}` : 'Add a VPS server'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name"><input required autoFocus value={f.name} onChange={set('name')} placeholder="Kathmandu Main VPS" /></Field>
          <Field label="Provider"><input value={f.provider} onChange={set('provider')} placeholder="Hetzner, own hardware…" /></Field>
          <Field label="Location"><input value={f.location} onChange={set('location')} placeholder="Kathmandu" /></Field>
          <Field label="Public IP or hostname" hint="Used for SSH and reachability checks"><input value={f.publicIp} onChange={set('publicIp')} placeholder="203.0.113.10" /></Field>
          <Field label="Private IP (optional)"><input value={f.privateIp} onChange={set('privateIp')} placeholder="10.0.0.2" /></Field>
          <Field label="Private network name (optional)" hint="Servers with the same name ping each other on private IPs"><input value={f.netZone} onChange={set('netZone')} placeholder="ktm-lan" /></Field>
          <Field label="SSH port"><input type="number" min={1} max={65535} value={f.sshPort} onChange={set('sshPort')} /></Field>
          <Field label="SSH user"><input value={f.sshUser} onChange={set('sshUser')} pattern="[a-z_][a-z0-9_\-]{0,31}" /></Field>
        </div>
        <Field label="Notes" wide><textarea className="textarea" rows={2} value={f.notes} onChange={set('notes')} /></Field>
        <p className="muted small">Adding a server only registers it. It shows as Online only once its agent sends heartbeats (Agent tab) or, without an agent, its SSH port answers.</p>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">{node ? 'Save' : 'Add server'}</button></div>
      </form>
    </Dialog>
  );
}

function MasterSetup({ onClose, onDone, primary }) {
  const run = useAction();
  const [location, setLocation] = useState(primary?.location || 'Kathmandu');
  const [r, setR] = useState(null);
  async function submit(e) {
    e.preventDefault();
    const out = await run(() => api('/api/fleet/master/setup', { method: 'POST', body: { location } }));
    if (out) { setR(out); onDone(); }
  }
  return (
    <Dialog open title="Set up this server as the master" onClose={onClose} wide>
      {!r ? (
        <form className="form" onSubmit={submit}>
          <p>Registers the server this panel runs on as the primary server{primary ? ` (${primary.name})` : ''}, and lets the panel's SSH key log in to it as the panel's own user, so super admins get a host terminal in the SSH console.</p>
          <Field label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={80} /></Field>
          <Note>The key is added to a marked block in that user's <code>~/.ssh/authorized_keys</code> (other keys stay). Remove the block to revoke it. Every console session and command is recorded.</Note>
          <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Set up</button></div>
        </form>
      ) : (
        <div className="form">
          <p><Badge tone="good">{r.node.name}</Badge> is the primary server{r.node.location ? ` in ${r.node.location}` : ''}. Panel key {r.keyAdded ? 'added to' : 'already in'} <code>{r.keyFile}</code>.</p>
          {r.ssh.ok ? <Note>SSH works ({r.ssh.output.split('\n')[0]}). Host key pinned. <a href={href(`console?node=${r.node.id}`)}>Open the host terminal</a></Note>
            : <Note tone="warn">SSH test failed: {r.ssh.error}. Check that sshd runs on 127.0.0.1:{r.node.ssh_port} and allows key login, then use “Test SSH” on the server's SSH tab.</Note>}
          <p className="small">For live CPU / RAM / disk graphs, install the agent on this server too (Install agent on its page gives the one-time token):</p>
          <pre className="logbox mono">{r.agentCommand}</pre>
          <div className="dialog__buttons"><a className="btn" href={href(`fleet/${r.node.id}`)}>Open server</a><button type="button" className="btn btn--primary" onClick={onClose}>Done</button></div>
        </div>
      )}
    </Dialog>
  );
}

export function FleetList() {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const { nodes, data, error, reload } = useNodes();
  const [mastering, setMastering] = useState(false);
  const primary = nodes.find((n) => n.is_primary);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [adding, setAdding] = useState(() => window.location.hash.includes('?new'));
  const list = nodes
    .filter((n) => !q || `${n.name} ${n.provider || ''} ${n.location || ''} ${n.public_ip || ''} ${n.hostname || ''}`.toLowerCase().includes(q.toLowerCase()))
    .filter((n) => status === 'all' || (status === 'up' ? ['online', 'degraded'].includes(n.status) : !['online', 'degraded'].includes(n.status)));
  const up = nodes.filter((n) => ['online', 'degraded'].includes(n.status));
  const withLive = nodes.filter((n) => n.live);
  return (
    <>
      <PageHeader title="VPS Fleet" sub="Every registered server, measured by its own agent"
        actions={sup && <>
          <button type="button" className="btn" onClick={() => setMastering(true)}><Icon name="server" /> {primary?.ssh_host_key ? 'Master server' : 'Set up master server'}</button>
          <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add server</button>
        </>} />
      {mastering && <MasterSetup primary={primary} onClose={() => setMastering(false)} onDone={reload} />}
      <div className="kpis">
        <Stat label="Servers" icon="server" value={data ? nodes.length : null} sub={data ? `${up.length} online · ${nodes.length - up.length} not online` : ''} tone={nodes.some((n) => ['offline', 'unreachable'].includes(n.status)) ? 'bad' : ''} />
        <Stat label="CPU cores" icon="cpu" value={data ? withLive.reduce((s, n) => s + (n.live.cores || 0), 0) : null} sub="reported by agents" />
        <Stat label="RAM" icon="memory" value={data ? bytes(withLive.reduce((s, n) => s + (n.live.memUsed || 0), 0)) : null} sub={data ? `of ${bytes(withLive.reduce((s, n) => s + (n.live.memTotal || 0), 0))}` : ''} />
        <Stat label="Traffic now" icon="network" value={data ? `↓ ${mbit(withLive.reduce((s, n) => s + (n.live.rx || 0), 0))}` : null} sub={data ? `↑ ${mbit(withLive.reduce((s, n) => s + (n.live.tx || 0), 0))}` : ''} />
      </div>
      <div className="filters">
        <input className="filter" placeholder="Search name, provider, location, IP…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="filter" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option><option value="up">Online / degraded</option><option value="down">Not online</option></select>
      </div>
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error && <SkeletonRows />}
      {data && !nodes.length && (
        <Empty icon="server" title="No servers registered yet" action={sup && <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>Add your first server</button>}>
          Start with the main VPS (this panel's own server), then add the others. Each one gets a small agent that reports its real CPU, RAM, disk and network.
        </Empty>
      )}
      {list.length > 0 && (
        <Card pad={false}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Server</th><th>Status</th><th>Address</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Network</th><th>Uptime 30d</th><th>Heartbeat</th></tr></thead>
            <tbody>{list.map((n) => {
              const l = n.live;
              return (
                <tr key={n.id} className="row-link" onClick={() => go(`fleet/${n.id}`)}>
                  <td><a href={href(`fleet/${n.id}`)}><strong>{n.name}</strong></a> {n.is_primary ? <Badge tone="info">primary</Badge> : null}<br /><small className="muted">{[n.provider, n.location].filter(Boolean).join(' · ') || '–'}</small></td>
                  <td><NodeStatus s={n.status} />{n.status_since && <><br /><small className="muted">{ago(n.status_since)}</small></>}</td>
                  <td className="mono small">{n.public_ip || '–'}{n.private_ip && <><br />{n.private_ip}</>}</td>
                  <td>{l?.cpu != null ? <>{l.cpu}%<Bar value={l.cpu} /></> : '–'}</td>
                  <td>{l?.memTotal ? <>{pct(l.memUsed, l.memTotal)}%<Bar value={pct(l.memUsed, l.memTotal)} /></> : '–'}</td>
                  <td>{l?.diskTotal ? <>{pct(l.diskUsed, l.diskTotal)}%<Bar value={pct(l.diskUsed, l.diskTotal)} /></> : '–'}</td>
                  <td className="small">{l ? <>↓ {mbit(l.rx)}<br />↑ {mbit(l.tx)}</> : '–'}</td>
                  <td>{upPct(n.uptime30d)}</td>
                  <td className="small">{n.last_heartbeat_at ? ago(n.last_heartbeat_at) : n.hasAgent ? 'never' : 'no agent'}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </Card>
      )}
      {adding && <NodeForm onClose={() => setAdding(false)} onSaved={(n) => { reload(); go(`fleet/${n.id}`); }} />}
    </>
  );
}

// ---------- detail ----------
const VIRTUAL_IF = /^(veth|br-|docker|lxdbr|virbr|cni|flannel|tap|tun)/;
function Live({ facts }) {
  const [allIf, setAllIf] = useState(false);
  if (!facts) return <Note>No data from this server yet. Install the agent (Agent tab); measurements appear a few seconds after it connects.</Note>;
  const f = facts;
  const m = f.memory;
  const allIfaces = Object.entries(f.network.counters || {}).filter(([name]) => name !== 'lo');
  const hidden = allIfaces.filter(([name]) => VIRTUAL_IF.test(name)).length;
  const ifaces = allIf ? allIfaces : allIfaces.filter(([name]) => !VIRTUAL_IF.test(name));
  return (
    <>
      <div className="kpis">
        <Stat label="CPU" icon="cpu" value={f.cpu.usage != null ? `${f.cpu.usage}%` : '…'} sub={`${f.cpu.cores} cores · load ${f.cpu.load.map((x) => x.toFixed(2)).join(' ')}`}><Bar value={f.cpu.usage} /></Stat>
        <Stat label="RAM" icon="memory" value={bytes(m.used)} sub={`of ${bytes(m.total)} · ${bytes(m.available)} available`}><Bar value={pct(m.used, m.total)} /></Stat>
        <Stat label="Swap" icon="memory" value={m.swapTotal ? bytes(m.swapUsed) : 'none'} sub={m.swapTotal ? `of ${bytes(m.swapTotal)}` : ''}>{m.swapTotal ? <Bar value={pct(m.swapUsed, m.swapTotal)} /> : null}</Stat>
        <Stat label="Network" icon="network" value={`↓ ${mbit(f.network.rx)}`} sub={`↑ ${mbit(f.network.tx)} · ${f.network.established} connections`} />
        <Stat label="Disk I/O" icon="disk" value={`R ${bytes(f.diskIo.read)}/s`} sub={`W ${bytes(f.diskIo.write)}/s`} />
        <Stat label="Uptime" icon="monitor" value={fmtUptime(f.system.uptime)} sub={`booted ${dateTime(f.system.bootedAt)}`} />
      </div>
      <div className="grid2">
        <Card title="System">
          <dl className="kv">
            <dt>Hostname</dt><dd className="mono">{f.system.hostname}</dd>
            <dt>OS</dt><dd>{f.system.os.pretty}</dd>
            <dt>Kernel</dt><dd className="mono">{f.system.kernel} ({f.system.arch})</dd>
            <dt>CPU</dt><dd>{f.cpu.model}{f.cpu.mhz ? ` · ${f.cpu.mhz} MHz` : ''}</dd>
            <dt>Time zone</dt><dd>{f.system.timezone} · server time {new Date(f.system.time).toLocaleString([], { timeZone: f.system.timezone })}</dd>
            <dt>Processes</dt><dd>{f.processes?.count ?? '…'}</dd>
            <dt>Agent</dt><dd>v{f.system.agentVersion} on Node {f.system.node}</dd>
            <dt>Failed services</dt><dd>{f.failedServices == null ? '…' : f.failedServices.length ? f.failedServices.map((x) => <Badge key={x} tone="bad">{x}</Badge>) : 'none'}</dd>
          </dl>
        </Card>
        <Card title="CPU per core">
          <div className="cores">{f.cpu.perCore.map((v, i) => <div key={i} className="cores__row"><span className="muted small">#{i}</span><Bar value={v ?? 0} /><span className="small">{v ?? '…'}%</span></div>)}</div>
        </Card>
      </div>
      <Card pad={false} title="Disks">
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Mount</th><th>Device</th><th>Type</th><th>Size</th><th>Used</th><th>Free</th><th>Usage</th></tr></thead>
          <tbody>{f.disks.map((d) => <tr key={d.device}><td className="mono">{d.mount}</td><td className="mono small">{d.device}</td><td>{d.type}</td><td>{bytes(d.total)}</td><td>{bytes(d.used)}</td><td>{bytes(d.free)}</td><td style={{ minWidth: 120 }}>{pct(d.used, d.total)}%<Bar value={pct(d.used, d.total)} /></td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card pad={false} title="Network interfaces" sub={f.network.interfaces.length ? null : ''}
        actions={hidden > 0 && <label className="check small"><input type="checkbox" checked={allIf} onChange={(e) => setAllIf(e.target.checked)} /> show {hidden} virtual (Docker/LXD/bridges)</label>}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Interface</th><th>Addresses</th><th>↓ now</th><th>↑ now</th><th>Total ↓ / ↑</th><th>Packets ↓ / ↑</th><th>Errors</th><th>Drops</th></tr></thead>
          <tbody>{ifaces.map(([name, c]) => {
            const ip = f.network.interfaces.find((i) => i.name === name);
            return (
              <tr key={name}><td className="mono">{name}</td><td className="mono small addr">{ip?.addresses.map((a) => <div key={a.address}>{a.cidr || a.address}</div>) || '–'}</td>
                <td>{mbit(c.rxRate)}</td><td>{mbit(c.txRate)}</td><td>{bytes(c.rx)} / {bytes(c.tx)}</td><td className="small">{c.rxPackets.toLocaleString()} / {c.txPackets.toLocaleString()}</td>
                <td className={c.rxErrors + c.txErrors ? 'is-bad' : ''}>{c.rxErrors + c.txErrors}</td><td>{c.rxDrops + c.txDrops}</td></tr>
            );
          })}</tbody>
        </table></div>
      </Card>
      <div className="grid2">
        <Card title="Listening ports" sub={`${f.network.listening.length} TCP sockets`}>
          <div className="ports">{f.network.listening.map((l) => <span key={`${l.addr}:${l.port}`} className={`port ${['0.0.0.0', '::'].includes(l.addr) ? 'port--public' : ''}`} title={l.addr === '0.0.0.0' || l.addr === '::' ? 'all interfaces' : l.addr}>{l.port}<small>{['0.0.0.0', '::'].includes(l.addr) ? 'all' : l.addr}</small></span>)}</div>
        </Card>
        <Card title="Top processes by memory">
          {!f.processes ? <SkeletonRows rows={3} /> : (
            <table className="table table--compact"><tbody>{f.processes.topMemory.map((p) => <tr key={p.pid}><td className="mono small">{p.pid}</td><td>{p.name}</td><td className="small muted">uid {p.user}</td><td>{bytes(p.rss)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    </>
  );
}

const RANGES = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
function Metrics({ id }) {
  const [range, setRange] = useState('24h');
  const { data, error } = useApi(`/api/nodes/${id}/metrics?range=${range}`, { interval: 60000, deps: [range] });
  const pts = (data?.points || []).map((p) => ({
    t: p.ts, cpu: p.cpu, cpuMax: p.cpu_max ?? null, mem: p.mem_total ? pct(p.mem_used, p.mem_total) : null, swap: p.swap_total ? pct(p.swap_used, p.swap_total) : null,
    disk: p.disk_total ? pct(p.disk_used, p.disk_total) : null, rx: Math.round((p.rx * 8) / 1e4) / 100, tx: Math.round((p.tx * 8) / 1e4) / 100,
    ior: Math.round(p.io_read / 1024), iow: Math.round(p.io_write / 1024), load: p.load1, conns: p.connections,
  }));
  const long = ['7d', '30d'].includes(range);
  const tick = (t) => (long ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <>
      <div className="filters">{RANGES.map(([k, l]) => <button key={k} type="button" className={`btn btn--small ${range === k ? 'btn--primary' : ''}`} onClick={() => setRange(k)}>{l}</button>)}
        <span className="muted small">{long ? 'hourly averages' : 'per-minute averages'}</span></div>
      <ErrorNote error={error} />
      <div className="grid2">
        <Card title="CPU %"><TimeChart data={pts} series={[{ key: 'cpu', name: 'avg', color: 's1' }, ...(long ? [{ key: 'cpuMax', name: 'max', color: 's2' }] : [])]} unit="%" domain={[0, 100]} tickTime={tick} height={190} /></Card>
        <Card title="Memory %"><TimeChart data={pts} series={[{ key: 'mem', name: 'RAM', color: 's1' }, { key: 'swap', name: 'swap', color: 's2' }]} unit="%" domain={[0, 100]} tickTime={tick} height={190} /></Card>
        <Card title="Network (Mbit/s)"><TimeChart data={pts} series={[{ key: 'rx', name: 'download', color: 's1' }, { key: 'tx', name: 'upload', color: 's2' }]} unit=" Mbit/s" tickTime={tick} height={190} /></Card>
        <Card title="Disk I/O (KB/s)"><TimeChart data={pts} series={[{ key: 'ior', name: 'read', color: 's1' }, { key: 'iow', name: 'write', color: 's2' }]} unit=" KB/s" tickTime={tick} height={190} /></Card>
        <Card title="Load (1 min)"><TimeChart data={pts} series={[{ key: 'load', name: 'load', color: 's1' }]} tickTime={tick} height={190} /></Card>
        <Card title="Disk used %"><TimeChart data={pts} series={[{ key: 'disk', name: 'root fs', color: 's1' }]} unit="%" domain={[0, 100]} tickTime={tick} height={190} /></Card>
      </div>
    </>
  );
}

function AgentTab({ n, reload }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const [tok, setTok] = useState(null);
  const [opt, setOpt] = useState({ user: '', docker: false, pm2: false, mdocker: false });
  const master = window.location.origin;
  const cmd = tok && [
    `curl -fsSL ${master}/agent/v1/install.sh | sudo bash -s --`, `--master ${master}`, `--token ${tok.token}`,
    opt.user && `--user ${opt.user}`, opt.docker && '--docker', opt.pm2 && '--manage-pm2', opt.mdocker && '--manage-docker',
  ].filter(Boolean).join(' ');
  async function revoke() {
    const typed = await confirm({ title: `Revoke the agent key of ${n.name}?`, body: 'The agent is disconnected and can only come back after a new enrollment. Nothing on the server is removed.', typed: n.name, danger: true, confirmLabel: 'Revoke' });
    if (typed && await run(() => api(`/api/nodes/${n.id}/agent/revoke`, { method: 'POST', body: { confirm: typed } }), 'Agent key revoked')) reload();
  }
  return (
    <div className="grid2">
      <Card title="Agent" sub="A small Node.js process on the server; it connects out to this panel, so the server needs no open port.">
        <dl className="kv">
          <dt>State</dt><dd>{n.agentConnected ? <Badge tone="good" dot>connected {n.connectedAt ? ago(n.connectedAt) : ''}</Badge> : n.hasAgent ? <Badge tone="warn" dot>{n.agent_enabled ? 'not connected' : 'disconnected by an admin'}</Badge> : <Badge>not installed</Badge>}</dd>
          <dt>Version</dt><dd>{n.agent_version || '–'}</dd>
          <dt>Last heartbeat</dt><dd>{n.last_heartbeat_at ? `${ago(n.last_heartbeat_at)} (${dateTime(n.last_heartbeat_at)})` : 'never'}</dd>
          <dt>Connects from</dt><dd className="mono">{n.last_seen_ip || '–'}</dd>
        </dl>
        {sup && (
          <div className="btn-row mt8">
            {n.agentConnected && <button type="button" className="btn" onClick={() => run(() => api(`/api/nodes/${n.id}/agent/test`, { method: 'POST' }), (r) => `Agent answered in ${r.ms} ms (v${r.version}, ${r.hostname})`)}>Test agent</button>}
            {n.hasAgent && (n.agent_enabled
              ? <button type="button" className="btn" onClick={() => run(() => api(`/api/nodes/${n.id}/agent/disconnect`, { method: 'POST' }), 'Agent disconnected').then(reload)}>Disconnect</button>
              : <button type="button" className="btn" onClick={() => run(() => api(`/api/nodes/${n.id}/agent/connect`, { method: 'POST' }), 'Agent allowed to connect again').then(reload)}>Connect</button>)}
            {n.hasAgent && <button type="button" className="btn btn--danger" onClick={revoke}>Revoke key</button>}
          </div>
        )}
      </Card>
      {sup && (
        <Card title={n.hasAgent ? 'Reinstall / re-enroll' : 'Install the agent'} sub="Needs Node.js 22+ on the server. Run as root (sudo).">
          <div className="fgrid">
            <Field label="Run as user" hint="Empty = new unprivileged kapil-agent user. To see a user's PM2, run it as that user."><input value={opt.user} onChange={(e) => setOpt({ ...opt, user: e.target.value })} placeholder="kapil-agent" /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={opt.docker} onChange={(e) => setOpt({ ...opt, docker: e.target.checked })} /> Docker access (adds the user to the docker group; root-equivalent)</label>
          <label className="check"><input type="checkbox" checked={opt.pm2} onChange={(e) => setOpt({ ...opt, pm2: e.target.checked })} /> Allow PM2 actions from the panel</label>
          <label className="check"><input type="checkbox" checked={opt.mdocker} onChange={(e) => setOpt({ ...opt, mdocker: e.target.checked })} /> Allow container start/stop/restart from the panel</label>
          {!tok ? <button type="button" className="btn btn--primary mt8" onClick={() => run(() => api(`/api/nodes/${n.id}/enroll-token`, { method: 'POST' })).then((t) => t && setTok(t))}>Create install command</button> : (
            <>
              <div className="cmd"><code className="mono">{cmd}</code><Copy text={cmd} /></div>
              <p className="muted small">The token works once and expires {dateTime(tok.expiresAt)}. The installer checks the agent's SHA-256 before running it.</p>
            </>
          )}
          <Note>If Cloudflare Access protects the panel hostname, add a Bypass policy for the path <code>/agent/*</code> (agents cannot log in through Access).</Note>
        </Card>
      )}
    </div>
  );
}

function SshTab({ n, reload }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const key = useApi('/api/ssh/public-key');
  const [result, setResult] = useState(null);
  const [own, setOwn] = useState(null);
  const line = key.data && n.ssh_user && `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${key.data.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  async function test() {
    setResult({ busy: true });
    try { setResult(await api(`/api/nodes/${n.id}/ssh/test`, { method: 'POST' })); reload(); } catch (e) { setResult({ error: e.message }); }
  }
  async function forget() {
    const typed = await confirm({ title: 'Forget the pinned host key?', body: 'Only do this if you reinstalled the server or changed its SSH host keys. The next test pins whatever key the server presents.', typed: n.name, danger: true, confirmLabel: 'Forget' });
    if (typed && await run(() => api(`/api/nodes/${n.id}/ssh/forget-host-key`, { method: 'POST', body: { confirm: typed } }), 'Host key forgotten')) reload();
  }
  return (
    <div className="grid2">
      <Card title="SSH connection">
        <dl className="kv">
          <dt>Endpoint</dt><dd className="mono">{n.ssh_user || '?'}@{n.public_ip || '?'}:{n.ssh_port}</dd>
          <dt>Key</dt><dd>{n.hasOwnSshKey ? 'this server\'s own key (stored encrypted)' : 'panel key'}</dd>
          <dt>Pinned host key</dt><dd className="mono small">{n.ssh_host_key || 'not pinned yet: run Test SSH'}</dd>
        </dl>
        {sup && <div className="btn-row mt8">
          <button type="button" className="btn btn--primary" disabled={result?.busy} onClick={test}>{result?.busy ? 'Testing…' : 'Test SSH'}</button>
          {n.ssh_host_key && <a className="btn" href={href(`console?node=${n.id}`)}><Icon name="terminal" /> Open console</a>}
          {n.ssh_host_key && <button type="button" className="btn btn--danger" onClick={forget}>Forget host key</button>}
          <button type="button" className="btn" onClick={() => setOwn({ privateKey: '', passphrase: '' })}>Use own key…</button>
        </div>}
        {result?.error && <Note tone="bad">{result.error}</Note>}
        {result?.ok && <Note tone="info">Connected in {result.ms} ms{result.pinnedNow ? `; host key pinned (${result.hostKey})` : ''}.<pre className="logbox mono">{result.output}</pre></Note>}
      </Card>
      <Card title="Panel public key" sub="Add it to authorized_keys of the SSH user on this server">
        {key.data && <>
          <div className="cmd"><code className="mono">{key.data.publicKey}</code><Copy text={key.data.publicKey} /></div>
          <p className="muted small">Fingerprint {key.data.fingerprint}. On the server, as {n.ssh_user || 'the SSH user'}:</p>
          {line && <div className="cmd"><code className="mono">{line}</code><Copy text={line} /></div>}
          <p className="muted small">The private key never leaves the panel and is stored encrypted. Prefer a non-root user with sudo.</p>
        </>}
      </Card>
      {own && (
        <Dialog open title={`Own SSH key for ${n.name}`} onClose={() => setOwn(null)}>
          <form className="form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api(`/api/nodes/${n.id}/ssh/key`, { method: 'PUT', body: own }), own.privateKey ? 'Key saved (encrypted)' : 'Back to the panel key')) { setOwn(null); reload(); } }}>
            <Field label="Private key (OpenSSH / PEM)" hint="Stored encrypted; it is never shown again. Leave empty to use the panel key."><textarea className="textarea mono" rows={6} value={own.privateKey} onChange={(e) => setOwn({ ...own, privateKey: e.target.value })} spellCheck={false} /></Field>
            <Field label="Passphrase (if any)"><input type="password" value={own.passphrase} onChange={(e) => setOwn({ ...own, passphrase: e.target.value })} autoComplete="off" /></Field>
            <div className="dialog__buttons"><button type="button" className="btn" onClick={() => setOwn(null)}>Cancel</button><button type="submit" className="btn btn--primary">Save</button></div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

function Incidents({ id }) {
  const { data } = useApi(`/api/nodes/${id}/incidents`, { interval: 30000 });
  if (!data) return <SkeletonRows />;
  if (!data.incidents.length) return <Empty icon="check" title="No incidents recorded" />;
  return <IncidentTable rows={data.incidents} />;
}
export function IncidentTable({ rows, showNode = false }) {
  const dur = (a, b) => fmtUptime(Math.round(((b || Date.now()) - a) / 1000)) || '<1m';
  return (
    <Card pad={false}>
      <div className="table-wrap"><table className="table">
        <thead><tr>{showNode && <th>Server</th>}<th>What</th><th>Started</th><th>Ended</th><th>Duration</th></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}>{showNode && <td><a href={href(`fleet/${i.node_id}`)}>{i.node_name}</a></td>}
            <td><NodeStatus s={i.kind} /></td><td>{dateTime(i.started_at)}</td><td>{i.ended_at ? dateTime(i.ended_at) : <Badge tone="bad">ongoing</Badge>}</td><td>{dur(i.started_at, i.ended_at)}</td></tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

export function NodeDetail({ id, tab }) {
  const { me, socket } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/nodes/${id}`, { interval: 20000 });
  const [facts, setFacts] = useState(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (data) setFacts(data.facts); }, [data]);
  useEffect(() => {
    const on = (m) => { if (String(m.id) === String(id)) setFacts(m.facts); };
    const onNode = (n) => { if (String(n.id) === String(id)) reload(); };
    socket.on('node:facts', on);
    socket.on('node', onNode);
    return () => { socket.off('node:facts', on); socket.off('node', onNode); };
  }, [socket, id, reload]);
  if (error && !data) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return <SkeletonRows rows={6} />;
  const n = data.node;
  async function remove() {
    const typed = await confirm({ title: `Remove ${n.name} from the panel?`, body: 'Only the registration is removed (metrics and incidents too). Nothing on the server is changed; its agent will be refused. Uninstall it there with the installer\'s --uninstall.', typed: n.name, danger: true, confirmLabel: 'Remove' });
    if (typed && await run(() => api(`/api/nodes/${n.id}`, { method: 'DELETE', body: { confirm: typed } }), `${n.name} removed`)) go('fleet');
  }
  const t = ['overview', 'metrics', 'agent', 'ssh', 'incidents'].includes(tab) ? tab : 'overview';
  return (
    <>
      <PageHeader back={href('fleet')} title={<>{n.name} {n.is_primary ? <Badge tone="info">primary</Badge> : null}</>}
        sub={[n.provider, n.location, n.public_ip, n.os].filter(Boolean).join(' · ')}
        actions={<>
          <NodeStatus s={n.status} />
          {sup && n.ssh_host_key && <a className="btn" href={href(`console?node=${n.id}`)}><Icon name="terminal" /> Console</a>}
          {sup && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>}
          {sup && !n.is_primary && <button type="button" className="btn" onClick={() => run(() => api(`/api/nodes/${n.id}/primary`, { method: 'POST' }), `${n.name} is now the primary server`).then(reload)}>Make primary</button>}
          {sup && <button type="button" className="btn" onClick={() => run(() => api(`/api/nodes/${n.id}/maintenance`, { method: 'POST', body: { on: !n.maintenance } }), n.maintenance ? 'Maintenance ended' : 'In maintenance: alerts and downtime are not counted').then(reload)}>{n.maintenance ? 'End maintenance' : 'Maintenance'}</button>}
          {sup && <button type="button" className="btn btn--danger" onClick={remove}><Icon name="trash" /></button>}
        </>} />
      {n.openIncident && <Note tone="bad"><strong><NodeStatus s={n.openIncident.kind} /></strong> since {dateTime(n.openIncident.started_at)} ({ago(n.openIncident.started_at)}).</Note>}
      <div className="kpis kpis--fleet">
        <Stat label="Uptime 24 h" icon="activity" value={upPct(n.uptime24h)} />
        <Stat label="Uptime 7 days" icon="activity" value={upPct(n.uptime7d)} />
        <Stat label="Uptime 30 days" icon="activity" value={upPct(n.uptime30d)} />
        <Stat label="Last heartbeat" icon="bell" value={n.last_heartbeat_at ? ago(n.last_heartbeat_at) : 'never'} sub={n.probe ? `SSH port ${n.probe.ok ? `answered in ${n.probe.ms} ms` : 'not answering'}` : ''} />
      </div>
      <div className="tabs-row"><TabsLinks id={n.id} value={t} /></div>
      {t === 'overview' && <Live facts={facts} />}
      {t === 'metrics' && <Metrics id={n.id} />}
      {t === 'agent' && <AgentTab n={n} reload={reload} />}
      {t === 'ssh' && <SshTab n={n} reload={reload} />}
      {t === 'incidents' && <Incidents id={n.id} />}
      {editing && <NodeForm node={n} onClose={() => setEditing(false)} onSaved={reload} />}
    </>
  );
}
const TabsLinks = ({ id, value }) => <Tabs tabs={[['overview', 'Live'], ['metrics', 'History'], ['agent', 'Agent'], ['ssh', 'SSH'], ['incidents', 'Incidents']]} value={value} hrefFor={(t) => href(`fleet/${id}/${t}`)} />;

export default function Fleet({ selected, tab }) {
  return selected ? <NodeDetail key={selected} id={selected} tab={tab} /> : <FleetList />;
}

export function useNodeOptions() {
  const { nodes } = useNodes();
  return useMemo(() => nodes, [nodes]);
}
