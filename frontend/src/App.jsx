import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const MAX_POINTS = 720;

// ---------- formatting ----------
function bytes(n) {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const pct = (used, total) => (total ? Math.round((used / total) * 1000) / 10 : 0);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function uptime(s) {
  if (!s) return '–';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function ago(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const level = (p) => (p >= 90 ? 'alarm' : p >= 75 ? 'warn' : 'ok');

// Recharts needs real colour values, so read them from the CSS tokens
function useColors() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return { muted: v('--muted'), line: v('--line'), signal: v('--signal'), ram: v('--ram'), surface: v('--surface'), ink: v('--ink') };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setC(read());
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return c;
}

// ---------- pieces ----------
function Meter({ label, value, detail, percent }) {
  const p = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <div className={`meter meter--${level(p)}`}>
      <span className="meter__label">{label}</span>
      <div className="meter__track" role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="meter__fill" style={{ width: `${p}%` }} />
      </div>
      <span className="meter__value">{value}</span>
      <span className="meter__detail">{detail}</span>
    </div>
  );
}

function ChartTip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <div className="tip__time">{clock(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="tip__row">
          <span className="tip__dot" style={{ background: p.color }} />
          {p.name}: <strong>{p.value}{unit}</strong>
        </div>
      ))}
    </div>
  );
}

// ---------- app ----------
export default function App() {
  const colors = useColors();
  const [status, setStatus] = useState('connecting');
  const [info, setInfo] = useState(null);
  const [history, setHistory] = useState([]);
  const [apps, setApps] = useState([]);
  const [procs, setProcs] = useState([]);
  const [up, setUp] = useState(0);

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => setStatus('live'));
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));
    socket.on('init', (d) => {
      setInfo(d.info);
      setHistory(d.history.slice(-MAX_POINTS));
      setApps(d.apps);
      setProcs(d.processes);
      setUp(d.uptime);
    });
    socket.on('sample', (d) => {
      setHistory((h) => [...h.slice(-(MAX_POINTS - 1)), d.point]);
      setApps(d.apps);
      setProcs(d.processes);
      setUp(d.uptime);
    });
    return () => socket.disconnect();
  }, []);

  const sampleMs = info?.sampleMs || 5000;
  const last = history.at(-1);

  const series = useMemo(
    () => history.map((p) => ({
      t: p.t,
      cpu: p.cpu,
      ram: pct(p.ramUsed, p.ramTotal),
      rpm: Math.round((p.req * 60_000) / sampleMs),
    })),
    [history, sampleMs]
  );

  const reqLastMinute = useMemo(() => {
    if (!last) return 0;
    return history.filter((p) => last.t - p.t < 60_000).reduce((s, p) => s + p.req, 0);
  }, [history, last]);
  const reqTotal = useMemo(() => history.reduce((s, p) => s + p.req, 0), [history]);
  const peakRpm = useMemo(() => series.reduce((m, p) => Math.max(m, p.rpm), 0), [series]);

  const axis = { stroke: colors.muted, fontSize: 11, tickLine: false, axisLine: false };

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>{info?.hostname || 'Server'}</h1>
          <p className="top__meta">
            {info ? `${info.distro}, ${info.cores} cores` : 'Connecting to server'}
          </p>
        </div>
        <div className="top__right">
          <span className="top__uptime">Up {uptime(up)}</span>
          <span className={`status status--${status}`}>
            <span className="status__dot" />
            {status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Connecting'}
          </span>
        </div>
      </header>

      {status === 'offline' && (
        <div className="banner">Lost connection to the panel. It reconnects automatically when the server is back.</div>
      )}

      <section className="pulse" aria-label="Requests">
        <div className="pulse__figure">
          <span className="pulse__number">{reqLastMinute.toLocaleString()}</span>
          <span className="pulse__caption">requests in the last minute</span>
          <dl className="pulse__facts">
            <div><dt>Last hour</dt><dd>{reqTotal.toLocaleString()}</dd></div>
            <div><dt>Peak rate</dt><dd>{peakRpm.toLocaleString()}/min</dd></div>
          </dl>
        </div>
        <div className="pulse__chart">
          {series.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="rpmFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.signal} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={colors.signal} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" tickFormatter={clock} minTickGap={60} {...axis} />
                <YAxis width={36} allowDecimals={false} {...axis} />
                <Tooltip content={<ChartTip unit="/min" />} />
                <Area type="monotone" dataKey="rpm" name="Requests" stroke={colors.signal} strokeWidth={2} fill="url(#rpmFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="empty">Waiting for the first readings…</p>
          )}
        </div>
      </section>

      <section className="meters" aria-label="Resources">
        <Meter label="CPU" percent={last?.cpu} value={last ? `${last.cpu}%` : '–'} detail={info ? `${info.cores} cores` : ''} />
        <Meter
          label="Memory"
          percent={last ? pct(last.ramUsed, last.ramTotal) : 0}
          value={last ? `${pct(last.ramUsed, last.ramTotal)}%` : '–'}
          detail={last ? `${bytes(last.ramUsed)} of ${bytes(last.ramTotal)}` : ''}
        />
        <Meter
          label="Disk"
          percent={last ? pct(last.diskUsed, last.diskTotal) : 0}
          value={last ? `${pct(last.diskUsed, last.diskTotal)}%` : '–'}
          detail={last ? `${bytes(last.diskTotal - last.diskUsed)} free` : ''}
        />
        <Meter
          label="Temperature"
          percent={last?.temp ?? 0}
          value={last?.temp != null ? `${last.temp}°C` : 'n/a'}
          detail={last?.temp != null ? 'CPU package' : 'Sensor not available'}
        />
        <div className="net">
          <span className="meter__label">Network</span>
          <span className="net__pair">
            <span>Down <strong>{last ? `${bytes(last.rx)}/s` : '–'}</strong></span>
            <span>Up <strong>{last ? `${bytes(last.tx)}/s` : '–'}</strong></span>
          </span>
        </div>
      </section>

      <div className="split">
        <section className="panel" aria-label="CPU and memory history">
          <h2>CPU and memory, last hour</h2>
          <div className="panel__chart">
            {series.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={colors.line} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={clock} minTickGap={60} {...axis} />
                  <YAxis width={36} domain={[0, 100]} unit="%" {...axis} />
                  <Tooltip content={<ChartTip unit="%" />} />
                  <Line type="monotone" dataKey="cpu" name="CPU" stroke={colors.signal} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ram" name="Memory" stroke={colors.ram} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="empty">Waiting for the first readings…</p>
            )}
          </div>
          <div className="legend">
            <span><i style={{ background: colors.signal }} />CPU</span>
            <span><i style={{ background: colors.ram }} />Memory</span>
          </div>
        </section>

        <section className="panel" aria-label="Busiest processes">
          <h2>Busiest processes</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Process</th><th>User</th><th className="num">CPU</th><th className="num">Memory</th></tr>
              </thead>
              <tbody>
                {procs.map((p) => (
                  <tr key={p.pid}>
                    <td>{p.name}</td>
                    <td className="muted">{p.user}</td>
                    <td className="num">{p.cpu}%</td>
                    <td className="num">{bytes(p.mem)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel" aria-label="Apps">
        <h2>Apps</h2>
        {apps.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>App</th><th className="num">Per minute</th><th className="num">Total</th>
                  <th className="num">Errors</th><th className="num">Avg time</th><th className="num">Last request</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td>
                    <td className="num">{a.rpm.toLocaleString()}</td>
                    <td className="num">{a.count.toLocaleString()}</td>
                    <td className={`num ${a.errors ? 'bad' : ''}`}>{a.errors.toLocaleString()}</td>
                    <td className="num">{a.avgMs} ms</td>
                    <td className="num muted">{ago(a.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty empty--left">
            No app is sending request counts yet. Add <code>panel-tracker.js</code> to an Express app on this server and it shows up here.
          </p>
        )}
      </section>
    </div>
  );
}
