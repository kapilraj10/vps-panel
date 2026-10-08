import { useEffect, useRef, useState } from 'react';
import { api, bytes, pct, dateTime, Dialog, Meter } from './lib.jsx';

const TARGETS = [
  ['containers', 'LXD containers'],
  ['host', 'Host files'],
  ['databases', 'Databases (Docker)'],
  ['pm2', 'PM2 process list'],
];
const TARGET_SHORT = { containers: 'Containers', host: 'Files', databases: 'Databases', pm2: 'PM2' };
const STATUS = { running: ['busy', 'Running'], success: ['ok', 'Success'], failed: ['bad', 'Failed'] };
const TASK_TITLE = { 'dry run': 'Dry run', verify: 'Verify', restore: 'Restore' };
const NEW_CT_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const PAGE = 50;

function duration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function triggerLabel(j) {
  if (j.trigger === 'timer') return 'Scheduled';
  if (j.trigger === 'manual') return `Manual (${j.by})`;
  if (j.trigger === 'cli') return `Command line (${j.by})`;
  return j.trigger || '–';
}

function StatusPill({ status }) {
  const [cls, label] = STATUS[status] || ['bad', status];
  return <span className={`status status--${cls}`}><span className="status__dot" />{label}</span>;
}

// Scrolls to the bottom as lines arrive, unless the user scrolled up to read
function LogView({ text, empty = 'No output yet.' }) {
  const ref = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return <pre className="log" ref={ref} onScroll={onScroll}>{text || empty}</pre>;
}

// Loads a job log over HTTP, then appends the live chunks the server streams over the socket.
// Chunks carry byte offsets; any gap or overlap simply reloads the log.
function useJobLog(id, socket) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const offset = useRef(0);
  useEffect(() => {
    if (!id) return undefined;
    let gone = false;
    const load = () => api(`/api/backups/jobs/${id}/log`)
      .then((d) => {
        if (gone) return;
        offset.current = d.offset;
        setText(`${d.truncated ? '… (older lines not shown)\n' : ''}${d.text}`);
        setError('');
      })
      .catch((e) => { if (!gone) setError(e.message); });
    const onLog = (ev) => {
      if (ev.id !== id) return;
      if (ev.from === offset.current) {
        offset.current = ev.to;
        setText((t) => (t + ev.text).slice(-1_000_000));
      } else if (ev.to > offset.current) {
        load();
      }
    };
    load();
    socket.on('backup:log', onLog);
    return () => { gone = true; socket.off('backup:log', onLog); };
  }, [id, socket]);
  return { text, error };
}

function DiskCard({ disk, error, onRefresh }) {
  const smart = disk?.smart || { health: 'unknown' };
  const used = disk?.total ? pct(disk.used, disk.total) : 0;
  const smartClass = smart.health === 'PASSED' ? 'good' : smart.health === 'FAILED' ? 'bad' : 'muted';
  return (
    <section className="panel" aria-label="Backup disk">
      <div className="panel__head">
        <h2>Backup disk</h2>
        <button type="button" className="btn btn--small" onClick={onRefresh}>Refresh</button>
      </div>
      {error ? <p className="bad">{error}</p> : (
        <>
          <dl className="ct__facts">
            <div><dt>Mounted</dt><dd className={disk.mounted ? 'good' : 'bad'}>{disk.mounted ? `Yes, at ${disk.mountpoint}` : 'No'}</dd></div>
            <div><dt>Device</dt><dd>{disk.source ? `${disk.source}${disk.fstype ? ` (${disk.fstype})` : ''}` : '–'}</dd></div>
            <div>
              <dt>SMART health</dt>
              <dd className={smartClass} title={smart.note || ''}>
                {smart.health}{smart.temperature != null ? `, ${smart.temperature}°C` : ''}
              </dd>
            </div>
            {smart.model && <div><dt>Model</dt><dd>{smart.model}{smart.powerOnHours != null ? `, ${smart.powerOnHours.toLocaleString()} h on` : ''}</dd></div>}
          </dl>
          {disk.mounted && disk.total ? (
            <div className="ct__meters bk-meter">
              <Meter label="Used" percent={used} value={`${used}%`} detail={`${bytes(disk.free)} free of ${bytes(disk.total)}`} />
            </div>
          ) : null}
          {disk.error && <p className="bad">{disk.error}</p>}
          {smart.health === 'unknown' && smart.note && <p className="muted bk-small">{smart.note}</p>}
        </>
      )}
    </section>
  );
}

function LastCard({ last, running, starting, timer, config, onStart }) {
  let next = 'Off';
  if (config?.schedule.enabled) {
    if (timer?.next) next = dateTime(timer.next);
    else next = timer?.installed ? 'Not scheduled (timer inactive)' : 'Timer not installed';
  }
  return (
    <section className="panel" aria-label="Last backup">
      <div className="panel__head">
        <h2>Last backup</h2>
        {last && <StatusPill status={last.status} />}
      </div>
      <dl className="ct__facts">
        {last && (
          <>
            <div><dt>Started</dt><dd>{dateTime(last.startedAt)}</dd></div>
            <div><dt>Duration</dt><dd>{duration(last.finishedAt - last.startedAt)}</dd></div>
            <div><dt>New data</dt><dd>{last.status === 'success' ? bytes(last.size) : '–'}</dd></div>
          </>
        )}
        <div><dt>Next scheduled run</dt><dd>{next}</dd></div>
      </dl>
      {!last && <p className="muted">No backups yet.</p>}
      {last?.status === 'failed' && <p className="bad bk-error">{last.error}</p>}
      {last?.warning && <p className="bk-warn">{last.warning}</p>}
      <div className="ct__actions">
        <button type="button" className="btn btn--primary" disabled={!!running || starting || !config} onClick={onStart}>
          {running ? 'Backup running…' : starting ? 'Starting…' : 'Backup now'}
        </button>
      </div>
    </section>
  );
}

function LiveJob({ job, socket }) {
  const { text, error } = useJobLog(job.id, socket);
  const p = job.progress || 0;
  return (
    <section className="panel" aria-label="Running backup">
      <div className="panel__head">
        <h2>Backup {job.id} is running</h2>
        <span className="muted">{triggerLabel(job)}, started {dateTime(job.startedAt)}</span>
      </div>
      <div className="bk-progress">
        <div className="meter__track" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label="Backup progress">
          <div className="meter__fill" style={{ width: `${p}%` }} />
        </div>
        <span className="meter__value">{p}%</span>
      </div>
      <p className="muted bk-phase">{job.phase}</p>
      {error ? <p className="bad">{error}</p> : <LogView text={text} />}
    </section>
  );
}

function TaskPanel({ task, onClose }) {
  const r = task.result;
  let summary;
  if (task.status === 'running') summary = <p className="ct__note ct__note--busy">Running…</p>;
  else if (task.status === 'failure') summary = <p className="ct__note ct__note--bad">{task.error}</p>;
  else if (task.kind === 'verify') {
    summary = r?.ok
      ? <p className="ct__note ct__note--ok">All {r.checked.toLocaleString()} files match their checksums.</p>
      : <p className="ct__note ct__note--bad">{r?.failureCount} problem(s) found. See the output above.</p>;
  } else if (task.kind === 'restore') {
    summary = (
      <div className="ct__note ct__note--ok">
        Created <strong>{r?.name}</strong>. It is stopped: start it from the Containers page or with <code>lxc start {r?.name}</code>.
        {r?.warnings?.map((w) => <p key={w} className="bk-warn">{w}</p>)}
      </div>
    );
  } else summary = <p className="ct__note ct__note--ok">Dry run finished. Nothing was written.</p>;

  return (
    <section className="panel" aria-label={TASK_TITLE[task.kind] || task.kind}>
      <div className="panel__head">
        <h2>{TASK_TITLE[task.kind] || task.kind}: {task.label}</h2>
        {task.status !== 'running' && <button type="button" className="btn btn--small" onClick={onClose}>Close</button>}
      </div>
      <p className="muted bk-phase">Started by {task.by} at {dateTime(task.startedAt)}</p>
      {(task.lines.length > 0 || task.status === 'running') && <LogView text={task.lines.join('\n')} />}
      {summary}
    </section>
  );
}

function History({ jobs, onDisk, more, onMore, onLog, onVerify, taskBusy }) {
  const verifyCell = (j) => {
    if (j.status !== 'success') return '';
    if (onDisk && !onDisk.has(j.id)) return <span className="muted">Removed (retention)</span>;
    if (!j.verify) return <span className="muted">–</span>;
    return j.verify.ok
      ? <span className="good" title={dateTime(j.verifiedAt)}>OK</span>
      : <span className="bad" title={dateTime(j.verifiedAt)}>{j.verify.failureCount ?? '?'} bad</span>;
  };
  return (
    <section className="panel" aria-label="Backup history">
      <h2>History</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Date</th><th>Trigger</th><th>Targets</th><th className="num">Size</th><th>Duration</th><th>Status</th><th>Verified</th><th /></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{dateTime(j.startedAt)}</td>
                <td className="muted">{triggerLabel(j)}</td>
                <td>{j.targets.map((t) => TARGET_SHORT[t] || t).join(', ')}</td>
                <td className="num">{j.status === 'success' ? bytes(j.size) : '–'}</td>
                <td>{j.finishedAt ? duration(j.finishedAt - j.startedAt) : '–'}</td>
                <td>
                  <StatusPill status={j.status} />
                  {j.status === 'failed' && j.error && <div className="bk-row-error">{j.error}</div>}
                </td>
                <td>{verifyCell(j)}</td>
                <td>
                  <span className="row-actions">
                    <button type="button" className="btn btn--small" onClick={() => onLog(j.id)}>Log</button>
                    {j.status === 'success' && (!onDisk || onDisk.has(j.id)) && (
                      <button type="button" className="btn btn--small" disabled={taskBusy} onClick={() => onVerify(j.id)}>Verify</button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!jobs.length && <p className="empty empty--left">No backups yet.</p>}
      {more && <button type="button" className="btn btn--small load-more" onClick={onMore}>Load older</button>}
    </section>
  );
}

function LogDialog({ id, socket, onClose }) {
  return (
    <Dialog open={!!id} wide title={id ? `Log of backup ${id}` : ''} onClose={onClose}>
      {id && <LogBody id={id} socket={socket} />}
      <div className="dialog__buttons">
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}

function LogBody({ id, socket }) {
  const { text, error } = useJobLog(id, socket);
  return error ? <p className="bad">{error}</p> : <LogView text={text} empty="Loading…" />;
}

function StartDialog({ open, config, onClose, onStarted, onTask }) {
  const [targets, setTargets] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !config) return;
    setTargets(TARGETS.map(([k]) => k).filter((k) => config.targets[k]));
    setMsg('');
  }, [open]);
  const toggle = (k) => setTargets((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]));

  async function go(dry) {
    setBusy(true);
    try {
      if (dry) onTask(await api('/api/backups/dry-run', { method: 'POST', body: { targets } }));
      else onStarted((await api('/api/backups/run', { method: 'POST', body: { targets } })).id);
      onClose();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Back up now" onClose={onClose}>
      <p>Choose what to back up this time. The daily schedule keeps using the targets in Settings.</p>
      <div className="checks bk-gap">
        {TARGETS.map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={targets.includes(k)} onChange={() => toggle(k)} />{label}</label>
        ))}
      </div>
      {msg && <p className="bad">{msg}</p>}
      <div className="dialog__buttons">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={busy || !targets.length} onClick={() => go(true)}>Dry run</button>
        <button type="button" className="btn btn--primary" disabled={busy || !targets.length} onClick={() => go(false)}>Start backup</button>
      </div>
    </Dialog>
  );
}

function ContainerRestore({ run, taskBusy, onTask, existing }) {
  const [pick, setPick] = useState(null);
  const [newName, setNewName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');

  const open = (name) => { setPick(name); setNewName(`${name}-restored`); setConfirm(''); setMsg(''); };
  const taken = existing.includes(newName);
  const nameOk = NEW_CT_RE.test(newName) && !taken;

  async function restore(e) {
    e.preventDefault();
    try {
      onTask(await api(`/api/backups/runs/${run.id}/restore-container`, { method: 'POST', body: { container: pick, newName, confirm } }));
      setPick(null);
    } catch (err) {
      setMsg(err.message);
    }
  }

  if (!run.containers.length) return <p className="empty empty--left">This backup has no container exports.</p>;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Container</th><th /></tr></thead>
          <tbody>
            {run.containers.map((n) => (
              <tr key={n}>
                <td>{n}</td>
                <td className="num">
                  <button type="button" className="btn btn--small" disabled={taskBusy} onClick={() => open(n)}>Restore as new container…</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={!!pick} title={`Restore ${pick || ''} as a new container`} onClose={() => setPick(null)}>
        <form className="form" onSubmit={restore}>
          <p>
            This imports the export of <strong>{pick}</strong> from {dateTime(run.startedAt)} as a <strong>new, stopped</strong> container
            with new MAC addresses. {pick} itself is not touched.
          </p>
          <label>
            New container name
            <input required value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase())} autoComplete="off" spellCheck={false} />
          </label>
          {taken && <p className="bad">{newName} already exists. Pick another name.</p>}
          {!taken && newName && !NEW_CT_RE.test(newName) && <p className="bad">Use lowercase letters, digits and dashes, starting with a letter.</p>}
          <label>
            <span>Type <code>{newName}</code> to confirm</span>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          {msg && <p className="bad">{msg}</p>}
          <div className="dialog__buttons">
            <button type="button" className="btn" onClick={() => setPick(null)}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={!nameOk || confirm !== newName}>Restore</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function FileBrowser({ run }) {
  const [dir, setDir] = useState('');
  const [list, setList] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!run.hostPaths.length) return undefined;
    let gone = false;
    setList(null);
    setError('');
    api(`/api/backups/runs/${run.id}/files?path=${encodeURIComponent(dir)}`)
      .then((d) => { if (!gone) setList(d); })
      .catch((e) => { if (!gone) setError(e.message); });
    return () => { gone = true; };
  }, [run.id, dir]);

  if (!run.hostPaths.length) return <p className="empty empty--left">This backup has no host files.</p>;
  const parts = dir ? dir.split('/') : [];
  const join = (name) => (dir ? `${dir}/${name}` : name);
  const href = (p) => `/api/backups/runs/${run.id}/download?path=${encodeURIComponent(p)}`;

  return (
    <>
      <nav className="crumbs" aria-label="Folder">
        <button type="button" className="linkish" onClick={() => setDir('')}>/</button>
        {parts.map((p, i) => (
          <span key={parts.slice(0, i + 1).join('/')}>
            <button type="button" className="linkish" onClick={() => setDir(parts.slice(0, i + 1).join('/'))}>{p}</button>
            {i < parts.length - 1 && ' /'}
          </span>
        ))}
        {dir && <a className="btn btn--small crumbs__action" href={href(dir)}>Download this folder (.tar.gz)</a>}
      </nav>
      {error && <p className="bad">{error}</p>}
      {!list && !error && <p className="muted">Loading…</p>}
      {list && (
        <div className="table-wrap bk-files">
          <table>
            <thead><tr><th>Name</th><th className="num">Size</th><th>Modified</th><th /></tr></thead>
            <tbody>
              {dir && (
                <tr><td colSpan={4}><button type="button" className="linkish" onClick={() => setDir(parts.slice(0, -1).join('/'))}>.. (up)</button></td></tr>
              )}
              {list.entries.map((e) => (
                <tr key={e.name}>
                  <td>
                    {e.type === 'dir'
                      ? <button type="button" className="linkish" onClick={() => setDir(join(e.name))}>{e.name}/</button>
                      : <span className={e.type === 'file' ? undefined : 'muted'}>{e.name}{e.type === 'link' ? ' (symlink)' : ''}</span>}
                  </td>
                  <td className="num">{e.type === 'file' ? bytes(e.size) : ''}</td>
                  <td className="muted">{e.mtime ? dateTime(e.mtime) : ''}</td>
                  <td className="num">
                    {(e.type === 'dir' || e.type === 'file') && <a className="btn btn--small" href={href(join(e.name))}>Download</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.truncated && <p className="muted">Showing the first 5000 entries.</p>}
          {!list.entries.length && <p className="empty empty--left">Empty folder.</p>}
        </div>
      )}
    </>
  );
}

function DbList({ run }) {
  if (!run.databases.length) return <p className="empty empty--left">This backup has no database dumps.</p>;
  return (
    <>
      <p className="muted bk-phase">
        Download only. To restore a Postgres dump by hand: <code>gunzip -c FILE | docker exec -i CONTAINER psql -U postgres</code>
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Container</th><th>Type</th><th>File</th><th /></tr></thead>
          <tbody>
            {run.databases.map((d) => (
              <tr key={d.file}>
                <td>{d.container}</td>
                <td>{d.kind}</td>
                <td className="muted">{d.file}</td>
                <td className="num"><a className="btn btn--small" href={`/api/backups/runs/${run.id}/db/${encodeURIComponent(d.file)}`}>Download</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Restore({ runs, error, onReload, taskBusy, onTask, existing }) {
  const [runId, setRunId] = useState('');
  const [tab, setTab] = useState('containers');
  const run = runs?.find((r) => r.id === runId) || runs?.[0];

  let body;
  if (error) body = <p className="bad">{error}</p>;
  else if (!runs) body = <p className="muted">Loading…</p>;
  else if (!run) body = <p className="empty empty--left">There are no complete backups on the disk yet.</p>;
  else {
    body = (
      <>
        <div className="form bk-gap">
          <label>
            Backup
            <select value={run.id} onChange={(e) => setRunId(e.target.value)}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>{dateTime(r.startedAt)} ({r.targets.map((t) => TARGET_SHORT[t] || t).join(', ')})</option>
              ))}
            </select>
          </label>
        </div>
        <div className="subtabs" role="tablist">
          {[['containers', 'Containers'], ['files', 'Files'], ['databases', 'Databases']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className="subtab" onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'containers' && <ContainerRestore run={run} taskBusy={taskBusy} onTask={onTask} existing={existing} />}
        {tab === 'files' && <FileBrowser key={run.id} run={run} />}
        {tab === 'databases' && <DbList run={run} />}
      </>
    );
  }

  return (
    <section className="panel" aria-label="Restore">
      <div className="panel__head">
        <h2>Restore</h2>
        <button type="button" className="btn btn--small" onClick={onReload}>Refresh</button>
      </div>
      {body}
    </section>
  );
}

const toForm = (c) => ({ ...c, hostPaths: c.hostPaths.join('\n'), excludes: c.excludes.join('\n') });
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function Settings({ config, containers, onSaved }) {
  const [f, setF] = useState(() => toForm(config));
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setF(toForm(config)), [config]);

  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const setIn = (key, patch) => setF((x) => ({ ...x, [key]: { ...x[key], ...patch } }));
  const skippable = [...new Set([...containers, ...f.containerExclude])].sort();
  const toggleSkip = (n) => set({ containerExclude: f.containerExclude.includes(n) ? f.containerExclude.filter((x) => x !== n) : [...f.containerExclude, n] });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        targets: f.targets,
        containerExclude: f.containerExclude,
        optimizedStorage: f.optimizedStorage,
        hostPaths: lines(f.hostPaths),
        excludes: lines(f.excludes),
        schedule: f.schedule,
        retention: { daily: Number(f.retention.daily), weekly: Number(f.retention.weekly), monthly: Number(f.retention.monthly) },
        pm2User: f.pm2User.trim(),
      };
      onSaved(await api('/api/backups/settings', { method: 'PUT', body }));
      setMsg({ text: 'Settings saved.' });
    } catch (err) {
      setMsg({ bad: true, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-label="Backup settings">
      <h2>Settings</h2>
      <form className="form" onSubmit={save}>
        <fieldset className="bk-fieldset">
          <legend>What to back up</legend>
          <div className="checks">
            {TARGETS.map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={f.targets[k]} onChange={(e) => setIn('targets', { [k]: e.target.checked })} />{label}
              </label>
            ))}
          </div>
          <label className="bk-narrow">PM2 runs as user<input value={f.pm2User} onChange={(e) => set({ pm2User: e.target.value })} spellCheck={false} /></label>
        </fieldset>

        <fieldset className="bk-fieldset">
          <legend>Containers</legend>
          <label className="check">
            <input type="checkbox" checked={f.optimizedStorage} onChange={(e) => set({ optimizedStorage: e.target.checked })} />
            Use --optimized-storage (smaller and faster on ZFS/btrfs, but only restorable onto the same storage driver)
          </label>
          {skippable.length > 0 && (
            <>
              <span className="bk-hint">Skip these containers (new containers are backed up automatically):</span>
              <div className="checks">
                {skippable.map((n) => (
                  <label key={n} className="check"><input type="checkbox" checked={f.containerExclude.includes(n)} onChange={() => toggleSkip(n)} />{n}</label>
                ))}
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="bk-fieldset">
          <legend>Host files</legend>
          <div className="bk-two">
            <label>Folders to back up (one per line)<textarea rows={6} value={f.hostPaths} onChange={(e) => set({ hostPaths: e.target.value })} spellCheck={false} /></label>
            <label>Exclude patterns (rsync, one per line)<textarea rows={6} value={f.excludes} onChange={(e) => set({ excludes: e.target.value })} spellCheck={false} /></label>
          </div>
        </fieldset>

        <fieldset className="bk-fieldset">
          <legend>Schedule and retention</legend>
          <div className="form form--row">
            <label className="check">
              <input type="checkbox" checked={f.schedule.enabled} onChange={(e) => setIn('schedule', { enabled: e.target.checked })} />Daily backup on
            </label>
            <label>Time (24h)<input type="time" required value={f.schedule.time} onChange={(e) => setIn('schedule', { time: e.target.value.slice(0, 5) })} /></label>
            <label>Timezone<input required value={f.schedule.timezone} onChange={(e) => setIn('schedule', { timezone: e.target.value.trim() })} spellCheck={false} /></label>
          </div>
          <div className="form form--row">
            <label>Keep daily<input type="number" min={1} max={90} value={f.retention.daily} onChange={(e) => setIn('retention', { daily: e.target.value })} /></label>
            <label>Keep weekly<input type="number" min={0} max={52} value={f.retention.weekly} onChange={(e) => setIn('retention', { weekly: e.target.value })} /></label>
            <label>Keep monthly<input type="number" min={0} max={60} value={f.retention.monthly} onChange={(e) => setIn('retention', { monthly: e.target.value })} /></label>
          </div>
          <span className="bk-hint">Old backups are removed only after a successful run. The newest good backup is never removed.</span>
        </fieldset>

        {msg && <p className={msg.bad ? 'bad' : 'good'}>{msg.text}</p>}
        <div>
          <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>
    </section>
  );
}

export default function Backups({ socket }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState([]);
  const [more, setMore] = useState(false);
  const [task, setTask] = useState(null);
  const [runs, setRuns] = useState(null);
  const [runsError, setRunsError] = useState('');
  const [logFor, setLogFor] = useState(null);
  const [startOpen, setStartOpen] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = (refresh) => api(`/api/backups${refresh ? '?refresh=1' : ''}`)
    .then((d) => {
      setData(d);
      setJobs(d.jobs);
      setMore(d.jobs.length === PAGE);
      setTask(d.task);
      setError('');
    })
    .catch((e) => setError(e.message));
  const loadRuns = () => api('/api/backups/runs')
    .then((d) => { setRuns(d.runs); setRunsError(''); })
    .catch((e) => { setRuns(null); setRunsError(e.message); });
  const loadOlder = () => api(`/api/backups/jobs?before=${jobs.at(-1).id}`)
    .then((d) => { setJobs((j) => [...j, ...d.jobs]); setMore(d.jobs.length === PAGE); })
    .catch((e) => setError(e.message));

  useEffect(() => { load(); loadRuns(); }, []);

  useEffect(() => {
    const onJob = (job) => {
      setJobs((list) => {
        const i = list.findIndex((j) => j.id === job.id);
        if (i < 0) return [job, ...list].sort((a, b) => (a.id < b.id ? 1 : -1));
        const copy = [...list];
        copy[i] = job;
        return copy;
      });
      setData((d) => (d && d.pending.includes(job.id) ? { ...d, pending: d.pending.filter((p) => p !== job.id) } : d));
      if (job.status !== 'running') {
        load(true);
        loadRuns();
      }
    };
    const onTask = (t) => setTask(t);
    const onLine = ({ startedAt, line }) => setTask((t) => (t && t.startedAt === startedAt ? { ...t, lines: [...t.lines, line].slice(-2000) } : t));
    socket.on('backup:job', onJob);
    socket.on('backup:task', onTask);
    socket.on('backup:task-line', onLine);
    return () => {
      socket.off('backup:job', onJob);
      socket.off('backup:task', onTask);
      socket.off('backup:task-line', onLine);
    };
  }, [socket]);

  async function verify(id) {
    try {
      setTask(await api(`/api/backups/runs/${id}/verify`, { method: 'POST' }));
      setNotice(null);
    } catch (e) {
      setNotice({ bad: true, text: e.message });
    }
  }

  if (!data) {
    return (
      <section className="panel">
        {error ? <p className="bad">{error}</p> : <p className="empty empty--left">Loading backups…</p>}
      </section>
    );
  }

  const running = jobs.find((j) => j.status === 'running');
  const last = jobs.find((j) => j.status !== 'running');
  const setup = data.configError || data.stateError;
  const taskBusy = task?.status === 'running';

  return (
    <>
      {error && <div className="banner">{error}</div>}
      {setup && <div className="banner">{setup}</div>}
      {notice && <div className={notice.bad ? 'banner' : 'banner banner--ok'}>{notice.text}</div>}
      <div className="split bk-top">
        <DiskCard disk={data.disk} error={data.diskError} onRefresh={() => load(true)} />
        <LastCard
          last={last}
          running={running}
          starting={data.pending.length > 0}
          timer={data.timer}
          config={data.config}
          onStart={() => setStartOpen(true)}
        />
      </div>
      {running && <LiveJob job={running} socket={socket} />}
      {task && <TaskPanel task={task} onClose={() => setTask(null)} />}
      <History
        jobs={jobs}
        onDisk={runs ? new Set(runs.map((r) => r.id)) : null}
        more={more}
        onMore={loadOlder}
        onLog={setLogFor}
        onVerify={verify}
        taskBusy={taskBusy}
      />
      <Restore runs={runs} error={runsError} onReload={loadRuns} taskBusy={taskBusy} onTask={setTask} existing={data.containers} />
      {data.config && (
        <Settings config={data.config} containers={data.containers} onSaved={(d) => setData((x) => ({ ...x, config: d.config, timer: d.timer }))} />
      )}
      <StartDialog
        open={startOpen}
        config={data.config}
        onClose={() => setStartOpen(false)}
        onStarted={(id) => setData((x) => ({ ...x, pending: [...x.pending, id] }))}
        onTask={setTask}
      />
      <LogDialog id={logFor} socket={socket} onClose={() => setLogFor(null)} />
    </>
  );
}
