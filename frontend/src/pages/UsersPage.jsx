import { useState } from 'react';
import { api, bytes, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Icon, Field, href, go, useApi, useAction, useConfirm } from '../ui.jsx';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const ROLE_TONE = { super_admin: 'info', admin: 'info', user: 'neutral' };
const roleLabel = (r) => r.replace('_', ' ');

function UserForm({ open, onClose, user, containers, onSaved }) {
  const { me } = useLive();
  const run = useAction();
  const editing = !!user;
  const q = (v, d) => (v == null ? '' : Math.round(v / d));
  const [f, setF] = useState(null);
  if (open && !f) {
    setF(user ? {
      fullName: user.full_name || '', email: user.email || '', role: user.role, containers: user.containers,
      maxContainers: user.max_containers ?? '', maxCpu: user.max_cpu ?? '', maxMemoryMiB: q(user.max_memory, MiB), maxDiskGiB: q(user.max_disk, GiB),
      maxSnapshots: user.max_snapshots ?? '', netLimitMbit: user.net_limit_mbit ?? '',
    } : { username: '', password: '', fullName: '', email: '', role: 'user', containers: [], maxContainers: '', maxCpu: '', maxMemoryMiB: '', maxDiskGiB: '', maxSnapshots: '', netLimitMbit: '' });
  }
  if (!open && f) setF(null);
  if (!f) return <Dialog open={false} title="" onClose={onClose} />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const quotas = { maxContainers: f.maxContainers, maxCpu: f.maxCpu, maxMemoryMiB: f.maxMemoryMiB, maxDiskGiB: f.maxDiskGiB, maxSnapshots: f.maxSnapshots, netLimitMbit: f.netLimitMbit };
  async function submit(e) {
    e.preventDefault();
    const body = { fullName: f.fullName, email: f.email, containers: f.role === 'user' ? f.containers : [], quotas };
    if (editing && f.role !== user.role) body.role = f.role;
    const r = editing
      ? await run(() => api(`/api/users/${user.id}`, { method: 'PUT', body }), 'User saved')
      : await run(() => api('/api/users', { method: 'POST', body: { ...body, username: f.username, password: f.password, role: f.role } }), `Created ${f.username}`);
    if (r) { onSaved(); onClose(); }
  }
  const canRole = me.role === 'super_admin' && (!editing || user.id !== me.id);
  return (
    <Dialog open={open} title={editing ? `Edit ${user.username}` : 'Create user'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          {!editing && <Field label="Username" hint="2-32 lowercase letters, digits, _ or -"><input required value={f.username} onChange={set('username')} pattern="[a-z][a-z0-9_\-]{1,31}" autoComplete="off" /></Field>}
          {!editing && <Field label="Password" hint="At least 10 characters"><input required type="password" minLength={10} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>}
          <Field label="Full name"><input value={f.fullName} onChange={set('fullName')} maxLength={100} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Role" hint={canRole ? 'Admins manage servers and users; super admins also delete servers and manage admins' : 'Only a super admin can change roles'}>
            <select value={f.role} onChange={set('role')} disabled={!canRole && editing}>
              <option value="user">User</option>
              {me.role === 'super_admin' && <option value="admin">Admin</option>}
              {me.role === 'super_admin' && <option value="super_admin">Super admin</option>}
            </select>
          </Field>
        </div>
        {f.role === 'user' && (
          <>
            <fieldset className="bk-fieldset"><legend>Servers</legend>
              {containers.length ? <div className="checks">{containers.map((c) => (
                <label key={c} className="check"><input type="checkbox" checked={f.containers.includes(c)}
                  onChange={(e) => setF({ ...f, containers: e.target.checked ? [...f.containers, c] : f.containers.filter((x) => x !== c) })} /> {c}</label>
              ))}</div> : <p className="muted small">No servers exist yet.</p>}
            </fieldset>
            <fieldset className="bk-fieldset"><legend>Quotas <span className="muted small">(empty = no limit; checked when an admin provisions servers for this user)</span></legend>
              <div className="fgrid">
                <Field label="Max servers"><input type="number" min={0} value={f.maxContainers} onChange={set('maxContainers')} /></Field>
                <Field label="Max CPU cores (total)"><input type="number" min={0} value={f.maxCpu} onChange={set('maxCpu')} /></Field>
                <Field label="Max memory MiB (total)"><input type="number" min={0} step={128} value={f.maxMemoryMiB} onChange={set('maxMemoryMiB')} /></Field>
                <Field label="Max disk GiB (total)"><input type="number" min={0} value={f.maxDiskGiB} onChange={set('maxDiskGiB')} /></Field>
                <Field label="Max snapshots per server" hint="Default 5"><input type="number" min={0} value={f.maxSnapshots} onChange={set('maxSnapshots')} /></Field>
                <Field label="Network limit Mbit/s" hint="Default for new servers"><input type="number" min={0} value={f.netLimitMbit} onChange={set('netLimitMbit')} /></Field>
              </div>
            </fieldset>
          </>
        )}
        <div className="dialog__buttons">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary">{editing ? 'Save' : 'Create user'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function UserDetail({ id, onClose }) {
  const { data, error } = useApi(`/api/users/${id}`);
  const u = data?.user;
  return (
    <Dialog open title={u ? `${u.username}${u.full_name ? ` · ${u.full_name}` : ''}` : 'User'} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!data ? <SkeletonRows /> : (
        <>
          <dl className="facts facts--cols">
            <div><dt>Role</dt><dd>{roleLabel(u.role)}</dd></div>
            <div><dt>Status</dt><dd>{u.status}</dd></div>
            <div><dt>Last login</dt><dd>{u.last_login_at ? `${dateTime(u.last_login_at)} from ${u.last_login_ip}` : 'never'}</dd></div>
            <div><dt>Servers</dt><dd>{u.containers.join(', ') || 'none'}</dd></div>
            <div><dt>Memory in use</dt><dd>{bytes(u.usage.memUsed)} of {bytes(u.usage.memLimit)}</dd></div>
            <div><dt>Disk in use</dt><dd>{bytes(u.usage.diskUsed)} of {bytes(u.usage.diskLimit)}</dd></div>
          </dl>
          <h3 className="h3">Active sessions</h3>
          {data.sessions.length ? <ul className="plain">{data.sessions.map((s) => <li key={s.id}>{s.ip || '?'} · last active {ago(s.lastSeenAt)} · <span className="muted">{s.userAgent}</span></li>)}</ul> : <p className="muted">None</p>}
          <h3 className="h3">Recent activity</h3>
          <div className="table-wrap scroll-y"><table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
            <tbody>{data.activity.map((e) => <tr key={e.id}><td className="muted">{dateTime(e.ts)}</td><td>{e.username}</td><td>{e.action}</td><td>{e.target || '–'}</td><td>{e.result}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
      <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

export default function UsersPage({ selected }) {
  const { me } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/users', { interval: 30000 });
  const [edit, setEdit] = useState(null);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [pw, setPw] = useState('');
  const [q, setQ] = useState('');
  if (!me.isAdmin) return null;
  const list = (data?.users || []).filter((u) => !q || `${u.username} ${u.full_name || ''} ${u.email || ''}`.toLowerCase().includes(q.toLowerCase()));
  const canTouch = (u) => me.role === 'super_admin' || u.role === 'user';

  const toggle = async (u) => {
    const op = u.status === 'active' ? 'suspend' : 'activate';
    if (op === 'suspend' && !(await confirm({ title: `Suspend ${u.username}?`, body: 'They are logged out immediately and cannot log in. Their servers keep running.', danger: true, confirmLabel: 'Suspend' }))) return;
    if (await run(() => api(`/api/users/${u.id}/${op}`, { method: 'POST' }), `${u.username} ${op === 'suspend' ? 'suspended' : 'activated'}`)) reload();
  };
  const remove = async (u) => {
    const typed = await confirm({ title: `Delete ${u.username}?`, typed: u.username, danger: true, confirmLabel: 'Delete user', body: <p>Their login, SSH keys and app records are removed. <b>Their servers are kept</b> ({u.containers.join(', ') || 'none'}) and stay visible to admins.</p> });
    if (typed && await run(() => api(`/api/users/${u.id}`, { method: 'DELETE', body: { confirm: typed } }), `Deleted ${u.username}`)) reload();
  };
  async function resetPw(e) {
    e.preventDefault();
    if (await run(() => api(`/api/users/${resetFor.id}/password`, { method: 'POST', body: { password: pw } }), `Password reset. ${resetFor.username} was logged out everywhere.`)) { setResetFor(null); setPw(''); }
  }

  return (
    <>
      <PageHeader title="Users" sub="Accounts, roles, server assignments and quotas"
        actions={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Create user</button>} />
      <div className="filters"><div className="input-icon"><Icon name="search" size={16} /><input placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <ErrorNote error={error} onRetry={reload} />
      <Card pad={false}>
        {!data ? <div className="pad"><SkeletonRows /></div> : list.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Servers</th><th>Usage</th><th>Last login</th><th className="num">Actions</th></tr></thead>
            <tbody>{list.map((u) => (
              <tr key={u.id}>
                <td><a href={href(`users/${u.id}`)} className="user-cell"><span className="who__avatar sm">{u.username[0].toUpperCase()}</span>
                  <span><strong>{u.username}</strong>{u.id === me.id && <span className="muted"> (you)</span>}<small>{u.full_name || u.email || ''}</small></span></a></td>
                <td><Badge tone={ROLE_TONE[u.role]}>{roleLabel(u.role)}</Badge></td>
                <td><Badge tone={u.status === 'active' ? 'good' : 'bad'} dot>{u.status}</Badge></td>
                <td>{u.containers.length ? u.containers.map((c) => <a key={c} className="chip" href={href(`servers/${c}`)}>{c}</a>) : <span className="muted">–</span>}</td>
                <td className="muted small">{u.role === 'user' ? `${u.usage.running}/${u.usage.servers} running · ${bytes(u.usage.memUsed)} RAM · ${u.usage.apps} apps` : '–'}</td>
                <td className="muted">{u.last_login_at ? ago(u.last_login_at) : 'never'}</td>
                <td className="num"><span className="row-actions">
                  <button type="button" className="btn btn--small" disabled={!canTouch(u)} onClick={() => setEdit(u)}>Edit</button>
                  <button type="button" className="btn btn--small" disabled={!canTouch(u)} onClick={() => { setPw(''); setResetFor(u); }}>Password</button>
                  <button type="button" className="btn btn--small" disabled={!canTouch(u) || u.id === me.id} onClick={() => toggle(u)}>{u.status === 'active' ? 'Suspend' : 'Activate'}</button>
                  <button type="button" className="btn btn--small btn--danger" disabled={!canTouch(u) || u.id === me.id} onClick={() => remove(u)} aria-label={`Delete ${u.username}`}><Icon name="trash" size={14} /></button>
                </span></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="users" title="No users match" />}
      </Card>
      <UserForm open={creating} onClose={() => setCreating(false)} containers={data?.containers || []} onSaved={reload} />
      <UserForm open={!!edit} user={edit} onClose={() => setEdit(null)} containers={data?.containers || []} onSaved={reload} />
      {selected && <UserDetail id={selected} onClose={() => go('users')} />}
      <Dialog open={!!resetFor} title={`Reset password for ${resetFor?.username}`} onClose={() => setResetFor(null)}>
        <form className="form" onSubmit={resetPw}>
          <Field label="New password" hint="At least 10 characters. They are logged out everywhere."><input required type="password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
          <div className="dialog__buttons"><button type="button" className="btn" onClick={() => setResetFor(null)}>Cancel</button><button type="submit" className="btn btn--primary">Reset password</button></div>
        </form>
      </Dialog>
    </>
  );
}
