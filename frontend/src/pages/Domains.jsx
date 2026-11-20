import { useState } from 'react';
import { api, ago } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Note, Icon, Field, Copy, useApi, useAction, useConfirm } from '../ui.jsx';

const TONE = { active: 'good', pending: 'warn', manual: 'warn', error: 'bad', rejected: 'bad', unverified: 'warn', dns: 'warn' };
const STATUS_TEXT = { active: 'live', pending: 'waiting for approval', manual: 'route needed', error: 'error', rejected: 'rejected', unverified: 'add DNS records', dns: 'waiting for DNS' };

// The records the owner must add, with copy buttons
function DnsRecords({ d }) {
  if (!d.dns?.length || (d.status === 'active' && d.verified)) return null;
  return (
    <div className="dnsrec">
      {d.dns.map((r) => (
        <div key={`${r.type}-${r.name}`} className="dnsrec__row">
          <Badge>{r.type}</Badge> <code>{r.name}</code> → <code>{r.value}</code> <Copy text={r.value} />
          <small className="block muted">{r.why}</small>
        </div>
      ))}
    </div>
  );
}

function sslBadge(ssl) {
  if (!ssl?.status) return <span className="muted">not checked</span>;
  if (ssl.status === 'valid') return <Badge tone="good"><Icon name="lock" size={12} /> valid{ssl.expiresAt ? ` · until ${new Date(ssl.expiresAt).toLocaleDateString()}` : ''}</Badge>;
  return <Badge tone="bad" title={ssl.status}>{ssl.status.split(':')[0]}</Badge>;
}

export default function Domains() {
  const { me, cts } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/domains', { interval: 30000 });
  const apps = useApi('/api/apps');
  const tunnel = useApi(me.isAdmin ? '/api/domains-tunnel' : null);
  const servers = Object.values(cts).filter((c) => me.isAdmin || me.containers.includes(c.name)).map((c) => c.name).sort();
  const [f, setF] = useState({ hostname: '', container: '', appId: '', port: '' });
  // Every place the user has apps: their servers, the main server app host, their VPS
  const places = [...new Set([...servers.filter((n) => !/^apps-/.test(n) || me.isAdmin), ...(apps.data?.apps || []).map((a) => a.container)])];
  const placeLabel = (c) => { const a = (apps.data?.apps || []).find((x) => x.container === c); return a?.target === 'main' ? 'Main server' : a?.target === 'vps' ? `My VPS: ${a.serverName}` : c; };
  const container = f.container || places[0] || '';
  const appsHere = (apps.data?.apps || []).filter((a) => a.container === container);
  const onlyApps = /^vps-|^apps-/.test(container);

  async function add(e) {
    e.preventDefault();
    const appId = f.appId || (onlyApps ? appsHere[0]?.id : '');
    const body = { hostname: f.hostname, container, ...(appId ? { appId: Number(appId) } : { port: Number(f.port) }) };
    if (await run(() => api('/api/domains', { method: 'POST', body }), (r) => (r.domain.dns?.length ? 'Added. Now create the DNS records shown below, then press Verify.' : me.isAdmin ? 'Domain added' : 'Requested. An administrator will approve it.'))) {
      setF({ hostname: '', container: '', appId: '', port: '' });
      reload();
    }
  }
  const act = async (d, op, okText) => { if (await run(() => api(`/api/domains/${d.id}/${op}`, { method: 'POST' }), okText)) { reload(); tunnel.reload?.(); } };
  const remove = async (d) => {
    const typed = await confirm({ title: `Remove ${d.hostname}?`, typed: d.hostname, danger: true, confirmLabel: 'Remove', body: d.routeSynced ? 'The tunnel route and its DNS record are removed. The site stops being reachable.' : 'The domain is removed from Sampanna Cloud.' });
    if (typed && await run(() => api(`/api/domains/${d.id}`, { method: 'DELETE', body: { confirm: typed } }), `Removed ${d.hostname}`)) { reload(); tunnel.reload?.(); }
  };

  const cf = data?.cloudflare;
  return (
    <>
      <PageHeader title="Domains" sub="Public URLs for your apps, through the Cloudflare Tunnel. HTTPS is handled by Cloudflare." />
      {data && !cf?.configured && me.isAdmin && (
        <Note tone="warn">Cloudflare API is not configured, so approved domains need their route added by hand
          (Zero Trust → Tunnels → kapil-server → Public hostnames → hostname → the <b>target</b> shown below).
          Set <code>CF_API_TOKEN</code>, <code>CF_ACCOUNT_ID</code> and <code>CF_TUNNEL_ID</code> in <code>backend/.env</code> to automate it.</Note>
      )}
      <Card title="Add a domain" sub={`Subdomains of ${(data?.suffixes || []).join(', ') || 'your domain'} work out of the box. Other domains must be in the same Cloudflare account. ${me.isAdmin ? '' : 'Requests are approved by an administrator.'}`}>
        <form className="form" onSubmit={add}>
          <div className="fgrid">
            <Field label="Hostname"><input required value={f.hostname} onChange={(e) => setF({ ...f, hostname: e.target.value.toLowerCase().trim() })} placeholder={`app.${data?.suffixes?.[0] || 'example.com'}`} /></Field>
            <Field label="Where"><select value={container} onChange={(e) => setF({ ...f, container: e.target.value, appId: '' })}>{places.map((s) => <option key={s} value={s}>{placeLabel(s)}</option>)}</select></Field>
            <Field label="Application"><select value={f.appId} onChange={(e) => setF({ ...f, appId: e.target.value })}>
              {!onlyApps && <option value="">Custom port…</option>}
              {appsHere.map((a) => <option key={a.id} value={a.id}>{a.name} (port {a.port})</option>)}
            </select></Field>
            {!f.appId && !onlyApps && <Field label="Port inside the server"><input required type="number" min={1} max={65535} value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>}
          </div>
          <p className="muted small">Your own domain (not ending in {(data?.suffixes || []).join(' / ')}): you add a TXT record to prove it is yours. For an app on your VPS you also point an A record at that server.</p>
          <div><button type="submit" className="btn btn--primary" disabled={!places.length}><Icon name="plus" size={14} /> {me.isAdmin ? 'Add domain' : 'Request domain'}</button></div>
        </form>
      </Card>
      <ErrorNote error={error} onRetry={reload} />
      <Card title="Domains" pad={false}>
        {!data ? <div className="pad"><SkeletonRows /></div> : data.domains.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Hostname</th><th>Points to</th><th>Status</th><th>SSL</th>{me.isAdmin && <th>Owner</th>}<th className="num">Actions</th></tr></thead>
            <tbody>{data.domains.map((d) => (
              <tr key={d.id}>
                <td>{d.status === 'active' ? <a href={d.url} target="_blank" rel="noreferrer noopener">{d.hostname} <Icon name="external" size={12} /></a> : d.hostname}
                  {d.custom && <Badge tone={d.verified ? 'good' : 'warn'}>{d.verified ? 'verified' : 'not verified'}</Badge>}
                  {d.error && <small className="block bad-text">{d.error}</small>}
                  <DnsRecords d={d} /></td>
                <td className="muted">{d.container}{d.app ? ` / ${d.app}` : ''} :{d.port}{me.isAdmin && d.target ? <small className="block"><code>{d.target}</code></small> : null}</td>
                <td><Badge tone={TONE[d.status]} dot>{STATUS_TEXT[d.status] || d.status}</Badge></td>
                <td>{sslBadge(d.ssl)}{d.ssl?.checkedAt && <small className="block muted">checked {ago(d.ssl.checkedAt)}</small>}</td>
                {me.isAdmin && <td className="muted">{d.owner}</td>}
                <td className="num"><span className="row-actions">
                  {['unverified', 'dns'].includes(d.status) && <button type="button" className="btn btn--small btn--primary" onClick={async () => { const r = await run(() => api(`/api/domains/${d.id}/verify`, { method: 'POST' }), (x) => x.message); if (r) reload(); }}>Verify</button>}
                  {me.isAdmin && ['pending', 'error', 'rejected', 'manual'].includes(d.status) && <button type="button" className="btn btn--small btn--primary" onClick={() => act(d, 'approve', 'Approved')}>{d.status === 'pending' ? 'Approve' : 'Retry'}</button>}
                  {me.isAdmin && d.status === 'pending' && <button type="button" className="btn btn--small" onClick={() => act(d, 'reject', 'Rejected')}>Reject</button>}
                  {me.isAdmin && d.status === 'active' && <button type="button" className="btn btn--small" onClick={() => act(d, 'resync', 'Route updated')}>Resync</button>}
                  <button type="button" className="btn btn--small" onClick={() => act(d, 'check-ssl', 'SSL checked')}>Check SSL</button>
                  <button type="button" className="btn btn--small btn--danger" onClick={() => remove(d)} aria-label={`Remove ${d.hostname}`}><Icon name="trash" size={14} /></button>
                </span></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="globe" title="No domains yet">Add one above to give an app a public HTTPS address.</Empty>}
      </Card>
      {me.isAdmin && cf?.configured && (
        <Card title="Tunnel routes" sub={`Everything the Cloudflare Tunnel routes. Sampanna Cloud only changes rows marked managed. CNAME target: ${cf.tunnelTarget}`} pad={false}>
          {tunnel.error && <ErrorNote error={tunnel.error} />}
          {!tunnel.data ? <div className="pad"><SkeletonRows /></div> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Hostname</th><th>Service</th><th>Managed</th></tr></thead>
              <tbody>{tunnel.data.rules.map((r, i) => <tr key={`${r.hostname}-${i}`}><td>{r.hostname || <span className="muted">catch-all</span>}</td><td><code>{r.service}</code></td><td>{r.managed ? <Badge tone="info">Sampanna Cloud</Badge> : <span className="muted">no</span>}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      )}
      {!me.isAdmin && <Card title="Using your own domain">
        <ol className="steps">
          <li>The domain must be on Cloudflare (same account as the server). Ask the administrator if it is not.</li>
          <li>Request it above and pick the app it should open.</li>
          <li>After approval the DNS record and HTTPS certificate are created automatically. SSL status shows in the table.</li>
        </ol>
      </Card>}
    </>
  );
}
