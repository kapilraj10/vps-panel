import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import App from './App.jsx';
import ContainerCard from './ContainerCard.jsx';
import Users from './Users.jsx';
import Audit from './Audit.jsx';
import Backups from './Backups.jsx';
import Network from './Network.jsx';
import { api, setCsrf, MAX_POINTS, Dialog } from './lib.jsx';

const ADMIN_PAGES = [
  ['overview', 'Overview'],
  ['containers', 'Containers'],
  ['users', 'Users'],
  ['backups', 'Backups'],
  ['network', 'Network'],
  ['audit', 'Audit log'],
];

function useHashPage(fallback) {
  const read = () => window.location.hash.slice(1) || fallback;
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => setPage(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return page;
}

function PasswordDialog({ open, onClose }) {
  const [f, setF] = useState({ current: '', next: '', repeat: '' });
  const [msg, setMsg] = useState(null);
  const close = () => { setF({ current: '', next: '', repeat: '' }); setMsg(null); onClose(); };

  async function submit(e) {
    e.preventDefault();
    if (f.next !== f.repeat) return setMsg({ bad: true, text: 'New passwords do not match' });
    try {
      await api('/api/password', { method: 'POST', body: { current: f.current, next: f.next } });
      setF({ current: '', next: '', repeat: '' });
      return setMsg({ text: 'Password changed. Other devices were logged out.' });
    } catch (err) {
      return setMsg({ bad: true, text: err.message });
    }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <Dialog open={open} title="Change password" onClose={close}>
      <form className="form" onSubmit={submit}>
        <label>Current password<input required type="password" value={f.current} onChange={set('current')} autoComplete="current-password" /></label>
        <label>New password<input required type="password" minLength={10} value={f.next} onChange={set('next')} autoComplete="new-password" /></label>
        <label>Repeat new password<input required type="password" minLength={10} value={f.repeat} onChange={set('repeat')} autoComplete="new-password" /></label>
        {msg && <p className={msg.bad ? 'bad' : 'good'}>{msg.text}</p>}
        <div className="dialog__buttons">
          <button type="button" className="btn" onClick={close}>Close</button>
          <button type="submit" className="btn btn--primary">Change password</button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Panel() {
  const [me, setMe] = useState(null);
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('connecting');
  const [cts, setCts] = useState({}); // name -> container view (with history)
  const [jobs, setJobs] = useState({}); // name -> running or last finished action
  const [pwOpen, setPwOpen] = useState(false);
  const page = useHashPage('overview');

  useEffect(() => {
    api('/api/me').then((m) => { setCsrf(m.csrf); setMe(m); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!me) return undefined;
    const s = io({ transports: ['websocket', 'polling'] });
    s.on('connect', () => setStatus('live'));
    s.on('disconnect', (reason) => {
      setStatus('offline');
      // The server drops the socket when the session ends (logout, password reset, user deleted)
      if (reason === 'io server disconnect') window.location.href = '/login';
    });
    s.on('connect_error', (err) => {
      setStatus('offline');
      if (err.message === 'unauthorized') window.location.href = '/login';
    });
    s.on('containers:init', (list) => {
      setCts(Object.fromEntries(list.map((c) => [c.name, { ...c, history: c.history.slice(-MAX_POINTS) }])));
      setJobs((j) => ({ ...j, ...Object.fromEntries(list.filter((c) => c.action).map((c) => [c.name, c.action])) }));
    });
    s.on('container:sample', ({ snapshot, point }) => {
      setCts((all) => {
        const prev = all[snapshot.name];
        const history = [...(prev?.history || []).slice(-(MAX_POINTS - 1)), point];
        return { ...all, [snapshot.name]: { ...snapshot, history } };
      });
    });
    s.on('container:action', (job) => setJobs((j) => ({ ...j, [job.container]: job })));
    setSocket(s);
    return () => s.disconnect();
  }, [me]);

  async function logout() {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  if (!me || !socket) return <div className="page"><p className="empty">Loading…</p></div>;

  const isAdmin = me.role === 'admin';
  const current = isAdmin && ADMIN_PAGES.some(([id]) => id === page) ? page : 'overview';
  const onJob = (job) => setJobs((j) => ({ ...j, [job.container]: job }));
  const names = Object.keys(cts).sort();
  const hostPage = isAdmin && current === 'overview'; // has its own status pill and banner

  let body;
  if (!isAdmin) {
    const mine = cts[me.container];
    body = mine
      ? <ContainerCard ct={mine} job={jobs[me.container]} onJob={onJob} />
      : <section className="panel"><p className="empty empty--left">{status === 'live' ? `Container "${me.container}" was not found. Ask the admin.` : 'Loading your container…'}</p></section>;
  } else if (current === 'overview') {
    body = <App socket={socket} status={status} />;
  } else if (current === 'containers') {
    body = names.length
      ? <div className="ct-grid">{names.map((n) => <ContainerCard key={n} ct={cts[n]} job={jobs[n]} onJob={onJob} />)}</div>
      : <section className="panel"><p className="empty empty--left">No LXD containers found (or LXD is not reachable).</p></section>;
  } else if (current === 'users') {
    body = <Users me={me} />;
  } else if (current === 'backups') {
    body = <Backups socket={socket} />;
  } else if (current === 'network') {
    body = <Network socket={socket} />;
  } else {
    body = <Audit />;
  }

  return (
    <>
      <nav className="bar" aria-label="Main">
        <div className="bar__inner">
          {isAdmin ? (
            <ul className="tabs">
              {ADMIN_PAGES.map(([id, label]) => (
                <li key={id}><a href={`#${id}`} aria-current={current === id ? 'page' : undefined}>{label}</a></li>
              ))}
            </ul>
          ) : <span className="bar__title">Your server</span>}
          <div className="bar__account">
            {!hostPage && (
              <span className={`status status--${status}`}>
                <span className="status__dot" />
                {status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Connecting'}
              </span>
            )}
            <span className="muted">{me.username}</span>
            <button type="button" className="btn btn--small" onClick={() => setPwOpen(true)}>Change password</button>
            <button type="button" className="btn btn--small" onClick={logout}>Log out</button>
          </div>
        </div>
      </nav>
      {/* The host overview brings its own .page wrapper */}
      <div className={hostPage ? undefined : 'page'}>
        {status === 'offline' && !hostPage && (
          <div className="banner">Lost connection to the panel. It reconnects automatically when the server is back.</div>
        )}
        {body}
      </div>
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
