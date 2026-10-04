import { useEffect, useState } from 'react';
import { api, dateTime, Dialog } from './lib.jsx';

const blank = { username: '', role: 'user', container: '', password: '' };

export default function Users({ me }) {
  const [list, setList] = useState([]);
  const [containers, setContainers] = useState([]);
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState(null);
  const [resetFor, setResetFor] = useState(null);
  const [deleteFor, setDeleteFor] = useState(null);
  const [newPw, setNewPw] = useState('');

  const load = () => api('/api/users').then((d) => { setList(d.users); setContainers(d.containers); }).catch((e) => setMsg({ bad: true, text: e.message }));
  useEffect(() => { load(); }, []);

  const done = (text) => { setMsg({ text }); load(); };
  const fail = (e) => setMsg({ bad: true, text: e.message });

  async function create(e) {
    e.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: form });
      setForm(blank);
      done(`Created ${form.username}.`);
    } catch (err) { fail(err); }
  }

  async function resetPassword(e) {
    e.preventDefault();
    try {
      await api(`/api/users/${resetFor.id}/password`, { method: 'POST', body: { password: newPw } });
      setResetFor(null);
      setNewPw('');
      done(`Password reset for ${resetFor.username}. They were logged out everywhere.`);
    } catch (err) { fail(err); }
  }

  async function remove() {
    try {
      await api(`/api/users/${deleteFor.id}`, { method: 'DELETE' });
      setDeleteFor(null);
      done(`Deleted ${deleteFor.username}.`);
    } catch (err) { setDeleteFor(null); fail(err); }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      {msg && <div className={`banner ${msg.bad ? '' : 'banner--ok'}`} role="status">{msg.text}</div>}

      <section className="panel" aria-label="Users">
        <h2>Users</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Username</th><th>Role</th><th>Container</th><th>Created</th><th className="num">Actions</th></tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}{u.username === me.username ? <span className="muted"> (you)</span> : null}</td>
                  <td>{u.role}</td>
                  <td className="muted">{u.container_name || '–'}</td>
                  <td className="muted">{dateTime(u.created_at)}</td>
                  <td className="num">
                    <span className="row-actions">
                      <button type="button" className="btn btn--small" onClick={() => { setNewPw(''); setResetFor(u); }}>Reset password</button>
                      <button type="button" className="btn btn--small btn--danger" disabled={u.username === me.username} onClick={() => setDeleteFor(u)}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-label="Create user">
        <h2>Create user</h2>
        <form className="form form--row" onSubmit={create}>
          <label>Username<input required value={form.username} onChange={set('username')} autoComplete="off" pattern="[a-z][a-z0-9_\-]{1,31}" /></label>
          <label>Role
            <select value={form.role} onChange={set('role')}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          {form.role === 'user' && (
            <label>Container
              <select required value={form.container} onChange={set('container')}>
                <option value="">Choose…</option>
                {containers.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <label>Password<input required type="password" minLength={10} value={form.password} onChange={set('password')} autoComplete="new-password" /></label>
          <button type="submit" className="btn btn--primary">Create</button>
        </form>
      </section>

      <Dialog open={!!resetFor} title={`Reset password for ${resetFor?.username}`} onClose={() => setResetFor(null)}>
        <form className="form" onSubmit={resetPassword}>
          <label>New password<input required type="password" minLength={10} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" /></label>
          <div className="dialog__buttons">
            <button type="button" className="btn" onClick={() => setResetFor(null)}>Cancel</button>
            <button type="submit" className="btn btn--primary">Reset password</button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!deleteFor} title={`Delete ${deleteFor?.username}?`} onClose={() => setDeleteFor(null)}>
        <p>They are logged out immediately and can no longer sign in. Their container is not touched.</p>
        <div className="dialog__buttons">
          <button type="button" className="btn" onClick={() => setDeleteFor(null)}>Cancel</button>
          <button type="button" className="btn btn--danger" onClick={remove}>Delete user</button>
        </div>
      </Dialog>
    </>
  );
}
