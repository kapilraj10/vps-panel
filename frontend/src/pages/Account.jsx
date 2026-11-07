import { useState } from 'react';
import { api, ago, dateTime } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Note, useApi, useAction, useConfirm } from '../ui.jsx';

export default function Account() {
  const { me } = useLive();
  const run = useAction();
  const [p, setP] = useState({ fullName: me.fullName || '', email: me.email || '' });
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });
  const [msg, setMsg] = useState(null);
  async function saveProfile(e) {
    e.preventDefault();
    await run(() => api('/api/me/profile', { method: 'PUT', body: p }), 'Profile saved');
  }
  async function changePw(e) {
    e.preventDefault();
    if (pw.next !== pw.repeat) return setMsg('New passwords do not match');
    setMsg(null);
    if (await run(() => api('/api/password', { method: 'POST', body: { current: pw.current, next: pw.next } }), 'Password changed. Other devices were logged out.')) setPw({ current: '', next: '', repeat: '' });
    return undefined;
  }
  return (
    <>
      <PageHeader title="Account settings" sub={`Signed in as ${me.username} (${me.role.replace('_', ' ')})`} />
      <div className="grid2">
        <Card title="Profile">
          <form className="form" onSubmit={saveProfile}>
            <Field label="Username"><input value={me.username} disabled /></Field>
            <Field label="Full name"><input value={p.fullName} onChange={(e) => setP({ ...p, fullName: e.target.value })} maxLength={100} /></Field>
            <Field label="Email"><input type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} /></Field>
            <div><button type="submit" className="btn btn--primary">Save profile</button></div>
          </form>
        </Card>
        <Card title="Change password" sub="At least 10 characters. Other devices are logged out.">
          <form className="form" onSubmit={changePw}>
            <Field label="Current password"><input required type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
            <Field label="New password"><input required type="password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
            <Field label="Repeat new password"><input required type="password" minLength={10} value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} autoComplete="new-password" /></Field>
            {msg && <p className="bad">{msg}</p>}
            <div><button type="submit" className="btn btn--primary">Change password</button></div>
          </form>
        </Card>
      </div>
    </>
  );
}

const shortUa = (ua) => {
  if (!ua) return 'Unknown device';
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ` on ${os}` : ''}`;
};

export function Security() {
  const run = useAction();
  const confirm = useConfirm();
  const sessions = useApi('/api/me/sessions');
  const activity = useApi('/api/me/activity');
  const others = (sessions.data?.sessions || []).filter((s) => !s.current).length;
  return (
    <>
      <PageHeader title="Security" sub="Where you are signed in, and what happened on your account" />
      <Card title="Active sessions" actions={others > 0 && (
        <button type="button" className="btn btn--small btn--danger" onClick={async () => {
          if (await confirm({ title: 'Log out all other sessions?', danger: true, confirmLabel: 'Log them out' })) {
            if (await run(() => api('/api/me/sessions/revoke-others', { method: 'POST' }), 'Other sessions ended')) sessions.reload();
          }
        }}>Log out other sessions</button>
      )} pad={false}>
        <ErrorNote error={sessions.error} />
        {!sessions.data ? <div className="pad"><SkeletonRows /></div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last active</th><th className="num" /></tr></thead>
            <tbody>{sessions.data.sessions.map((s) => (
              <tr key={s.id}>
                <td><Icon name="monitor" size={14} /> {shortUa(s.userAgent)} {s.current && <Badge tone="good">this device</Badge>}</td>
                <td className="muted">{s.ip || '–'}</td><td className="muted">{dateTime(s.createdAt)}</td><td className="muted">{ago(s.lastSeenAt)}</td>
                <td className="num">{!s.current && <button type="button" className="btn btn--small" onClick={async () => { if (await run(() => api(`/api/me/sessions/${s.id}`, { method: 'DELETE' }), 'Session ended')) sessions.reload(); }}>Log out</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title="Recent activity" sub="Logins, password changes and actions on your servers" pad={false}>
        {!activity.data ? <div className="pad"><SkeletonRows /></div> : activity.data.entries.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>Result</th><th>IP</th></tr></thead>
            <tbody>{activity.data.entries.map((e) => (
              <tr key={e.id}><td className="muted">{dateTime(e.ts)}</td><td>{e.username || '–'}</td><td>{e.action.replace(/_/g, ' ')}</td><td>{e.target || '–'}</td>
                <td><Badge tone={e.result === 'success' ? 'good' : e.result === 'failure' ? 'bad' : 'neutral'}>{e.result}</Badge></td><td className="muted">{e.ip || '–'}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="shield" title="No activity yet" />}
      </Card>
    </>
  );
}

export function SshKeys() {
  const { me, cts } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/ssh-keys');
  const [f, setF] = useState({ name: '', publicKey: '' });
  const servers = Object.values(cts).filter((c) => me.isAdmin || me.containers.includes(c.name)).map((c) => c.name).sort();
  const [sync, setSync] = useState({ container: '', login: 'root' });
  async function add(e) {
    e.preventDefault();
    if (await run(() => api('/api/ssh-keys', { method: 'POST', body: f }), (r) => `Key added (${r.fingerprint})`)) { setF({ name: '', publicKey: '' }); reload(); }
  }
  async function doSync(e) {
    e.preventDefault();
    const container = sync.container || servers[0];
    await run(() => api('/api/ssh-keys/sync', { method: 'POST', body: { container, login: sync.login } }), (r) => `${r.count} key(s) written to ${r.file} on ${container}`);
  }
  return (
    <>
      <PageHeader title="SSH keys" sub="Public keys for logging in to your servers over SSH" />
      <div className="grid2">
        <Card title="Add a key" sub="Paste the contents of ~/.ssh/id_ed25519.pub (never the private key)">
          <form className="form" onSubmit={add}>
            <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Work laptop" maxLength={60} /></Field>
            <Field label="Public key"><textarea className="textarea mono" required rows={4} value={f.publicKey} onChange={(e) => setF({ ...f, publicKey: e.target.value })} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} /></Field>
            <div><button type="submit" className="btn btn--primary"><Icon name="plus" size={14} /> Add key</button></div>
          </form>
        </Card>
        <Card title="Install on a server" sub="Writes your keys into authorized_keys between Kapil Cloud marker lines. Keys added by hand stay.">
          {servers.length ? (
            <form className="form" onSubmit={doSync}>
              <Field label="Server"><select value={sync.container || servers[0]} onChange={(e) => setSync({ ...sync, container: e.target.value })}>{servers.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Login user in the server" hint="root, ubuntu, or your own user"><input value={sync.login} onChange={(e) => setSync({ ...sync, login: e.target.value })} pattern="[a-z_][a-z0-9_\-]{0,31}" /></Field>
              <div><button type="submit" className="btn btn--primary">Sync keys</button></div>
              <Note>Run this again after adding or removing keys.</Note>
            </form>
          ) : <Empty icon="server" title="No servers yet" />}
        </Card>
      </div>
      <ErrorNote error={error} />
      <Card title="Your keys" pad={false}>
        {!data ? <div className="pad"><SkeletonRows /></div> : data.keys.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Fingerprint</th><th>Added</th><th className="num" /></tr></thead>
            <tbody>{data.keys.map((k) => (
              <tr key={k.id}><td><Icon name="key" size={14} /> {k.name}</td><td className="muted">{k.type}</td><td><code>{k.fingerprint}</code></td><td className="muted">{ago(k.created_at)}</td>
                <td className="num"><button type="button" className="btn btn--small btn--danger" onClick={async () => {
                  if (await confirm({ title: `Remove ${k.name}?`, danger: true, confirmLabel: 'Remove', body: 'Sync your servers afterwards to remove it from them too.' })) {
                    if (await run(() => api(`/api/ssh-keys/${k.id}`, { method: 'DELETE' }), 'Key removed')) reload();
                  }
                }}>Remove</button></td></tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="key" title="No keys yet">Add a key to log in without a password.</Empty>}
      </Card>
    </>
  );
}
