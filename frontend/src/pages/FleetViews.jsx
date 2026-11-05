// Uptime & availability, and the server comparison page.
import { useMemo, useState } from 'react';
import { bytes, ago, pct } from '../lib.jsx';
import { PageHeader, Card, Badge, Empty, SkeletonRows, Stat, TimeChart, Bar, href, useApi } from '../ui.jsx';
import { useNodes, NodeStatus, IncidentTable } from './Fleet.jsx';

const upPct = (v) => (v == null ? '–' : `${v.toFixed(v >= 99.9 ? 3 : 2)}%`);
const upTone = (v) => (v == null ? 'neutral' : v >= 99.9 ? 'good' : v >= 99 ? 'warn' : 'bad');

export function Uptime() {
  const { nodes, data } = useNodes();
  const inc = useApi('/api/fleet/incidents', { interval: 30000 });
  const open = (inc.data?.incidents || []).filter((i) => !i.ended_at);
  const avg = (k) => { const v = nodes.map((n) => n[k]).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  return (
    <>
      <PageHeader title="Uptime & Availability" sub="From real heartbeats and SSH reachability checks. Maintenance time and agent-only outages do not count as downtime." />
      <div className="kpis">
        <Stat label="Online now" icon="check" value={data ? `${nodes.filter((n) => ['online', 'degraded'].includes(n.status)).length} / ${nodes.length}` : null} tone={open.some((i) => i.kind !== 'agent_disconnected') ? 'bad' : ''} />
        <Stat label="Open incidents" icon="alert" value={inc.data ? open.length : null} tone={open.length ? 'bad' : ''} />
        <Stat label="Fleet uptime 7 d" icon="activity" value={data ? upPct(avg('uptime7d')) : null} sub="average of servers" />
        <Stat label="Fleet uptime 30 d" icon="activity" value={data ? upPct(avg('uptime30d')) : null} />
      </div>
      {!data ? <SkeletonRows /> : !nodes.length ? <Empty icon="server" title="No servers registered" /> : (
        <Card pad={false} title="Servers">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Server</th><th>Status</th><th>Since</th><th>24 h</th><th>7 days</th><th>30 days</th><th>Last heartbeat</th><th>Monitored since</th></tr></thead>
            <tbody>{nodes.map((n) => (
              <tr key={n.id}><td><a href={href(`fleet/${n.id}/incidents`)}><strong>{n.name}</strong></a><br /><small className="muted">{n.location || ''}</small></td>
                <td><NodeStatus s={n.status} /></td><td className="small">{n.status_since ? ago(n.status_since) : '–'}</td>
                {['uptime24h', 'uptime7d', 'uptime30d'].map((k) => <td key={k}><Badge tone={upTone(n[k])}>{upPct(n[k])}</Badge></td>)}
                <td className="small">{n.last_heartbeat_at ? ago(n.last_heartbeat_at) : n.hasAgent ? 'never' : 'no agent'}</td>
                <td className="small">{n.first_seen_at ? ago(n.first_seen_at) : 'not yet'}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
      <h2 className="section-title">Incident history</h2>
      {!inc.data ? <SkeletonRows /> : !inc.data.incidents.length ? <Empty icon="check" title="No incidents recorded" /> : <IncidentTable rows={inc.data.incidents} showNode />}
    </>
  );
}

// ---------- comparison ----------
const PALETTE = ['s1', 's2', 's3', 'good', 'warn', 'alarm'];
// Health score 0-100 from live load (lower usage, fewer incidents = higher). Shown with its inputs, not as a magic number.
function score(n) {
  const l = n.live;
  if (!l || !['online', 'degraded'].includes(n.status)) return null;
  const cpu = l.cpu ?? 0;
  const mem = l.memTotal ? (l.memUsed / l.memTotal) * 100 : 0;
  const disk = l.diskMaxPct ?? 0;
  const up = n.uptime7d ?? 100;
  return Math.max(0, Math.round(100 - cpu * 0.3 - mem * 0.3 - Math.max(0, disk - 50) * 0.4 - (100 - up) * 10));
}

export function Compare() {
  const { nodes, data } = useNodes();
  const [sel, setSel] = useState(null);
  const [range, setRange] = useState('24h');
  const ids = sel || nodes.map((n) => n.id);
  const hist = useApi(ids.length ? `/api/fleet/compare?ids=${ids.join(',')}&range=${range}` : null, { interval: 60000, deps: [range] });
  const matrix = useApi('/api/net-matrix');
  const chosen = nodes.filter((n) => ids.includes(n.id));
  const toggle = (id) => setSel((s) => { const cur = s || nodes.map((n) => n.id); return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; });
  // merge histories on a shared time grid
  const merged = useMemo(() => {
    const rows = new Map();
    for (const n of hist.data?.nodes || []) {
      for (const p of n.history) {
        const t = Math.round(p.ts / 60_000) * 60_000;
        const r = rows.get(t) || { t };
        r[`cpu${n.id}`] = p.cpu;
        r[`mem${n.id}`] = p.mem_total ? pct(p.mem_used, p.mem_total) : null;
        r[`net${n.id}`] = Math.round(((p.rx + p.tx) * 8) / 1e4) / 100;
        rows.set(t, r);
      }
    }
    return [...rows.values()].sort((a, b) => a.t - b.t);
  }, [hist.data]);
  const series = (k) => chosen.map((n, i) => ({ key: `${k}${n.id}`, name: n.name, color: PALETTE[i % PALETTE.length] }));
  const ping = (n) => {
    const rows = (matrix.data?.stats || []).filter((s) => s.target_id === n.id);
    const ok = rows.filter((r) => r.avg != null);
    if (!rows.length) return null;
    return { avg: ok.length ? Math.round((ok.reduce((s, r) => s + r.avg, 0) / ok.length) * 10) / 10 : null, loss: Math.max(...rows.map((r) => r.loss ?? 100)) };
  };
  const ranked = [...chosen].map((n) => ({ n, s: score(n) })).sort((a, b) => (b.s ?? -1) - (a.s ?? -1));
  const long = ['7d', '30d'].includes(range);
  const tick = (t) => (long ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <>
      <PageHeader title="Server Comparison" sub="Measured values side by side" />
      {!data ? <SkeletonRows /> : nodes.length < 1 ? <Empty icon="server" title="No servers registered" /> : <>
        <div className="filters">
          {nodes.map((n) => <label key={n.id} className="check chip-check"><input type="checkbox" checked={ids.includes(n.id)} onChange={() => toggle(n.id)} /> {n.name}</label>)}
          <select className="filter" value={range} onChange={(e) => setRange(e.target.value)}>{['1h', '6h', '24h', '7d', '30d'].map((r) => <option key={r} value={r}>{r}</option>)}</select>
        </div>
        <Card pad={false} title="Now">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Rank</th><th>Server</th><th>Status</th><th>Cores</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Network now</th><th>Ping (to it)</th><th>Uptime 30 d</th><th>PM2</th><th>Containers</th><th>Health</th></tr></thead>
            <tbody>{ranked.map(({ n, s }, i) => {
              const l = n.live;
              const p = ping(n);
              return (
                <tr key={n.id}><td>{s == null ? '–' : `#${i + 1}`}</td><td><a href={href(`fleet/${n.id}`)}><strong>{n.name}</strong></a><br /><small className="muted">{n.location}</small></td>
                  <td><NodeStatus s={n.status} /></td><td>{l?.cores ?? n.cores ?? '–'}</td>
                  <td>{l?.cpu != null ? <>{l.cpu}%<Bar value={l.cpu} /></> : '–'}</td>
                  <td>{l?.memTotal ? <>{bytes(l.memUsed)} / {bytes(l.memTotal)}<Bar value={pct(l.memUsed, l.memTotal)} /></> : '–'}</td>
                  <td>{l?.diskTotal ? <>{bytes(l.diskUsed)} / {bytes(l.diskTotal)}<Bar value={pct(l.diskUsed, l.diskTotal)} /></> : '–'}</td>
                  <td className="small">{l ? `↓ ${((l.rx * 8) / 1e6).toFixed(2)} ↑ ${((l.tx * 8) / 1e6).toFixed(2)} Mbit/s` : '–'}</td>
                  <td className="small">{!p ? '–' : p.avg == null ? <span className="is-bad">unreachable</span> : `${p.avg} ms · ${p.loss}% loss`}</td>
                  <td>{upPct(n.uptime30d)}</td>
                  <td>{l?.pm2 ? `${l.pm2.online}/${l.pm2.total}` : '–'}</td><td>{l?.docker ? `${l.docker.running}/${l.docker.total}` : '–'}</td>
                  <td>{s == null ? '–' : <Badge tone={s >= 70 ? 'good' : s >= 40 ? 'warn' : 'bad'}>{s}</Badge>}</td></tr>
              );
            })}</tbody>
          </table></div>
          <p className="pad muted small">Health = 100 − 0.3×CPU% − 0.3×RAM% − 0.4×(disk% above 50) − 10×(downtime % over 7 days). Ping is the average from the other servers (server matrix, last 24 h).</p>
        </Card>
        <div className="grid2">
          <Card title="CPU %"><TimeChart data={merged} series={series('cpu')} unit="%" domain={[0, 100]} tickTime={tick} height={220} /></Card>
          <Card title="RAM %"><TimeChart data={merged} series={series('mem')} unit="%" domain={[0, 100]} tickTime={tick} height={220} /></Card>
          <Card title="Network (Mbit/s, in + out)"><TimeChart data={merged} series={series('net')} unit=" Mbit/s" tickTime={tick} height={220} /></Card>
        </div>
      </>}
    </>
  );
}
