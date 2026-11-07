import { useState } from 'react';
import { api, bytes, pct, ago, dateTime } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Bar, Empty, SkeletonRows, ErrorNote, Tabs, href, useApi, useAction } from '../ui.jsx';
import { HistoryChart } from './ServerDetail.jsx';
import { levelTone } from './Overview.jsx';
import App from '../App.jsx';

function Alerts() {
  const { me } = useLive();
  const run = useAction();
  const { data, error, reload } = useApi('/api/alerts?limit=200', { interval: 30000 });
  const list = data?.alerts || [];
  return (
    <Card pad={false} title="Alerts" sub="Raised when a threshold is crossed for several minutes, a server stops unexpectedly, a backup fails, a service goes down or a certificate has a problem.">
      <ErrorNote error={error} />
      {!data ? <div className="pad"><SkeletonRows /></div> : list.length ? (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Level</th><th>Alert</th><th>Started</th><th>State</th>{me.isAdmin && <th className="num" />}</tr></thead>
          <tbody>{list.map((a) => (
            <tr key={a.id}>
              <td><Badge tone={levelTone(a.level)} dot>{a.level}</Badge></td>
              <td>{a.message}<small className="block muted">{a.kind} · {a.target}</small></td>
              <td className="muted">{dateTime(a.created_at)}</td>
              <td>{a.resolved_at ? <span className="muted">resolved {ago(a.resolved_at)}</span> : a.acknowledged_by ? `acknowledged by ${a.acknowledged_by}` : <strong>open</strong>}</td>
              {me.isAdmin && <td className="num">{!a.resolved_at && !a.acknowledged_by && <button type="button" className="btn btn--small" onClick={async () => { if (await run(() => api(`/api/alerts/${a.id}/ack`, { method: 'POST' }))) reload(); }}>Acknowledge</button>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty icon="check" title="No alerts recorded" />}
    </Card>
  );
}

function Services() {
  const { data, error } = useApi('/api/services', { interval: 30000 });
  if (error) return <ErrorNote error={error} />;
  if (!data || !data.at) return <Card><SkeletonRows /></Card>;
  return (
    <div className="grid2">
      <Card title="System services" sub={`Checked ${ago(data.at)}. Set MONITOR_SERVICES in .env to change the list.`} pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Unit</th><th>State</th></tr></thead>
          <tbody>{data.units.map((u) => (
            <tr key={u.unit}><td><strong>{u.unit}</strong><small className="block muted">{u.description}</small></td>
              <td>{!u.installed ? <span className="muted">not installed</span> : <Badge tone={u.active === 'active' ? 'good' : u.active === 'failed' ? 'bad' : 'warn'} dot>{u.active} ({u.sub})</Badge>}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
      <Card title="PM2 on the master server" pad={false}>
        {data.pm2 == null ? <Empty icon="app" title="PM2 not reachable">The panel's user cannot run <code>pm2 jlist</code>.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Process</th><th>Status</th><th className="num">CPU</th><th className="num">Memory</th><th className="num">Restarts</th></tr></thead>
            <tbody>{data.pm2.map((p) => (
              <tr key={p.name}><td>{p.name}</td><td><Badge tone={p.status === 'online' ? 'good' : p.status === 'errored' ? 'bad' : 'warn'} dot>{p.status}</Badge></td>
                <td className="num">{p.cpu}%</td><td className="num">{bytes(p.memory)}</td><td className="num">{p.restarts}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

function Consumption() {
  const { cts } = useLive();
  const list = Object.values(cts).sort((a, b) => (b.memUsed || 0) - (a.memUsed || 0));
  return (
    <Card title="Container resource consumption" sub="Live, sorted by memory" pad={false}>
      {list.length ? <div className="table-wrap"><table className="table">
        <thead><tr><th>Server</th><th>Owner</th><th>CPU</th><th>Memory</th><th>Disk</th><th className="num">Network</th></tr></thead>
        <tbody>{list.map((c) => (
          <tr key={c.name}>
            <td><a href={href(`servers/${c.name}`)}><strong>{c.name}</strong></a><small className="block muted">{c.status}</small></td>
            <td className="muted">{(c.owners || []).join(', ') || '–'}</td>
            <td className="cell-bar"><Bar value={c.cpu} /><span>{c.cpu}% of {c.cores}</span></td>
            <td className="cell-bar"><Bar value={pct(c.memUsed, c.memTotal)} /><span>{bytes(c.memUsed)} / {bytes(c.memTotal)}</span></td>
            <td className="cell-bar"><Bar value={pct(c.diskUsed, c.diskTotal)} /><span>{bytes(c.diskUsed)}{c.diskTotal ? ` / ${bytes(c.diskTotal)}` : ''}</span></td>
            <td className="num muted">↓{bytes(c.rx)}/s ↑{bytes(c.tx)}/s</td>
          </tr>
        ))}</tbody>
      </table></div> : <Empty icon="server" title="No servers" />}
    </Card>
  );
}

function History() {
  const { me, cts } = useLive();
  const scopes = [...(me.isAdmin ? [['host', 'Master server']] : []), ...Object.keys(cts).sort().filter((n) => me.isAdmin || me.containers.includes(n)).map((n) => [`ct:${n}`, n])];
  const [scope, setScope] = useState(scopes[0]?.[0]);
  if (!scope) return <Card><Empty icon="chart" title="Nothing to show yet" /></Card>;
  return (
    <>
      <div className="filters">
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="What to show">{scopes.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
      </div>
      <div className="grid2">
        <Card title="CPU and memory"><HistoryChart key={`${scope}-c`} scope={scope} /></Card>
        <Card title="Network"><HistoryChart key={`${scope}-n`} scope={scope} kind="net" /></Card>
      </div>
    </>
  );
}

export default function Monitoring() {
  const { me, socket, status } = useLive();
  const tabs = me.isAdmin
    ? [['live', 'Live host'], ['history', 'History'], ['containers', 'Containers'], ['services', 'Services'], ['alerts', 'Alerts']]
    : [['history', 'History'], ['alerts', 'Alerts']];
  const [tab, setTab] = useState(tabs[0][0]);
  return (
    <>
      <PageHeader title="Monitoring" sub={me.isAdmin ? 'Live and historical metrics for the master server and every container' : 'Metrics for your servers'} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'live' && <div className="embed"><App socket={socket} status={status} /></div>}
      {tab === 'history' && <History />}
      {tab === 'containers' && <Consumption />}
      {tab === 'services' && <Services />}
      {tab === 'alerts' && <Alerts />}
    </>
  );
}
