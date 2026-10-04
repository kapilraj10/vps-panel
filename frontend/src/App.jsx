import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  MAX_POINTS, bytes, pct, clock, uptime, ago, useColors, Meter, ChartTip,
} from './lib.jsx';

// ---------- app ----------
// Host overview (admins only). The socket is shared with the rest of the panel.
export default function App({ socket, status }) {
  const colors = useColors();
  const [info, setInfo] = useState(null);
  const [history, setHistory] = useState([]);
  const [apps, setApps] = useState([]);
  const [procs, setProcs] = useState([]);
  const [up, setUp] = useState(0);

  useEffect(() => {
    const onInit = (d) => {
      setInfo(d.info);
      setHistory(d.history.slice(-MAX_POINTS));
      setApps(d.apps);
      setProcs(d.processes);
      setUp(d.uptime);
    };
    const onSample = (d) => {
      setHistory((h) => [...h.slice(-(MAX_POINTS - 1)), d.point]);
      setApps(d.apps);
      setProcs(d.processes);
      setUp(d.uptime);
    };
    // The socket may have connected before this tab was opened, so also load a snapshot
    fetch('/api/snapshot', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && onInit(d)).catch(() => {});
    socket.on('init', onInit);
    socket.on('sample', onSample);
    return () => {
      socket.off('init', onInit);
      socket.off('sample', onSample);
    };
  }, [socket]);

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
