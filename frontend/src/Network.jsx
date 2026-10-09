import { useEffect, useRef, useState } from 'react';
import { api, getCsrf, dateTime, ago } from './lib.jsx';

const PHASE = { latency: 'Measuring latency', download: 'Testing download', upload: 'Testing upload', done: 'Done' };
const fmt = (v, unit) => (v == null ? '–' : `${v} ${unit}`);
const msClass = (ms) => (ms == null ? '' : ms >= 150 ? 'bad' : ms >= 60 ? 'warn-text' : 'good');

function Stat({ label, value, unit, live = false }) {
  return (
    <div className={`stat ${live ? 'stat--live' : ''}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value ?? '–'}<small>{value != null ? ` ${unit}` : ''}</small></span>
    </div>
  );
}

function Progress({ value }) {
  const p = Math.round(Math.min(1, Math.max(0, value || 0)) * 100);
  return (
    <div className="meter__track net-progress" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <div className="meter__fill" style={{ width: `${p}%` }} />
    </div>
  );
}

// ---------- server -> internet ----------
function ServerSpeed({ socket, initial }) {
  const [job, setJob] = useState(initial.job);
  const [history, setHistory] = useState(initial.history);
  const [error, setError] = useState('');

  useEffect(() => {
    const on = (d) => { setJob(d.job); setHistory(d.history); };
    socket.on('net:speed', on);
    return () => socket.off('net:speed', on);
  }, [socket]);

  const running = job?.status === 'running';
  const start = () => { setError(''); api('/api/net/speedtest', { method: 'POST' }).catch((e) => setError(e.message)); };
  const cancel = () => api('/api/net/speedtest/cancel', { method: 'POST' }).catch((e) => setError(e.message));
  const shown = job || history[0];

  return (
    <section className="panel" aria-label="Server internet speed">
      <div className="panel__head">
        <h2>Server internet speed</h2>
        {running
          ? <button type="button" className="btn btn--small" onClick={cancel}>Cancel</button>
          : <button type="button" className="btn btn--primary" onClick={start}>Run speed test</button>}
      </div>
      <p className="muted bk-small">
        Measures this server&apos;s own connection, against Cloudflare&apos;s speed test servers
        {shown?.colo ? <> (nearest: <strong>{shown.colo}</strong>{shown.loc ? `, ${shown.loc}` : ''})</> : ''}. Takes about 20 seconds.
      </p>
      <div className="stats">
        <Stat label="Download" unit="Mbps" value={running && job.phase === 'download' ? job.live : shown?.download} live={running && job.phase === 'download'} />
        <Stat label="Upload" unit="Mbps" value={running && job.phase === 'upload' ? job.live : shown?.upload} live={running && job.phase === 'upload'} />
        <Stat label="Latency" unit="ms" value={shown?.latency} />
        <Stat label="Jitter" unit="ms" value={shown?.jitter} />
      </div>
      {running && (
        <div className="net-phase">
          <span className="status status--busy"><span className="status__dot" />{PHASE[job.phase]}</span>
          {job.phase !== 'latency' && <Progress value={job.progress} />}
        </div>
      )}
      {job?.status === 'failed' && <p className="bad bk-error">Speed test failed: {job.error}</p>}
      {error && <p className="bad bk-error">{error}</p>}

      {history.length > 0 && (
        <>
          <h3 className="ct__sub net-sub">Recent tests</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th className="num">Download</th><th className="num">Upload</th><th className="num">Latency</th><th className="num">Jitter</th><th>Server</th><th>By</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.startedAt}>
                    <td className="muted">{dateTime(h.startedAt)}</td>
                    {h.status === 'success' ? (
                      <>
                        <td className="num">{fmt(h.download, 'Mbps')}</td>
                        <td className="num">{fmt(h.upload, 'Mbps')}</td>
                        <td className="num">{fmt(h.latency, 'ms')}</td>
                        <td className="num">{fmt(h.jitter, 'ms')}</td>
                      </>
                    ) : <td colSpan={4} className="bad">{h.error}</td>}
                    <td className="muted">{h.colo || '–'}</td>
                    <td className="muted">{h.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted bk-small">History is kept in memory and starts over when the panel restarts. Every test is in the audit log.</p>
        </>
      )}
    </section>
  );
}

// ---------- ping ----------
function Ping({ targets }) {
  const [host, setHost] = useState('');
  const [count, setCount] = useState(5);
  const [rows, setRows] = useState({}); // host -> result | { pending: true }
  const [error, setError] = useState('');

  async function run(h) {
    setRows((r) => ({ ...r, [h]: { ...r[h], host: h, pending: true } }));
    try {
      const res = await api('/api/net/ping', { method: 'POST', body: { host: h, count } });
      setRows((r) => ({ ...r, [h]: res }));
    } catch (e) {
      setRows((r) => ({ ...r, [h]: { host: h, error: e.message, at: Date.now() } }));
    }
  }

  const submit = (e) => {
    e.preventDefault();
    const h = host.trim();
    if (!h) return;
    setError('');
    if (!/^[A-Za-z0-9.:-]{1,253}$/.test(h)) { setError('Enter a hostname (like google.com) or an IP address'); return; }
    run(h);
  };
  const list = Object.values(rows).sort((a, b) => (b.at || Infinity) - (a.at || Infinity));
  const busy = list.some((r) => r.pending);

  return (
    <section className="panel" aria-label="Ping">
      <div className="panel__head">
        <h2>Ping / latency</h2>
        <button type="button" className="btn btn--small" disabled={busy} onClick={() => targets.forEach(run)}>Ping common servers</button>
      </div>
      <p className="muted bk-small">Ping is sent from the server, so this shows the server&apos;s latency to each host.</p>
      <form className="form form--row net-form" onSubmit={submit}>
        <label>Host or IP<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="google.com or 1.1.1.1" maxLength={253} /></label>
        <label className="bk-narrow">Packets
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[3, 5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn--primary" disabled={!host.trim() || rows[host.trim()]?.pending}>Ping</button>
      </form>
      {error && <p className="bad bk-error">{error}</p>}

      {list.length > 0 && (
        <div className="table-wrap net-table">
          <table>
            <thead>
              <tr><th>Host</th><th>IP</th><th className="num">Received</th><th className="num">Loss</th><th className="num">Min</th><th className="num">Avg</th><th className="num">Max</th><th className="num">Jitter</th><th className="num">When</th></tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.host}>
                  <td>{r.host}</td>
                  {r.pending ? (
                    <td colSpan={8} className="muted">Pinging…</td>
                  ) : r.error && !r.received ? (
                    <><td colSpan={7} className="bad">{r.error}</td><td className="num muted">{ago(r.at)}</td></>
                  ) : (
                    <>
                      <td className="muted">{r.ip || '–'}</td>
                      <td className="num">{r.received}/{r.sent}</td>
                      <td className={`num ${r.loss > 0 ? 'bad' : ''}`}>{r.loss}%</td>
                      <td className="num">{fmt(r.min, 'ms')}</td>
                      <td className={`num ${msClass(r.avg)}`}>{fmt(r.avg, 'ms')}</td>
                      <td className="num">{fmt(r.max, 'ms')}</td>
                      <td className="num">{fmt(r.jitter, 'ms')}</td>
                      <td className="num muted">{ago(r.at)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- browser -> panel ----------
const B_PHASE_MS = 8000;
const B_WARMUP_MS = 1000;
const B_STREAMS = 3;
const B_DOWN = 25 * 1024 * 1024;
const B_UP = 8 * 1024 * 1024;
const mbps = (b, ms) => (ms > 0 ? Math.round(((b * 8) / (ms / 1000) / 1e6) * 10) / 10 : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const jitter = (a) => (a.length > 1 ? a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1) : 0);

let upBlob = null;
function randomBlob() {
  if (upBlob) return upBlob;
  const buf = new Uint8Array(B_UP);
  for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
  upBlob = new Blob([buf]);
  return upBlob;
}

async function browserLatency(signal) {
  const times = [];
  for (let i = 0; i < 11; i += 1) {
    const t0 = performance.now();
    const r = await fetch(`/api/net/echo?n=${Date.now()}-${i}`, { cache: 'no-store', credentials: 'same-origin', signal });
    if (!r.ok) throw new Error(`Panel answered ${r.status}`);
    await r.json();
    if (i > 0) times.push(performance.now() - t0);
  }
  return { latency: Math.round(median(times) * 10) / 10, jitter: Math.round(jitter(times) * 10) / 10 };
}

async function downloadWorker(count, signal) {
  const r = await fetch(`/api/net/download?bytes=${B_DOWN}&n=${Math.random()}`, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    count(value.length);
  }
}

// fetch() cannot report upload progress, XMLHttpRequest can
function uploadWorker(count, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    xhr.open('POST', '/api/net/upload');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-csrf-token', getCsrf());
    xhr.upload.onprogress = (e) => { count(e.loaded - seen); seen = e.loaded; };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => resolve();
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(randomBlob());
  });
}

async function measure(worker, onTick, outer) {
  const ctl = new AbortController();
  const stopOuter = () => ctl.abort();
  outer.addEventListener('abort', stopOuter);
  let total = 0;
  const start = performance.now();
  let base = null;
  let last = { t: start, b: 0 };
  const tick = setInterval(() => {
    const now = performance.now();
    if (!base && now - start >= B_WARMUP_MS) base = { t: now, b: total };
    onTick(mbps(total - last.b, now - last.t), Math.min(1, (now - start) / B_PHASE_MS));
    last = { t: now, b: total };
  }, 500);
  const stop = setTimeout(() => ctl.abort(), B_PHASE_MS);
  let error = null;
  await Promise.all(Array.from({ length: B_STREAMS }, async () => {
    while (!ctl.signal.aborted) {
      try {
        await worker((n) => { total += n; }, ctl.signal);
      } catch (e) {
        if (!ctl.signal.aborted) { error = e; ctl.abort(); }
      }
    }
  }));
  clearInterval(tick);
  clearTimeout(stop);
  outer.removeEventListener('abort', stopOuter);
  if (outer.aborted) throw new Error('Cancelled');
  if (!total) throw error || new Error('No data transferred');
  const from = base || { t: start, b: 0 };
  return mbps(total - from.b, performance.now() - from.t);
}

function BrowserSpeed() {
  const [res, setRes] = useState(null);
  const [state, setState] = useState(null); // { phase, live, progress }
  const [error, setError] = useState('');
  const abort = useRef(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function start() {
    const ctl = new AbortController();
    abort.current = ctl;
    setError('');
    const out = { latency: null, jitter: null, download: null, upload: null };
    setRes({ ...out });
    try {
      setState({ phase: 'latency' });
      Object.assign(out, await browserLatency(ctl.signal));
      setRes({ ...out });
      setState({ phase: 'download', progress: 0 });
      out.download = await measure(downloadWorker, (live, progress) => setState({ phase: 'download', live, progress }), ctl.signal);
      setRes({ ...out });
      setState({ phase: 'upload', progress: 0 });
      out.upload = await measure(uploadWorker, (live, progress) => setState({ phase: 'upload', live, progress }), ctl.signal);
      setRes({ ...out });
    } catch (e) {
      setError(e.name === 'AbortError' ? 'Cancelled' : e.message);
    }
    setState(null);
    abort.current = null;
  }

  const running = !!state;
  return (
    <section className="panel" aria-label="Your connection to the panel">
      <div className="panel__head">
        <h2>Your connection to the panel</h2>
        {running
          ? <button type="button" className="btn btn--small" onClick={() => abort.current?.abort()}>Cancel</button>
          : <button type="button" className="btn btn--primary" onClick={start}>Test my connection</button>}
      </div>
      <p className="muted bk-small">
        Measures from this browser to the panel (through Cloudflare Tunnel), so it shows how fast the server feels from where you are now.
      </p>
      <div className="stats">
        <Stat label="Download" unit="Mbps" value={state?.phase === 'download' ? state.live : res?.download} live={state?.phase === 'download'} />
        <Stat label="Upload" unit="Mbps" value={state?.phase === 'upload' ? state.live : res?.upload} live={state?.phase === 'upload'} />
        <Stat label="Latency" unit="ms" value={res?.latency} />
        <Stat label="Jitter" unit="ms" value={res?.jitter} />
      </div>
      {running && (
        <div className="net-phase">
          <span className="status status--busy"><span className="status__dot" />{PHASE[state.phase]}</span>
          {state.phase !== 'latency' && <Progress value={state.progress} />}
        </div>
      )}
      {error && <p className="bad bk-error">{error}</p>}
    </section>
  );
}

export default function Network({ socket }) {
  const [initial, setInitial] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/net/state').then(setInitial).catch((e) => setError(e.message)); }, []);

  if (error) return <section className="panel"><p className="bad">{error}</p></section>;
  if (!initial) return <section className="panel"><p className="empty empty--left">Loading…</p></section>;
  return (
    <>
      <ServerSpeed socket={socket} initial={initial} />
      <Ping targets={initial.targets} />
      <BrowserSpeed />
    </>
  );
}
