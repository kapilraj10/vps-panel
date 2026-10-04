import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  api, bytes, pct, clock, uptime, useColors, Meter, ChartTip, Dialog,
} from './lib.jsx';

const ACTIONS = {
  start: {
    label: 'Start', verb: 'Starting', done: 'Started',
    confirm: 'Start this container?',
  },
  restart: {
    label: 'Restart', verb: 'Restarting', done: 'Restarted',
    confirm: 'Restart this container? SSH sessions and websites will drop for a few seconds while it boots again.',
  },
  stop: {
    label: 'Power off', verb: 'Powering off', done: 'Powered off',
    confirm: 'Power off this container? SSH and your websites will stop until you press Start.',
  },
};

// One LXD container: status, resource meters, history chart and power controls.
// `job` is the running or last finished action for this container (from the socket).
export default function ContainerCard({ ct, job, onJob }) {
  const colors = useColors();
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');
  const axis = { stroke: colors.muted, fontSize: 11, tickLine: false, axisLine: false };

  const isRunning = ct.status === 'Running';
  const busy = job?.status === 'running';
  const series = ct.history || [];

  async function run(action) {
    setConfirm(null);
    setError('');
    try {
      onJob(await api(`/api/containers/${encodeURIComponent(ct.name)}/action`, { method: 'POST', body: { action } }));
    } catch (err) {
      setError(err.message);
    }
  }

  let note = null;
  if (busy) {
    note = <p className="ct__note ct__note--busy">{ACTIONS[job.action].verb}…{job.message ? ` (${job.message})` : ''}</p>;
  } else if (job?.status === 'success') {
    note = <p className="ct__note ct__note--ok">{ACTIONS[job.action].done} {job.by ? `by ${job.by} ` : ''}at {clock(job.finishedAt)}.</p>;
  } else if (job?.status === 'failure') {
    note = <p className="ct__note ct__note--bad">{ACTIONS[job.action].label} failed: {job.message}</p>;
  }

  return (
    <section className="panel ct" aria-label={`Container ${ct.name}`}>
      <header className="ct__head">
        <div>
          <h2 className="ct__name">{ct.name}</h2>
          <p className="top__meta">
            {isRunning && ct.startedAt ? `Up ${uptime((Date.now() - ct.startedAt) / 1000)}` : isRunning ? 'Running' : 'Not running'}
          </p>
        </div>
        <span className={`status ${isRunning ? 'status--live' : 'status--stopped'}`}>
          <span className="status__dot" />
          {ct.status}
        </span>
      </header>

      <dl className="ct__facts">
        <div><dt>IP address</dt><dd>{ct.ip || '–'}</dd></div>
        <div><dt>SSH</dt><dd><code>{ct.ssh}</code></dd></div>
      </dl>

      <div className="ct__meters">
        <Meter label="CPU" percent={ct.cpu} value={isRunning ? `${ct.cpu}%` : '–'} detail={`${ct.cores} ${ct.cores === 1 ? 'core' : 'cores'}`} />
        <Meter
          label="Memory"
          percent={pct(ct.memUsed, ct.memTotal)}
          value={isRunning ? `${pct(ct.memUsed, ct.memTotal)}%` : '–'}
          detail={`${bytes(ct.memUsed)} of ${bytes(ct.memTotal)}`}
        />
        <Meter
          label="Disk"
          percent={pct(ct.diskUsed, ct.diskTotal)}
          value={ct.diskTotal ? `${pct(ct.diskUsed, ct.diskTotal)}%` : '–'}
          detail={ct.diskTotal ? `${bytes(ct.diskUsed)} of ${bytes(ct.diskTotal)}` : `${bytes(ct.diskUsed)} used`}
        />
        <div className="net">
          <span className="meter__label">Network</span>
          <span className="net__pair">
            <span>Down <strong>{bytes(ct.rx)}/s</strong></span>
            <span>Up <strong>{bytes(ct.tx)}/s</strong></span>
          </span>
        </div>
      </div>

      <h3 className="ct__sub">CPU and memory, last hour</h3>
      <div className="panel__chart">
        {series.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={colors.line} vertical={false} />
              <XAxis dataKey="t" tickFormatter={clock} minTickGap={60} {...axis} />
              <YAxis width={36} domain={[0, 100]} unit="%" {...axis} />
              <Tooltip content={<ChartTip unit="%" />} />
              <Line type="monotone" dataKey="cpu" name="CPU" stroke={colors.signal} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="mem" name="Memory" stroke={colors.ram} strokeWidth={2} dot={false} isAnimationActive={false} />
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

      <div className="ct__actions">
        <button type="button" className="btn" disabled={busy || isRunning} onClick={() => setConfirm('start')}>Start</button>
        <button type="button" className="btn" disabled={busy || !isRunning} onClick={() => setConfirm('restart')}>Restart</button>
        <button type="button" className="btn btn--danger" disabled={busy || !isRunning} onClick={() => setConfirm('stop')}>Power off</button>
      </div>
      {note}
      {error && <p className="ct__note ct__note--bad">{error}</p>}

      <Dialog open={!!confirm} title={confirm ? `${ACTIONS[confirm].label} ${ct.name}?` : ''} onClose={() => setConfirm(null)}>
        {confirm && (
          <>
            <p>{ACTIONS[confirm].confirm}</p>
            <div className="dialog__buttons">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className={`btn ${confirm === 'stop' ? 'btn--danger' : 'btn--primary'}`} onClick={() => run(confirm)}>
                {ACTIONS[confirm].label}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}
