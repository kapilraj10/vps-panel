// User-dashboard pages: Storage, Backups (snapshots + off-disk backups), Network.
import { bytes, pct, dateTime, ago } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Bar, Empty, SkeletonRows, ErrorNote, Note, Icon, Copy, href, useApi } from '../ui.jsx';
import { HistoryChart } from './ServerDetail.jsx';

const mine = (me, cts) => Object.values(cts).filter((c) => me.containers.includes(c.name)).sort((a, b) => a.name.localeCompare(b.name));

export function Storage() {
  const { me, cts } = useLive();
  const list = mine(me, cts);
  return (
    <>
      <PageHeader title="Storage" sub="Disk space on your servers" />
      {list.length ? <div className="cards">{list.map((c) => (
        <Card key={c.name} title={c.name} sub={c.diskTotal ? `${bytes(c.diskTotal)} disk` : 'No disk quota set'}>
          <div className="big-num">{bytes(c.diskUsed)} <small>used{c.diskTotal ? ` · ${bytes(c.diskTotal - c.diskUsed)} free` : ''}</small></div>
          <Bar value={pct(c.diskUsed, c.diskTotal)} />
          {c.diskTotal && pct(c.diskUsed, c.diskTotal) > 85 && <Note tone="warn">Almost full. Clean up (<code>du -sh /* | sort -h</code> in the terminal) or ask the admin for more space.</Note>}
          <div className="btn-row mt12">
            <a className="btn btn--small" href={href(`servers/${c.name}/snapshots`)}><Icon name="camera" size={14} /> Snapshots</a>
            <a className="btn btn--small" href={href(`terminal/${c.name}`)}><Icon name="terminal" size={14} /> Terminal</a>
          </div>
        </Card>
      ))}</div> : <Card><Empty icon="storage" title="No servers yet" /></Card>}
    </>
  );
}

export function MyBackups() {
  const { me, cts } = useLive();
  const runs = useApi('/api/my-backups');
  const list = mine(me, cts);
  return (
    <>
      <PageHeader title="Backups" sub="Snapshots you control, plus the nightly off-disk backups the administrator runs" />
      <Card title="Snapshots" sub="Instant restore points on the same disk. Take one before upgrades; restore it yourself any time.">
        {list.length ? <ul className="plain">{list.map((c) => (
          <li key={c.name} className="li-row"><Icon name="server" size={14} /> <strong>{c.name}</strong>
            <a className="btn btn--small" href={href(`servers/${c.name}/snapshots`)}>Manage snapshots</a></li>
        ))}</ul> : <Empty icon="camera" title="No servers yet" />}
      </Card>
      <Card title="Off-disk backups" sub="Full copies of your servers on the backup disk. Ask the administrator to restore one; it is restored as a new server so nothing is overwritten." pad={false}>
        {runs.error && <ErrorNote error={runs.error} />}
        {!runs.data ? <div className="pad"><SkeletonRows /></div> : runs.data.error ? <div className="pad"><Note tone="warn">Backups are not available right now: {runs.data.error}</Note></div>
          : runs.data.runs.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Backup</th><th>Servers</th><th>Kind</th><th>Verified</th></tr></thead>
              <tbody>{runs.data.runs.map((r) => (
                <tr key={r.id}><td>{dateTime(r.startedAt)}<small className="block muted">{r.id}</small></td><td>{r.containers.join(', ')}</td><td className="muted">{r.trigger}</td>
                  <td>{r.verify ? <Badge tone={r.verify.ok ? 'good' : 'bad'}>{r.verify.ok ? `checked ${ago(r.verify.at)}` : 'problem found'}</Badge> : <span className="muted">not yet</span>}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <Empty icon="backup" title="No backups of your servers yet" />}
      </Card>
    </>
  );
}

export function MyNetwork() {
  const { me, cts } = useLive();
  const domains = useApi('/api/domains');
  const list = mine(me, cts);
  return (
    <>
      <PageHeader title="Network" sub="Addresses, traffic and public URLs of your servers" />
      <Card title="Servers" pad={false}>
        {list.length ? <div className="table-wrap"><table className="table">
          <thead><tr><th>Server</th><th>Private IP</th><th>SSH</th><th>Traffic now</th><th>Since boot</th><th>Limits</th></tr></thead>
          <tbody>{list.map((c) => (
            <tr key={c.name}><td><strong>{c.name}</strong></td><td>{c.ip || '–'}</td><td><code>{c.ssh}</code> <Copy text={`ssh root@${c.ssh}`} /></td>
              <td className="muted">↓{bytes(c.rx)}/s ↑{bytes(c.tx)}/s</td><td className="muted">↓{bytes(c.rxTotal)} ↑{bytes(c.txTotal)}</td>
              <td className="muted">{c.limits?.ingress || c.limits?.egress ? `↓${c.limits.ingress || '∞'} ↑${c.limits.egress || '∞'}` : 'none'}</td></tr>
          ))}</tbody>
        </table></div> : <Empty icon="network" title="No servers yet" />}
      </Card>
      <Card title="Public URLs" actions={<a className="btn btn--small" href={href('domains')}>Manage domains</a>}>
        {!domains.data ? <SkeletonRows /> : domains.data.domains.length ? <ul className="plain">{domains.data.domains.map((d) => (
          <li key={d.id}>{d.status === 'active' ? <a href={d.url} target="_blank" rel="noreferrer noopener">{d.url}</a> : d.hostname} <Badge tone={d.status === 'active' ? 'good' : 'warn'}>{d.status}</Badge> <span className="muted">→ {d.container}:{d.port}</span></li>
        ))}</ul> : <Empty icon="globe" title="No public URLs yet" />}
      </Card>
      {list[0] && <Card title={`Traffic history: ${list[0].name}`}><HistoryChart scope={`ct:${list[0].name}`} kind="net" /></Card>}
      <p className="muted small">Your servers are on a private network behind the master server; only domains you add are reachable from the internet.</p>
    </>
  );
}
