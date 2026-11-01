// Kapil Cloud shell: session, live socket, sidebar navigation (admin vs user), command palette, routing.
import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { LiveCtx } from './live.js';
import { io } from 'socket.io-client';
import { api, setCsrf, MAX_POINTS, getThemePref, setThemePref } from './lib.jsx';
import { Providers, Icon, CommandPalette, useRoute, go, href, useToast, SkeletonRows } from './ui.jsx';
import Overview from './pages/Overview.jsx';
import Servers from './pages/Servers.jsx';
import ServerDetail from './pages/ServerDetail.jsx';
import UsersPage from './pages/UsersPage.jsx';
import Apps from './pages/Apps.jsx';
import Domains from './pages/Domains.jsx';
import Monitoring from './pages/Monitoring.jsx';
import Settings from './pages/Settings.jsx';
import Account, { Security, SshKeys } from './pages/Account.jsx';
import { Storage, MyBackups, MyNetwork } from './pages/UserPages.jsx';
import Audit from './Audit.jsx';
import Backups from './Backups.jsx';
import Network from './Network.jsx';

const TerminalPage = lazy(() => import('./pages/TerminalPage.jsx'));

const ADMIN_NAV = [
  ['Infrastructure', [
    ['overview', 'Overview', 'dashboard'],
    ['servers', 'Servers', 'server'],
    ['monitoring', 'Monitoring', 'chart'],
    ['network', 'Network', 'network'],
    ['backups', 'Backups', 'backup'],
  ]],
  ['Cloud', [
    ['users', 'Users', 'users'],
    ['apps', 'Applications', 'app'],
    ['domains', 'Domains', 'globe'],
    ['terminal', 'Terminal', 'terminal'],
  ]],
  ['Administration', [
    ['audit', 'Audit log', 'audit'],
    ['settings', 'Settings', 'settings'],
  ]],
  ['Account', [
    ['ssh-keys', 'SSH keys', 'key'],
    ['account', 'Account', 'user'],
    ['security', 'Security', 'shield'],
  ]],
];
const USER_NAV = [
  ['Cloud', [
    ['overview', 'Overview', 'dashboard'],
    ['servers', 'My servers', 'server'],
    ['apps', 'Applications', 'app'],
    ['terminal', 'Terminal', 'terminal'],
    ['storage', 'Storage', 'storage'],
    ['backups', 'Backups', 'backup'],
    ['network', 'Network', 'network'],
    ['monitoring', 'Monitoring', 'chart'],
  ]],
  ['Account', [
    ['ssh-keys', 'SSH keys', 'key'],
    ['account', 'Account settings', 'user'],
    ['security', 'Security', 'shield'],
  ]],
];
const ALIASES = { containers: 'servers', 'audit-log': 'audit' };

function ThemeToggle() {
  const [pref, setPref] = useState(getThemePref);
  const next = { system: 'light', light: 'dark', dark: 'system' }[pref];
  return (
    <button type="button" className="icon-btn" title={`Theme: ${pref} (click for ${next})`} aria-label={`Theme: ${pref}`}
      onClick={() => { setThemePref(next); setPref(next); }}>
      <Icon name={pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor'} />
    </button>
  );
}

function Shell() {
  const toast = useToast();
  const [me, setMe] = useState(null);
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('connecting');
  const [cts, setCts] = useState({});
  const [jobs, setJobs] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [cmdk, setCmdk] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const route = useRoute();

  useEffect(() => {
    api('/api/me').then((m) => { setCsrf(m.csrf); setMe(m); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!me) return undefined;
    api('/api/alerts?open=1').then((d) => setAlerts(d.alerts.filter((a) => !a.resolved_at))).catch(() => {});
    const s = io({ transports: ['websocket', 'polling'] });
    s.on('connect', () => setStatus('live'));
    s.on('disconnect', (reason) => {
      setStatus('offline');
      if (reason === 'io server disconnect') window.location.href = '/login';
    });
    s.on('connect_error', (err) => {
      setStatus('offline');
      if (err.message === 'unauthorized') window.location.href = '/login';
    });
    s.on('containers:init', (list) => {
      setCts(Object.fromEntries(list.map((c) => [c.name, { ...c, history: (c.history || []).slice(-MAX_POINTS) }])));
      setJobs((j) => ({ ...j, ...Object.fromEntries(list.filter((c) => c.action).map((c) => [c.name, c.action])) }));
    });
    s.on('container:sample', ({ snapshot, point }) => {
      setCts((all) => {
        const prev = all[snapshot.name];
        const history = [...(prev?.history || []).slice(-(MAX_POINTS - 1)), point];
        return { ...all, [snapshot.name]: { ...prev, ...snapshot, history } };
      });
    });
    s.on('container:action', (job) => {
      setJobs((j) => ({ ...j, [job.container]: job }));
      if (job.status === 'success') toast.ok(`${job.container}: ${job.message || `${job.action} done`}`);
      if (job.status === 'failure') toast.err(`${job.container}: ${job.action} failed: ${job.message}`);
    });
    s.on('alert', (a) => {
      setAlerts((list) => {
        const rest = list.filter((x) => x.id !== a.id);
        return a.resolved_at ? rest : [a, ...rest];
      });
      if (!a.resolved_at && a.created_at === a.updated_at) (a.level === 'critical' ? toast.err : toast.warn)(a.message);
    });
    setSocket(s);
    return () => s.disconnect();
  }, [me, toast]);

  useEffect(() => {
    const on = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk((v) => !v); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useEffect(() => setNavOpen(false), [route.join('/')]);

  const nav = me?.isAdmin ? ADMIN_NAV : USER_NAV;
  const pages = useMemo(() => nav.flatMap(([, items]) => items), [nav]);
  const names = Object.keys(cts).sort();

  const cmdItems = useMemo(() => {
    if (!me) return [];
    const out = pages.map(([id, label, icon]) => ({ label, icon, group: 'Go to', run: () => go(id) }));
    for (const n of names) {
      out.push({ label: n, icon: 'server', group: 'Server', keywords: cts[n]?.ip, run: () => go(`servers/${n}`) });
      if (cts[n]?.status === 'Running') out.push({ label: `Terminal: ${n}`, icon: 'terminal', group: 'Action', run: () => go(`terminal/${n}`) });
    }
    if (me.isAdmin) out.push({ label: 'Create server', icon: 'plus', group: 'Action', run: () => go('servers?new') });
    out.push({ label: 'Toggle theme', icon: 'sun', group: 'Action', run: () => setThemePref(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') });
    out.push({ label: 'Log out', icon: 'logout', group: 'Action', run: logout });
    return out;
  }, [me, pages, names.join(), cts]);

  async function logout() {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  if (!me || !socket) {
    return <div className="boot"><div className="boot__logo">K</div><SkeletonRows rows={3} /></div>;
  }

  const first = ALIASES[route[0]] || route[0] || 'overview';
  const page = pages.some(([id]) => id === first) ? first : 'overview';
  const live = { me, socket, status, cts, jobs, setJobs, alerts, setAlerts, names };

  let body;
  switch (page) {
    case 'servers': body = route[1] ? <ServerDetail key={route[1]} name={route[1]} tab={route[2] || 'overview'} /> : <Servers />; break;
    case 'users': body = <UsersPage selected={route[1]} />; break;
    case 'apps': body = <Apps selected={route[1]} />; break;
    case 'domains': body = <Domains />; break;
    case 'monitoring': body = <Monitoring />; break;
    case 'settings': body = <Settings />; break;
    case 'audit': body = <Audit />; break;
    case 'backups': body = me.isAdmin ? <Backups socket={socket} /> : <MyBackups />; break;
    case 'network': body = me.isAdmin ? <Network socket={socket} /> : <MyNetwork />; break;
    case 'terminal': body = <Suspense fallback={<SkeletonRows />}><TerminalPage name={route[1]} /></Suspense>; break;
    case 'storage': body = <Storage />; break;
    case 'ssh-keys': body = <SshKeys />; break;
    case 'account': body = <Account />; break;
    case 'security': body = <Security />; break;
    default: body = <Overview />;
  }

  const critical = alerts.filter((a) => a.level === 'critical').length;

  return (
    <LiveCtx.Provider value={live}>
      <div className={`shell ${navOpen ? 'shell--nav' : ''}`}>
        <aside className="side" aria-label="Main navigation">
          <a className="brand" href={href('overview')}>
            <span className="brand__mark">K</span>
            <span className="brand__text">Kapil Cloud<small>{me.isAdmin ? 'Admin console' : 'Cloud dashboard'}</small></span>
          </a>
          <nav>
            {nav.map(([group, items]) => (
              <div key={group} className="side__group">
                <div className="side__label">{group}</div>
                {items.map(([id, label, icon]) => (
                  <a key={id} href={href(id)} className="side__link" aria-current={page === id ? 'page' : undefined}>
                    <Icon name={icon} /> <span>{label}</span>
                    {id === 'monitoring' && alerts.length > 0 && <span className={`side__count ${critical ? 'is-bad' : ''}`}>{alerts.length}</span>}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="side__foot">
            <div className="who">
              <span className="who__avatar">{me.username.slice(0, 1).toUpperCase()}</span>
              <span className="who__text">{me.fullName || me.username}<small>{me.role.replace('_', ' ')}</small></span>
            </div>
            <button type="button" className="icon-btn" title="Log out" aria-label="Log out" onClick={logout}><Icon name="logout" /></button>
          </div>
        </aside>
        <div className="side__scrim" onClick={() => setNavOpen(false)} />
        <div className="main">
          <header className="topbar">
            <button type="button" className="icon-btn topbar__menu" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}><Icon name="menu" /></button>
            <button type="button" className="search" onClick={() => setCmdk(true)}>
              <Icon name="search" size={16} /> <span>Search or jump to…</span> <kbd>Ctrl K</kbd>
            </button>
            <div className="topbar__right">
              <span className={`live live--${status}`} title={status === 'live' ? 'Live updates connected' : 'Reconnecting'}>
                <i /> {status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Connecting'}
              </span>
              <a className="icon-btn bell" href={href('monitoring')} title={`${alerts.length} open alert(s)`} aria-label={`${alerts.length} open alerts`}>
                <Icon name="bell" />{alerts.length > 0 && <span className={`bell__n ${critical ? 'is-bad' : ''}`}>{alerts.length}</span>}
              </a>
              <ThemeToggle />
            </div>
          </header>
          {status === 'offline' && <div className="offline">Lost connection to the panel. Reconnecting automatically…</div>}
          <main className="content">{body}</main>
        </div>
      </div>
      <CommandPalette open={cmdk} onClose={() => setCmdk(false)} items={cmdItems} />
    </LiveCtx.Provider>
  );
}

export default function Panel() {
  return <Providers><Shell /></Providers>;
}
