// Security center: security check, firewall (UFW), fail2ban + panel login blocks, two-factor policy.
import { useState } from 'react';
import { api, ago, dateTime } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, Stat, Tabs, useApi, useAction, useConfirm, href } from '../ui.jsx';

const TONE = { ok: 'good', warn: 'warn', bad: 'bad', info: 'neutral' };
const LABEL = { ok: 'OK', warn: 'Check', bad: 'Fix', info: 'Info' };

function NotInstalled({ error }) {
  return (
    <Note tone="warn">
      {error}
      <pre className="logbox mono" style={{ marginTop: 8 }}>{'cd <panel folder>\nsudo bash system/install-security.sh --tools'}</pre>
      This installs ufw + fail2ban and one root helper the panel may run (nothing else). The firewall stays off until you turn it on here.
    </Note>
  );
}

function Check() {
  const { data, error, loading, reload } = useApi('/api/security/check');
  const checks = data?.checks || [];
  const count = (s) => checks.filter((c) => c.status === s).length;
  return (
    <>
      <div className="kpis">
        <Stat label="Need fixing" icon="alert" value={data ? count('bad') : null} tone={count('bad') ? 'bad' : ''} />
        <Stat label="Worth checking" icon="info" value={data ? count('warn') : null} tone={count('warn') ? 'warn' : ''} />
        <Stat label="OK" icon="check" value={data ? count('ok') : null} />
        <Stat label="Checked" icon="shield" value={data ? ago(data.at) : null} sub={<button type="button" className="btn btn--small" disabled={loading} onClick={reload}>{loading ? 'Checking…' : 'Check again'}</button>} />
      </div>
      {data?.error && <NotInstalled error={data.error} />}
      <ErrorNote error={error} onRetry={reload} />
      <Card pad={false} title="Security check" sub="The server (through the helper) and the panel's own settings">
        {!data ? <div className="pad"><SkeletonRows rows={6} /></div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Check</th><th>Result</th><th>Found</th><th>How to fix</th></tr></thead>
            <tbody>{[...checks].sort((a, b) => ['bad', 'warn', 'info', 'ok'].indexOf(a.status) - ['bad', 'warn', 'info', 'ok'].indexOf(b.status)).map((c) => (
              <tr key={c.id}>
                <td><strong>{c.title}</strong></td>
                <td><Badge tone={TONE[c.status]} dot>{LABEL[c.status]}</Badge></td>
                <td className="small">{c.detail}</td>
                <td className="small mono">{c.fix || '–'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {data?.listening?.length > 0 && (
        <Card pad={false} title="Listening ports" sub="Public = reachable from outside unless the firewall blocks it">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Port</th><th>Address</th><th>Program</th><th /></tr></thead>
            <tbody>{data.listening.map((p) => (
              <tr key={`${p.proto}${p.addr}${p.port}`}><td className="mono">{p.port}/{p.proto}</td><td className="mono">{p.addr}</td><td>{p.process || '–'}</td>
                <td>{p.public ? <Badge tone="warn">public</Badge> : <Badge>local</Badge>}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}

function Firewall({ status, reload, sup }) {
  const run = useAction();
  const confirm = useConfirm();
  const [f, setF] = useState({ action: 'allow', port: '', from: '', comment: '' });
  const ufw = status?.host?.ufw;
  const sshPorts = status?.host?.sshPorts || [22];
  if (status?.error) return <NotInstalled error={status.error} />;
  if (!status) return <SkeletonRows />;
  if (!ufw?.installed) return <NotInstalled error="ufw is not installed on this server." />;
  async function add(e) {
    e.preventDefault();
    if (await run(() => api('/api/security/firewall/rules', { method: 'POST', body: f }), `Rule added: ${f.action} ${f.port}`)) { setF({ ...f, port: '', from: '', comment: '' }); reload(); }
  }
  async function del(r) {
    if (await confirm({ title: `Delete rule ${r.num}?`, body: <code>{r.action} {r.to} from {r.from}</code>, danger: true, confirmLabel: 'Delete' })
      && await run(() => api(`/api/security/firewall/rules/${r.num}`, { method: 'DELETE' }), 'Rule deleted')) reload();
  }
  async function enable() {
    if (await confirm({
      title: 'Turn the firewall on?', confirmLabel: 'Turn on',
      body: <>First adds (if missing): <strong>SSH {sshPorts.join(', ')}/tcp with rate limit</strong>{status.host.bridges.length ? <> and the LXD bridge <code>{status.host.bridges.join(', ')}</code></> : null}. Then blocks all other incoming traffic. The panel, Cloudflare Tunnel and outgoing traffic keep working. Allow any other public ports you need first.</>,
    }) && await run(() => api('/api/security/firewall/enable', { method: 'POST' }), (r) => `Firewall on. ${r.done.join('; ')}`)) reload();
  }
  async function disable() {
    const typed = await confirm({ title: 'Turn the firewall off?', body: 'All ports become reachable again.', typed: 'disable', danger: true, confirmLabel: 'Turn off' });
    if (typed && await run(() => api('/api/security/firewall/disable', { method: 'POST', body: { confirm: typed } }), 'Firewall off')) reload();
  }
  return (
    <>
      <Card title="Firewall (UFW)" sub={ufw.active ? `On · incoming ${ufw.defaults.incoming}, outgoing ${ufw.defaults.outgoing}, routed ${ufw.defaults.routed}` : 'Off: every listening port is reachable'}
        actions={sup && (ufw.active ? <button type="button" className="btn btn--small btn--danger" onClick={disable}>Turn off</button> : <button type="button" className="btn btn--primary" onClick={enable}><Icon name="shield" /> Turn on</button>)}>
        <Badge tone={ufw.active ? 'good' : 'bad'} dot>{ufw.active ? 'Active' : 'Inactive'}</Badge>
        <span className="muted small"> SSH ({sshPorts.join(', ')}) can never be blocked here, so you cannot lock yourself out. Docker-published ports are not filtered by UFW (the panel only publishes on 127.0.0.1).</span>
      </Card>
      {sup && (
        <Card title="Add a rule">
          <form className="form" onSubmit={add}>
            <div className="fgrid">
              <Field label="Action"><select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="allow">Allow</option><option value="limit">Allow, rate limited</option><option value="deny">Deny</option></select></Field>
              <Field label="Port" hint="443, 443/tcp, 6000:6100/udp"><input required value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} placeholder="443/tcp" /></Field>
              <Field label="From" hint="Empty = anyone"><input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="203.0.113.0/24" /></Field>
              <Field label="Comment"><input maxLength={60} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} placeholder="web" /></Field>
            </div>
            <div><button type="submit" className="btn btn--primary">Add rule</button></div>
          </form>
        </Card>
      )}
      <Card pad={false} title="Rules" sub="Checked top to bottom; the first match wins">
        {!ufw.rules.length ? <Empty icon="shield" title={ufw.active ? 'No rules: everything incoming is blocked' : 'No rules yet'} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>#</th><th>To</th><th>Action</th><th>From</th><th>Comment</th><th /></tr></thead>
            <tbody>{ufw.rules.map((r) => (
              <tr key={r.num}><td>{r.num}</td><td className="mono">{r.to}</td><td><Badge tone={r.action === 'DENY' || r.action === 'REJECT' ? 'bad' : 'good'}>{r.action} {r.direction}</Badge></td>
                <td className="mono">{r.from}</td><td className="muted">{r.comment || ''}</td>
                <td>{sup && <button type="button" className="btn btn--small btn--danger" onClick={() => del(r)}>Delete</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

function Bans({ status, reload, sup }) {
  const run = useAction();
  const [ban, setBan] = useState({ jail: 'sshd', ip: '' });
  const f2b = status?.host?.fail2ban;
  const unban = async (jail, ip) => { if (await run(() => api('/api/security/fail2ban/unban', { method: 'POST', body: { jail, ip } }), `${ip} unbanned`)) reload(); };
  const clear = async (ip) => { if (await run(() => api(`/api/security/panel-logins/${encodeURIComponent(ip)}`, { method: 'DELETE' }), `${ip} may log in again`)) reload(); };
  return (
    <>
      <Card pad={false} title="Panel login blocks" sub="5 wrong passwords or codes in 15 minutes block an IP for 15 minutes">
        {!status ? <div className="pad"><SkeletonRows /></div> : !status.panelLogins.length ? <Empty icon="lock" title="No failed panel logins right now" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>IP</th><th>Failures</th><th>Last</th><th>State</th><th /></tr></thead>
            <tbody>{status.panelLogins.map((x) => (
              <tr key={x.ip}><td className="mono">{x.ip}</td><td>{x.failures}</td><td className="muted">{ago(x.last)}</td>
                <td>{x.blocked ? <Badge tone="bad">blocked {Math.ceil(x.retryAfter / 60)} min</Badge> : <Badge>watching</Badge>}</td>
                <td>{sup && <button type="button" className="btn btn--small" onClick={() => clear(x.ip)}>Clear</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {status?.error ? <NotInstalled error={status.error} /> : !f2b ? null : !f2b.installed ? <NotInstalled error="fail2ban is not installed on this server." /> : (
        <Card pad={false} title="Fail2ban" sub={f2b.running ? `${f2b.jails.length} jails` : 'Installed but not running: sudo systemctl enable --now fail2ban'}
          actions={sup && f2b.running && (
            <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/api/security/fail2ban/ban', { method: 'POST', body: ban }), `${ban.ip} banned`)) { setBan({ ...ban, ip: '' }); reload(); } }}>
              <select value={ban.jail} onChange={(e) => setBan({ ...ban, jail: e.target.value })}>{f2b.jails.map((j) => <option key={j.name}>{j.name}</option>)}</select>
              <input required placeholder="IP to ban" value={ban.ip} onChange={(e) => setBan({ ...ban, ip: e.target.value })} />
              <button type="submit" className="btn btn--small btn--danger">Ban</button>
            </form>
          )}>
          {f2b.jails.map((j) => (
            <div key={j.name} className="pad">
              <h3>{j.name} <Badge tone={j.banned ? 'bad' : 'good'}>{j.banned} banned</Badge> <span className="muted small">{j.failed} failing now · {j.totalBanned} bans · {j.totalFailed} failures in total</span></h3>
              {j.ips.length ? (
                <div className="row-actions">{j.ips.map((ip) => (
                  <span key={ip} className="mono small">{ip} {sup && <button type="button" className="btn btn--small" onClick={() => unban(j.name, ip)}>Unban</button>}</span>
                ))}</div>
              ) : <p className="muted small">Nobody banned.</p>}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

function TwoFactorPolicy({ sup }) {
  const run = useAction();
  const s = useApi('/api/settings');
  const mine = useApi('/api/me/2fa');
  const on = s.data?.settings?.require_2fa_admins === true;
  const toggle = async () => { if (await run(() => api('/api/settings/require-2fa', { method: 'PUT', body: { enabled: !on } }), on ? 'No longer required' : 'Two-factor login is now required for admins')) s.reload(); };
  return (
    <Card title="Two-factor login" sub="Codes from an authenticator app (Google Authenticator, Authy, 1Password…)">
      <p>Your account: {mine.data ? (mine.data.enabled ? <Badge tone="good">on</Badge> : <Badge tone="bad">off</Badge>) : '…'} <a href={href('security')}>Set it up on your Security page</a></p>
      <p>Required for all admins: <Badge tone={on ? 'good' : 'neutral'}>{on ? 'yes' : 'no'}</Badge></p>
      {sup && <button type="button" className="btn" onClick={toggle} disabled={!on && !mine.data?.enabled}>{on ? 'Stop requiring it' : 'Require it for admins'}</button>}
      {sup && !on && !mine.data?.enabled && <p className="muted small">Turn it on for your own account first.</p>}
      <p className="muted small">When required, an admin without it can only reach their Security page until they set it up. Lost phone: Users → the user → Reset two-factor (super admin).</p>
    </Card>
  );
}

export default function SecurityCenter({ tab = 'check' }) {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const status = useApi(tab === 'firewall' || tab === 'bans' ? '/api/security/status' : null, { interval: 15000 });
  const f2b = status.data?.host?.fail2ban;
  const ufw = status.data?.host?.ufw;
  return (
    <>
      <PageHeader title="Security center" sub="Firewall, brute-force protection, two-factor login and a security check for this server"
        actions={status.data && <span className="muted small">{ufw?.active ? 'Firewall on' : 'Firewall off'} · {f2b?.running ? `${f2b.jails.reduce((n, j) => n + j.banned, 0)} banned` : 'fail2ban off'}</span>} />
      <Tabs tabs={[['check', 'Security check'], ['firewall', 'Firewall'], ['bans', 'Bans & logins'], ['2fa', 'Two-factor']]} value={tab} hrefFor={(t) => `#/security-center/${t}`} />
      <ErrorNote error={status.error} onRetry={status.reload} />
      {tab === 'check' && <Check />}
      {tab === 'firewall' && <Firewall status={status.data} reload={status.reload} sup={sup} />}
      {tab === 'bans' && <Bans status={status.data} reload={status.reload} sup={sup} />}
      {tab === '2fa' && <TwoFactorPolicy sup={sup} />}
      <p className="muted small">Every change here is in the <a href={href('audit')}>audit log</a>. Updated {dateTime(Date.now())}.</p>
    </>
  );
}
