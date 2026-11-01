import { useEffect, useMemo, useState } from 'react';
import { api, bytes, pct, uptime, ago, MAX_POINTS } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Stat, Bar, Badge, ServerStatus, TimeChart, Empty, SkeletonRows, ErrorNote, Icon, href, useApi,
} from '../ui.jsx';

const GiB = 1024 ** 3;
export const levelTone = (l) => (l === 'critical' ? 'bad' : l === 'warning' ? 'warn' : 'neutral');

export function AlertList({ alerts, limit = 6, empty = 'No open alerts. Everything looks healthy.' }) {
  if (!alerts.length) return <Empty icon="check" title="All clear">{empty}</Empty>;
  return (
    <ul className="alerts">
      {alerts.slice(0, limit).map((a) => (
        <li key={a.id} className={`alerts__item alerts__item--${levelTone(a.level)}`}>
          <Icon name="alert" size={16} />
          <div>
            <div>{a.message}</div>
            <small className="muted">{a.level} · {ago(a.created_at)}{a.acknowledged_by ? ` · acknowledged by ${a.acknowledged_by}` : ''}</small>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ServerRow({ c, job }) {
  const busy = job?.status === 'running' ? `${job.action}…` : null;
  return (
    <a className="srow" href={href(`servers/${c.name}`)}>
      <div className="srow__name">
        <span className="srow__icon"><Icon name="server" /></span>
        <div><strong>{c.name}</strong><small>{c.image || 'Linux container'}{c.ip ? ` · ${c.ip}` : ''}</small></div>
      </div>
      <ServerStatus status={c.status} busy={busy} />
      <div className="srow__metric"><span>CPU</span><Bar value={c.cpu} /><b>{c.status === 'Running' ? `${c.cpu}%` : '–'}</b></div>
      <div className="srow__metric"><span>RAM</span><Bar value={pct(c.memUsed, c.memTotal)} /><b>{c.status === 'Running' ? `${pct(c.memUsed, c.memTotal)}%` : '–'}</b></div>
      <div className="srow__metric"><span>Disk</span><Bar value={pct(c.diskUsed, c.diskTotal)} /><b>{c.diskTotal ? `${pct(c.diskUsed, c.diskTotal)}%` : bytes(c.diskUsed)}</b></div>
    </a>
  );
}

function AdminOverview() {
  const { socket, cts, jobs, alerts } = useLive();
  const ov = useApi('/api/overview', { interval: 15000 });
  const alloc = useApi('/api/allocation', { interval: 60000 });
  const [hist, setHist] = useState([]);
  const [info, setInfo] = useState(null);
  const [up, setUp] = useState(0);

  useEffect(() => {
    api('/api/snapshot').then((d) => { setHist(d.history.slice(-MAX_POINTS)); setInfo(d.info); setUp(d.uptime); }).catch(() => {});
    const onSample = (d) => { setHist((h) => [...h.slice(-(MAX_POINTS - 1)), d.point]); setUp(d.uptime); };
    socket.on('sample', onSample);
    return () => socket.off('sample', onSample);
  }, [socket]);

  const last = hist.at(-1);
  const series = useMemo(() => hist.map((p) => ({ t: p.t, cpu: p.cpu, ram: pct(p.ramUsed, p.ramTotal) })), [hist]);
  const net = useMemo(() => hist.map((p) => ({ t: p.t, rx: p.rx, tx: p.tx })), [hist]);
  const list = Object.values(cts).sort((a, b) => a.name.localeCompare(b.name));
  const d = ov.data;
  const backup = d?.backup;
  const bstat = backup?.lastJob?.status;

  return (
    <>
      <PageHeader title="Overview" sub={info ? `${info.hostname} · ${info.distro} · ${info.cpu}` : 'Master server'}
        actions={<a className="btn btn--primary" href={href('servers?new')}><Icon name="plus" size={16} /> Create server</a>} />
      {d?.lxdError && <ErrorNote error={`LXD is not reachable: ${d.lxdError}`} />}

      <div className="kpis">
        <Stat label="CPU" icon="cpu" value={last ? `${last.cpu}%` : null} sub={info ? `${info.cores} cores · load ${last?.load1 ?? '–'}` : ''}><Bar value={last?.cpu} /></Stat>
        <Stat label="Memory" icon="memory" value={last ? bytes(last.ramUsed) : null} sub={last ? `of ${bytes(last.ramTotal)} · ${bytes(last.ramTotal - last.ramUsed)} free` : ''}><Bar value={last && pct(last.ramUsed, last.ramTotal)} /></Stat>
        <Stat label="Disk" icon="storage" value={last ? bytes(last.diskUsed) : null} sub={last ? `of ${bytes(last.diskTotal)} · ${bytes(last.diskTotal - last.diskUsed)} free` : ''}><Bar value={last && pct(last.diskUsed, last.diskTotal)} /></Stat>
        <Stat label="Network" icon="network" value={last ? `↓ ${bytes(last.rx)}/s` : null} sub={last ? `↑ ${bytes(last.tx)}/s` : ''} />
        <Stat label="Temperature" icon="activity" value={last ? (last.temp != null ? `${last.temp}°C` : 'n/a') : null} sub={last?.temp == null ? 'No sensor exposed' : 'CPU package'} />
        <Stat label="Uptime" icon="monitor" value={up ? uptime(up) : null} sub={info?.kernel ? `Kernel ${info.kernel}` : ''} />
      </div>

      <div className="kpis kpis--fleet">
        <Stat label="Servers" icon="server" value={d ? d.servers.total : null} sub={d ? `${d.servers.running} running · ${d.servers.stopped} stopped` : ''} />
        <Stat label="Users" icon="users" value={d ? d.users.total : null} sub={d ? `${d.users.active} active now${d.users.suspended ? ` · ${d.users.suspended} suspended` : ''}` : ''} />
        <Stat label="Applications" icon="app" value={d ? d.apps : null} sub={d ? `${d.domains} live domain(s)${d.pendingDomains ? ` · ${d.pendingDomains} pending` : ''}` : ''} />
        <Stat label="Backups" icon="backup" tone={bstat === 'failed' ? 'bad' : ''}
          value={d ? (bstat ? <Badge tone={bstat === 'success' ? 'good' : bstat === 'failed' ? 'bad' : 'warn'} dot>{bstat}</Badge> : 'None yet') : null}
          sub={backup?.lastJob?.finishedAt ? `Last ${ago(backup.lastJob.finishedAt)}${backup.disk?.free != null ? ` · ${bytes(backup.disk.free)} free` : ''}` : backup?.disk?.error || ''} />
      </div>

      <div className="grid2">
        <Card title="CPU and memory" sub="Last hour, live">
          <TimeChart data={series} series={[{ key: 'cpu', name: 'CPU', color: 's1' }, { key: 'ram', name: 'Memory', color: 's2' }]} unit="%" domain={[0, 100]} />
        </Card>
        <Card title="Network throughput" sub="Last hour, live (host interfaces)">
          <TimeChart data={net} series={[{ key: 'rx', name: 'Download', color: 's1' }, { key: 'tx', name: 'Upload', color: 's2' }]} format={(v) => `${bytes(v)}/s`} />
        </Card>
      </div>

      <div className="grid2 grid2--wide-left">
        <Card title="Servers" actions={<a className="btn btn--small" href={href('servers')}>All servers</a>} pad={false}>
          {list.length ? list.map((c) => <ServerRow key={c.name} c={c} job={jobs[c.name]} />)
            : <Empty icon="server" title="No servers yet" action={<a className="btn btn--primary" href={href('servers?new')}>Create the first server</a>} />}
        </Card>
        <Card title="Alerts" actions={<a className="btn btn--small" href={href('monitoring')}>Monitoring</a>}>
          <AlertList alerts={alerts} />
        </Card>
      </div>

      <Card title="Resource allocation" sub="What containers were promised versus what the host can give"
        actions={<a className="btn btn--small" href={href('settings')}>Overcommit settings</a>}>
        {alloc.error && <ErrorNote error={alloc.error} />}
        {!alloc.data ? <SkeletonRows /> : <Allocation a={alloc.data} />}
      </Card>
    </>
  );
}

export function Allocation({ a }) {
  return (
    <>
      <div className="alloc">
        <div className="alloc__row">
          <span>vCPU</span><Bar value={(a.cpu.allocated / a.cpu.capacity) * 100} />
          <b>{a.cpu.allocated} / {a.cpu.capacity}</b><small>{a.host.cores} cores × {a.settings.cpuOvercommit}</small>
        </div>
        <div className="alloc__row">
          <span>Memory</span><Bar value={(a.memory.allocated / a.memory.capacity) * 100} />
          <b>{(a.memory.allocated / GiB).toFixed(1)} / {(a.memory.capacity / GiB).toFixed(1)} GiB</b>
          <small>{(a.host.memory / GiB).toFixed(1)} GiB − {(a.settings.hostMemoryReserve / GiB).toFixed(1)} GiB host reserve</small>
        </div>
        {a.pools.map((p) => (
          <div className="alloc__row" key={p.name}>
            <span>Disk ({p.name})</span><Bar value={p.capacity ? (p.allocated / p.capacity) * 100 : 0} />
            <b>{(p.allocated / GiB).toFixed(0)} / {p.capacity ? (p.capacity / GiB).toFixed(0) : '?'} GiB</b>
            <small>{p.driver}{p.used != null ? ` · ${bytes(p.used)} actually used` : ''}</small>
          </div>
        ))}
      </div>
      {a.warnings.map((w) => <p key={w} className="warn-line"><Icon name="alert" size={14} /> {w}</p>)}
    </>
  );
}

function UserOverview() {
  const { me, cts, jobs, alerts } = useLive();
  const ov = useApi('/api/overview', { interval: 30000 });
  const list = me.containers.map((n) => cts[n]).filter(Boolean);
  const mem = list.reduce((s, c) => s + (c.memUsed || 0), 0);
  const memMax = list.reduce((s, c) => s + (c.memTotal || 0), 0);
  const disk = list.reduce((s, c) => s + (c.diskUsed || 0), 0);
  const diskMax = list.reduce((s, c) => s + (c.diskTotal || 0), 0);
  return (
    <>
      <PageHeader title={`Welcome, ${me.fullName || me.username}`} sub="Your private cloud at a glance" />
      <div className="kpis">
        <Stat label="Servers" icon="server" value={ov.data ? ov.data.servers.total : list.length} sub={`${list.filter((c) => c.status === 'Running').length} running`} />
        <Stat label="Memory in use" icon="memory" value={bytes(mem)} sub={memMax ? `of ${bytes(memMax)}` : ''}><Bar value={pct(mem, memMax)} /></Stat>
        <Stat label="Storage in use" icon="storage" value={bytes(disk)} sub={diskMax ? `of ${bytes(diskMax)}` : ''}><Bar value={pct(disk, diskMax)} /></Stat>
        <Stat label="Applications" icon="app" value={ov.data?.apps ?? null} sub={ov.data ? `${ov.data.domains} live domain(s)` : ''} />
      </div>
      <div className="grid2 grid2--wide-left">
        <Card title="My servers" pad={false}>
          {list.length ? list.map((c) => <ServerRow key={c.name} c={c} job={jobs[c.name]} />)
            : <Empty icon="server" title="No servers assigned yet">Ask the administrator to provision a server for you.</Empty>}
        </Card>
        <Card title="Alerts"><AlertList alerts={alerts} empty="Nothing needs your attention." /></Card>
      </div>
      <Card title="Quick actions">
        <div className="quick">
          <a className="quick__item" href={href('terminal')}><Icon name="terminal" /> Open a terminal</a>
          <a className="quick__item" href={href('apps')}><Icon name="app" /> Deploy an application</a>
          <a className="quick__item" href={href('ssh-keys')}><Icon name="key" /> Add an SSH key</a>
          <a className="quick__item" href={href('backups')}><Icon name="camera" /> Take a snapshot</a>
        </div>
      </Card>
    </>
  );
}

export default function Overview() {
  const { me } = useLive();
  return me.isAdmin ? <AdminOverview /> : <UserOverview />;
}
