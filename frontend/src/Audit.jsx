import { useEffect, useState } from 'react';
import { api, dateTime } from './lib.jsx';
import { PageHeader, Icon } from './ui.jsx';

const PAGE = 100;
const resultClass = { failure: 'bad', success: 'good' };

export default function Audit() {
  const [entries, setEntries] = useState([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [user, setUser] = useState('');

  const qs = () => `${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${user.trim() ? `&user=${encodeURIComponent(user.trim())}` : ''}`;
  const load = (before) => api(`/api/audit?limit=${PAGE}${before ? `&before=${before}` : ''}${qs()}`)
    .then((d) => {
      setEntries((e) => (before ? [...e, ...d.entries] : d.entries));
      setMore(d.entries.length === PAGE);
    })
    .catch((e) => setError(e.message));

  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [q, user]);

  return (
    <>
    <PageHeader title="Audit log" sub="Every login, change and infrastructure action, with who did it and from where"
      actions={<button type="button" className="btn" onClick={() => load()}><Icon name="refresh" size={14} /> Refresh</button>} />
    <div className="filters">
      <div className="input-icon"><Icon name="search" size={16} /><input placeholder="Search actions, targets, details" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <input className="input" placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)} />
    </div>
    <section className="panel" aria-label="Audit log">
      {error && <p className="bad">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th><th>IP</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted">{dateTime(e.ts)}</td>
                <td>{e.username || '–'}</td>
                <td>{e.action}</td>
                <td>{e.target || '–'}</td>
                <td className={resultClass[e.result] || ''}>{e.result}</td>
                <td className="muted">{e.ip || '–'}</td>
                <td className="muted">{e.detail || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!entries.length && !error && <p className="empty empty--left">Nothing logged yet.</p>}
      {more && (
        <button type="button" className="btn btn--small load-more" onClick={() => load(entries.at(-1).id)}>Load older</button>
      )}
    </section>
    </>
  );
}
