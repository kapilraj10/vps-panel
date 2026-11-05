// Network Diagnostics: tests run ON the selected VPS by its agent (ping, traceroute, DNS, TCP, HTTP, internet speed),
// the server-to-server latency matrix, and the list of authorized external targets.
import { useEffect, useState } from 'react';
import { api, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Tabs, TimeChart, useApi, useAction, useConfirm } from '../ui.jsx';
import { useNodes } from './Fleet.jsx';

const KINDS = [['ping', 'Ping'], ['traceroute', 'Traceroute'], ['dns', 'DNS lookup'], ['tcp', 'TCP port'], ['http', 'HTTP(S)'], ['speedtest', 'Internet speed']];

function Summary({ t }) {
  const r = t.result;
  if (t.status === 'running') return <Badge tone="warn" dot>running…</Badge>;
  if (t.status === 'failed') return <span className="is-bad small">{t.error}</span>;
  if (!r) return null;
  switch (t.kind) {
    case 'ping': case 'matrix':
      return r.received ? <span>avg <strong>{r.avg} ms</strong> · min {r.min} · max {r.max} · jitter {r.jitter} · loss <strong className={r.loss ? 'is-bad' : ''}>{r.loss}%</strong> ({r.received}/{r.sent})</span> : <span className="is-bad">no reply ({r.error})</span>;
    case 'tcp': return r.open ? <span><Badge tone="good">open</Badge> connect {r.ms} ms{r.banner ? <> · <code>{r.banner}</code></> : ''}</span> : <span><Badge tone="bad">closed</Badge> {r.error}</span>;
    case 'http': return r.status ? <span><Badge tone={r.ok ? 'good' : 'bad'}>HTTP {r.status}</Badge> first byte {r.ms} ms · total {r.totalMs} ms{r.server ? ` · ${r.server}` : ''}{r.location ? ` → ${r.location}` : ''}</span> : <span className="is-bad">{r.error}</span>;
    case 'dns': return r.error ? <span className="is-bad">{r.error} ({r.ms} ms)</span> : <span>{r.ms} ms · <code>{r.records.map((x) => (typeof x === 'string' ? x : Array.isArray(x) ? x.join('') : x.exchange ? `${x.priority} ${x.exchange}` : JSON.stringify(x))).join(', ')}</code></span>;
    case 'traceroute': return <span>{r.hops.length} hops via {r.tool}{r.hops.filter((h) => h.timeout).length ? ` · ${r.hops.filter((h) => h.timeout).length} timeouts` : ''}</span>;
    case 'speedtest': return <span>↓ <strong>{r.download} Mbit/s</strong> · ↑ <strong>{r.upload} Mbit/s</strong> · latency {r.latency} ms · jitter {r.jitter} ms · loss {r.packetLoss ?? '–'}% · {r.server}{r.location ? ` (${r.location})` : ''}</span>;
    default: return null;
  }
}

function Detail({ t, onClose }) {
  return (
    <Dialog open title={`${t.kind} from ${t.source_name}`} onClose={onClose} wide>
      <p><Summary t={t} /></p>
      {t.kind === 'traceroute' && t.result && (
        <table className="table table--compact"><thead><tr><th>Hop</th><th>Address</th><th>Latency</th></tr></thead>
          <tbody>{t.result.hops.map((h) => <tr key={h.hop}><td>{h.hop}</td><td className="mono">{h.ip || '*'}</td><td>{h.timeout ? <Badge tone="warn">timeout</Badge> : `${h.ms} ms`}</td></tr>)}</tbody></table>
      )}
      <pre className="logbox mono">{JSON.stringify({ target: t.target, params: t.params, result: t.result, error: t.error }, null, 2)}</pre>
      <div className="dialog__buttons"><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function Tools({ nodes }) {
  const { socket } = useLive();
  const run = useAction();
  const targets = useApi('/api/net-targets');
  const hist = useApi('/api/nettests?limit=60', { interval: 15000 });
  const online = nodes.filter((n) => n.agentConnected);
  const [f, setF] = useState({ kind: 'ping', sourceId: '', targetNodeId: '', target: '', count: 10, port: 22, url: 'https://', name: '', type: 'A', ipv6: false, maxHops: 20 });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  useEffect(() => { if (!f.sourceId && online[0]) setF((x) => ({ ...x, sourceId: String(online[0].id) })); }, [online.length]);
  useEffect(() => { const on = () => hist.reload(); socket.on('nettest', on); return () => socket.off('nettest', on); }, [socket, hist.reload]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const needsTarget = ['ping', 'traceroute', 'tcp'].includes(f.kind);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const body = { kind: f.kind, sourceId: Number(f.sourceId) };
    if (needsTarget) { if (f.targetNodeId) body.targetNodeId = Number(f.targetNodeId); else body.target = f.target; }
    if (f.kind === 'ping') Object.assign(body, { count: Number(f.count), ipv6: f.ipv6 });
    if (f.kind === 'traceroute') body.maxHops = Number(f.maxHops);
    if (f.kind === 'tcp') body.port = Number(f.port);
    if (f.kind === 'http') body.url = f.url;
    if (f.kind === 'dns') Object.assign(body, { name: f.name, type: f.type });
    const r = await run(() => api('/api/nettests', { method: 'POST', body }), (x) => (x.test.status === 'running' ? 'Started; the result appears below' : null));
    if (r) hist.reload();
    setBusy(false);
  }
  return (
    <>
      <Card title="Run a test" sub="Runs on the chosen server itself (its agent), not in your browser">
        {!online.length ? <Note tone="warn">No server has a connected agent, so nothing can run tests. Install the agent on a server first (VPS Fleet → server → Agent).</Note> : (
          <form className="form" onSubmit={submit}>
            <div className="fgrid">
              <Field label="Test"><select value={f.kind} onChange={set('kind')}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Run from"><select value={f.sourceId} onChange={set('sourceId')}>{online.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
              {needsTarget && <>
                <Field label="Target server"><select value={f.targetNodeId} onChange={set('targetNodeId')}><option value="">Other host (authorized)…</option>{nodes.filter((n) => String(n.id) !== f.sourceId).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
                {!f.targetNodeId && <Field label="Host / IP" hint="Must be in Authorized targets"><input required list="net-targets" value={f.target} onChange={set('target')} /><datalist id="net-targets">{(targets.data?.targets || []).map((t) => <option key={t.id} value={t.host} />)}</datalist></Field>}
              </>}
              {f.kind === 'ping' && <><Field label="Packets"><input type="number" min={1} max={50} value={f.count} onChange={set('count')} /></Field><label className="check"><input type="checkbox" checked={f.ipv6} onChange={set('ipv6')} /> IPv6</label></>}
              {f.kind === 'traceroute' && <Field label="Max hops"><input type="number" min={1} max={40} value={f.maxHops} onChange={set('maxHops')} /></Field>}
              {f.kind === 'tcp' && <Field label="Port" hint="22 SSH · 80/443 web · 5432 Postgres · 3306 MySQL"><input type="number" min={1} max={65535} value={f.port} onChange={set('port')} /></Field>}
              {f.kind === 'http' && <Field label="URL" hint="Host must be a server or authorized target" wide><input required value={f.url} onChange={set('url')} /></Field>}
              {f.kind === 'dns' && <><Field label="Name"><input required value={f.name} onChange={set('name')} placeholder="gyannportal.com" /></Field>
                <Field label="Record"><select value={f.type} onChange={set('type')}>{['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'].map((x) => <option key={x}>{x}</option>)}</select></Field></>}
            </div>
            {f.kind === 'speedtest' && <p className="muted small">Measures the server's own internet connection against Cloudflare's speed test service (about 20 s, transfers up to a few hundred MB).</p>}
            <div className="dialog__buttons"><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Running…' : 'Run test'}</button></div>
          </form>
        )}
      </Card>
      <Card pad={false} title="Results">
        {!hist.data ? <div className="pad"><SkeletonRows /></div> : !hist.data.tests.length ? <div className="pad muted">No tests yet.</div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Test</th><th>From</th><th>To</th><th>Result</th><th /></tr></thead>
            <tbody>{hist.data.tests.map((t) => (
              <tr key={t.id}><td className="small" title={dateTime(t.started_at)}>{ago(t.started_at)}</td><td>{t.kind}</td><td>{t.source_name}</td>
                <td className="mono small">{t.target_name ? `${t.target_name} (${t.target})` : t.target}</td><td className="small"><Summary t={t} /></td>
                <td><button type="button" className="btn btn--small" onClick={() => setOpen(t)}>Details</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {open && <Detail t={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Matrix() {
  const { me, socket } = useLive();
  const run = useAction();
  const { data, error, reload } = useApi('/api/net-matrix', { interval: 30000 });
  const [pair, setPair] = useState(null);
  const hist = useApi(pair ? `/api/net-matrix/history?source=${pair[0].id}&target=${pair[1].id}&hours=24` : null);
  useEffect(() => { const on = () => reload(); socket.on('netmatrix', on); return () => socket.off('netmatrix', on); }, [socket, reload]);
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return <SkeletonRows />;
  const cell = (s, d) => data.latest.find((t) => t.source_id === s.id && t.target_id === d.id);
  const stat = (s, d) => data.stats.find((t) => t.source_id === s.id && t.target_id === d.id);
  const tone = (t) => (!t ? '' : t.status === 'failed' || t.loss >= 100 ? 'bad' : t.loss > 0 || t.latency > 100 ? 'warn' : 'good');
  return (
    <>
      <Card title="Server-to-server latency" sub={`Each row pings each column with 5 packets. Automatic every ${data.everyMinutes || '–'} minutes${data.everyMinutes ? '' : ' (off; set in Settings)'}. Click a cell for its 24 h history.`}
        actions={me.role === 'super_admin' && <button type="button" className="btn btn--primary" disabled={data.running} onClick={() => run(() => api('/api/net-matrix/run', { method: 'POST' }), 'Matrix started').then(reload)}><Icon name="refresh" /> {data.running ? 'Running…' : 'Run now'}</button>}>
        {data.nodes.length < 2 ? <Empty icon="network" title="Needs at least two servers" /> : (
          <div className="table-wrap"><table className="table matrix">
            <thead><tr><th>From \ To</th>{data.nodes.map((d) => <th key={d.id}>{d.name}</th>)}</tr></thead>
            <tbody>{data.nodes.map((s) => (
              <tr key={s.id}><th>{s.name}{!s.connected && <><br /><small className="muted">agent offline</small></>}</th>
                {data.nodes.map((d) => {
                  if (s.id === d.id) return <td key={d.id} className="matrix__self">–</td>;
                  const t = cell(s, d);
                  const st = stat(s, d);
                  return (
                    <td key={d.id} className={`matrix__cell matrix__cell--${tone(t)}`} onClick={() => setPair([s, d])} title={t ? `last ${dateTime(t.started_at)}` : 'not measured'}>
                      {!t ? <span className="muted">–</span> : t.status === 'failed' || t.loss >= 100 ? <strong>unreachable</strong> : <><strong>{t.latency} ms</strong><br /><small>{t.loss}% loss{st ? ` · 24h avg ${st.avg} ms` : ''}</small></>}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {pair && (
        <Card title={`${pair[0].name} → ${pair[1].name}`} sub="Last 24 hours" actions={<button type="button" className="btn btn--small" onClick={() => setPair(null)}>Close</button>}>
          <TimeChart data={(hist.data?.points || []).map((p) => ({ t: p.t, latency: p.latency, loss: p.loss }))} series={[{ key: 'latency', name: 'latency ms', color: 's1' }, { key: 'loss', name: 'loss %', color: 'alarm' }]} height={200} />
        </Card>
      )}
    </>
  );
}

function Targets() {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const run = useAction();
  const confirm = useConfirm();
  const { data, reload } = useApi('/api/net-targets');
  const [f, setF] = useState({ host: '', note: '' });
  return (
    <Card title="Authorized targets" sub="Ping / traceroute / TCP / HTTP tests may only target registered servers or these hosts">
      {sup && <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/api/net-targets', { method: 'POST', body: f }), `${f.host} authorized`)) { setF({ host: '', note: '' }); reload(); } }}>
        <input required value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="1.1.1.1 or db.example.com" />
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="why (optional)" />
        <button type="submit" className="btn btn--primary">Authorize</button>
      </form>}
      {!data ? <SkeletonRows /> : !data.targets.length ? <p className="muted">None yet. Registered servers are always allowed.</p> : (
        <table className="table table--compact"><tbody>{data.targets.map((t) => (
          <tr key={t.id}><td className="mono">{t.host}</td><td className="muted">{t.note}</td><td className="small">{t.created_by} · {ago(t.created_at)}</td>
            <td>{sup && <button type="button" className="btn btn--small btn--danger" onClick={async () => { if (await confirm({ title: `Remove ${t.host}?`, danger: true, confirmLabel: 'Remove' })) run(() => api(`/api/net-targets/${t.id}`, { method: 'DELETE' })).then(reload); }}>Remove</button>}</td></tr>
        ))}</tbody></table>
      )}
    </Card>
  );
}

export default function NetDiag() {
  const { nodes } = useNodes();
  const [tab, setTab] = useState('tools');
  return (
    <>
      <PageHeader title="Network Diagnostics" sub="Ping, traceroute, DNS, port and speed tests from your servers, and the latency between them" />
      <Tabs tabs={[['tools', 'Tests'], ['matrix', 'Server matrix'], ['targets', 'Authorized targets']]} value={tab} onChange={setTab} />
      {tab === 'tools' && <Tools nodes={nodes} />}
      {tab === 'matrix' && <Matrix />}
      {tab === 'targets' && <Targets />}
    </>
  );
}
