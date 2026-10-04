import { useEffect, useState } from 'react';
import { api, dateTime } from './lib.jsx';

const PAGE = 100;
const resultClass = { failure: 'bad', success: 'good' };

export default function Audit() {
  const [entries, setEntries] = useState([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const load = (before) => api(`/api/audit?limit=${PAGE}${before ? `&before=${before}` : ''}`)
    .then((d) => {
      setEntries((e) => (before ? [...e, ...d.entries] : d.entries));
      setMore(d.entries.length === PAGE);
    })
    .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  return (
    <section className="panel" aria-label="Audit log">
      <div className="panel__head">
        <h2>Audit log</h2>
        <button type="button" className="btn btn--small" onClick={() => load()}>Refresh</button>
      </div>
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
  );
}
