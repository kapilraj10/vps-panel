import { useEffect, useMemo, useState } from 'react';
import { api, bytes, pct, uptime, dateTime, ago } from '../lib.jsx';
import { useLive } from '../live.js';
import {
  PageHeader, Card, Stat, Bar, Badge, ServerStatus, TimeChart, Empty, SkeletonRows, ErrorNote, Note, Icon, Tabs, Field, Copy,
  href, go, useApi, useAction, useConfirm,
} from '../ui.jsx';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const RANGES = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days']];

export function HistoryChart({ scope, kind = 'cpu' }) {
  const [range, setRange] = useState('24h');
  const { data, error } = useApi(`/api/metrics?scope=${encodeURIComponent(scope)}&range=${range}`, { interval: 60000 });
  const pts = useMemo(() => (data?.points || []).map((p) => ({
    t: p.t, cpu: p.cpu == null ? null : Math.round(p.cpu * 10) / 10,
    mem: p.memTotal ? Math.round((p.mem / p.memTotal) * 1000) / 10 : null, rx: p.rx, tx: p.tx,
  })), [data]);
  const fmtT = (t) => new Date(t).toLocaleString([], range === '7d' ? { month: 'short', day: 'numeric', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  return (
    <>
      <div className="seg seg--small mb12">{RANGES.map(([id, l]) => <button key={id} type="button" aria-pressed={range === id} onClick={() => setRange(id)}>{l}</button>)}</div>
      {error && <ErrorNote error={error} />}
      {kind === 'net'
        ? <TimeChart data={pts} tickTime={fmtT} series={[{ key: 'rx', name: 'Download', color: 's1' }, { key: 'tx', name: 'Upload', color: 's2' }]} format={(v) => `${bytes(v)}/s`} />
        : <TimeChart data={pts} tickTime={fmtT} series={[{ key: 'cpu', name: 'CPU', color: 's1' }, { key: 'mem', name: 'Memory', color: 's2' }]} unit="%" domain={[0, 100]} />}
      <p className="muted small">One-minute averages, kept for 7 days.</p>
    </>
  );
}

function PowerButtons({ c, admin, busy }) {
  const run = useAction();
  const confirm = useConfirm();
  const isRunning = c.status === 'Running';
  const act = async (action, text) => {
    if (text && !(await confirm({ title: `${action[0].toUpperCase()}${action.slice(1)} ${c.name}?`, body: text, confirmLabel: action, danger: action === 'stop' }))) return;
    await run(() => api(`/api/containers/${c.name}/action`, { method: 'POST', body: { action } }));
  };
  return (
    <div className="btn-row">
      <button type="button" className="btn" disabled={busy || isRunning || c.status === 'Frozen'} onClick={() => act('start')}><Icon name="play" size={14} /> Start</button>
      <button type="button" className="btn" disabled={busy || !isRunning} onClick={() => act('restart', 'SSH sessions and websites drop for a few seconds while it boots again.')}><Icon name="refresh" size={14} /> Restart</button>
      <button type="button" className="btn btn--danger" disabled={busy || !isRunning} onClick={() => act('stop', 'SSH and websites on this server stop until it is started again.')}><Icon name="stop" size={14} /> Stop</button>
      {admin && c.status !== 'Frozen' && <button type="button" className="btn" disabled={busy || !isRunning} onClick={() => act('freeze', 'Pausing freezes every process in the server. Nothing runs until you resume it.')}><Icon name="pause" size={14} /> Pause</button>}
      {admin && c.status === 'Frozen' && <button type="button" className="btn" disabled={busy} onClick={() => act('unfreeze')}><Icon name="play" size={14} /> Resume</button>}
      {isRunning && <a className="btn" href={href(`terminal/${c.name}`)}><Icon name="terminal" size={14} /> Terminal</a>}
    </div>
  );
}

function OverviewTab({ c, d, admin }) {
  const run = c.status === 'Running';
  const live = (c.history || []).map((p) => ({ t: p.t, cpu: p.cpu, mem: p.mem }));
  const lim = c.limits || {};
  return (
    <>
      <div className="kpis">
        <Stat label="CPU" icon="cpu" value={run ? `${c.cpu}%` : '–'} sub={`${lim.cpu ? `${lim.cpu} core limit` : 'no CPU limit'}`}><Bar value={c.cpu} /></Stat>
        <Stat label="Memory" icon="memory" value={run ? bytes(c.memUsed) : '–'} sub={`of ${bytes(c.memTotal)}`}><Bar value={pct(c.memUsed, c.memTotal)} /></Stat>
        <Stat label="Disk" icon="storage" value={bytes(c.diskUsed)} sub={c.diskTotal ? `of ${bytes(c.diskTotal)}` : 'no disk quota'}><Bar value={pct(c.diskUsed, c.diskTotal)} /></Stat>
        <Stat label="Network" icon="network" value={run ? `↓ ${bytes(c.rx)}/s` : '–'} sub={run ? `↑ ${bytes(c.tx)}/s · total ↓${bytes(c.rxTotal)} ↑${bytes(c.txTotal)}` : ''} />
      </div>
      <div className="grid2">
        <Card title="Details">
          <dl className="facts">
            <div><dt>Status</dt><dd>{c.status}{run && c.startedAt ? ` · up ${uptime((Date.now() - c.startedAt) / 1000)}` : ''}</dd></div>
            <div><dt>IP address</dt><dd>{c.ip || '–'} {c.ip && <Copy text={c.ip} />}</dd></div>
            <div><dt>SSH hostname</dt><dd><code>{c.ssh}</code> <Copy text={`ssh root@${c.ssh}`} /></dd></div>
            <div><dt>Image</dt><dd>{c.image || '–'}</dd></div>
            <div><dt>Processes</dt><dd>{c.processes ?? '–'}</dd></div>
            <div><dt>Network limits</dt><dd>{lim.ingress || lim.egress ? `↓ ${lim.ingress || '∞'} · ↑ ${lim.egress || '∞'}` : 'none'}</dd></div>
            {admin && <div><dt>Owners</dt><dd>{(c.owners || []).join(', ') || 'none'}</dd></div>}
            {d?.facts?.createdAt && <div><dt>Created</dt><dd>{dateTime(d.facts.createdAt)}</dd></div>}
            {admin && <div><dt>Security</dt><dd>
              <Badge tone={d?.facts?.privileged ? 'bad' : 'good'}>{d?.facts?.privileged ? 'privileged' : 'unprivileged'}</Badge>{' '}
              {d?.facts?.nesting && <Badge tone="warn">nesting</Badge>}{' '}
              {d?.meta?.protected && <Badge tone="info"><Icon name="lock" size={12} /> protected</Badge>}
            </dd></div>}
          </dl>
        </Card>
        <Card title="Live CPU and memory" sub="Last hour">
          <TimeChart data={live} series={[{ key: 'cpu', name: 'CPU', color: 's1' }, { key: 'mem', name: 'Memory', color: 's2' }]} unit="%" domain={[0, 100]} />
        </Card>
      </div>
      <Card title="History"><HistoryChart scope={`ct:${c.name}`} /></Card>
    </>
  );
}

function SnapshotsTab({ c, d, reload, busy }) {
  const run = useAction();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const snaps = [...(d?.snapshots || [])].sort((a, b) => b.createdAt - a.createdAt);
  async function create(e) {
    e.preventDefault();
    if (await run(() => api(`/api/containers/${c.name}/snapshots`, { method: 'POST', body: name ? { name } : {} }), 'Snapshot started')) setName('');
  }
  async function restore(s) {
    const typed = await confirm({
      title: `Restore ${s.name}?`, danger: true, typed: s.name, confirmLabel: 'Restore',
      body: <p>The server goes back to how it was at {dateTime(s.createdAt)}. Everything written since is replaced. A safety snapshot of the current state is taken first, so this can be undone.</p>,
    });
    if (typed) await run(() => api(`/api/containers/${c.name}/snapshots/${encodeURIComponent(s.name)}/restore`, { method: 'POST', body: { confirm: typed } }));
  }
  async function remove(s) {
    if (await confirm({ title: `Delete snapshot ${s.name}?`, body: 'This frees its space. It cannot be undone.', danger: true, confirmLabel: 'Delete' })) {
      await run(() => api(`/api/containers/${c.name}/snapshots/${encodeURIComponent(s.name)}`, { method: 'DELETE' }));
    }
  }
  useEffect(() => { if (!busy) reload(); }, [busy]);
  return (
    <Card title="Snapshots" sub="Point-in-time copies stored next to the server. Fast to take and restore. For off-disk copies see Backups.">
      <form className="inline-form" onSubmit={create}>
        <input placeholder="Snapshot name (optional)" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,62}" />
        <button type="submit" className="btn btn--primary" disabled={busy}><Icon name="camera" size={14} /> Take snapshot</button>
      </form>
      {snaps.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Taken</th><th className="num">Actions</th></tr></thead>
          <tbody>{snaps.map((s) => (
            <tr key={s.name}>
              <td><Icon name="camera" size={14} /> {s.name}</td>
              <td className="muted">{dateTime(s.createdAt)} ({ago(s.createdAt)})</td>
              <td className="num"><span className="row-actions">
                <button type="button" className="btn btn--small" disabled={busy} onClick={() => restore(s)}>Restore</button>
                <button type="button" className="btn btn--small btn--danger" disabled={busy} onClick={() => remove(s)}>Delete</button>
              </span></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty icon="camera" title="No snapshots yet">Take one before risky changes like upgrades.</Empty>}
    </Card>
  );
}

function AppsTab({ c }) {
  const pm2 = useApi(c.status === 'Running' ? `/api/servers/${c.name}/pm2` : null, { interval: 15000 });
  if (c.status !== 'Running') return <Card><Empty icon="app" title="Server is not running">Start it to see its processes.</Empty></Card>;
  return (
    <Card title="PM2 processes" sub="Everything PM2 runs inside this server" actions={<a className="btn btn--small btn--primary" href={href('apps')}>Manage applications</a>}>
      {pm2.error && <ErrorNote error={pm2.error} />}
      {!pm2.data ? <SkeletonRows /> : !pm2.data.installed ? <Note>PM2 is not installed in this server yet. Create an application and use “Install runtime”.</Note>
        : pm2.data.processes.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Status</th><th className="num">CPU</th><th className="num">Memory</th><th className="num">Restarts</th><th className="num">Up since</th></tr></thead>
            <tbody>{pm2.data.processes.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td><Badge tone={p.status === 'online' ? 'good' : p.status === 'errored' ? 'bad' : 'warn'} dot>{p.status}</Badge></td>
                <td className="num">{p.cpu}%</td><td className="num">{bytes(p.memory)}</td><td className="num">{p.restarts}</td>
                <td className="num muted">{p.uptime ? ago(p.uptime) : '–'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="app" title="No PM2 processes" />}
    </Card>
  );
}

function LogsTab({ c, admin }) {
  const { data, error, reload, loading } = useApi(`/api/containers/${c.name}/logs`);
  const [which, setWhich] = useState('console');
  return (
    <Card title="Logs" actions={<button type="button" className="btn btn--small" onClick={reload} disabled={loading}><Icon name="refresh" size={14} /> Refresh</button>}>
      {admin && <div className="seg seg--small mb12">
        <button type="button" aria-pressed={which === 'console'} onClick={() => setWhich('console')}>Console (boot output)</button>
        <button type="button" aria-pressed={which === 'lxc'} onClick={() => setWhich('lxc')}>LXD instance log</button>
      </div>}
      <ErrorNote error={error} />
      {!data ? <SkeletonRows /> : <pre className="log log--tall">{(which === 'lxc' ? data.lxc : data.console) || 'Empty.'}</pre>}
      <p className="muted small">Application logs are on the Applications page. System logs inside the server: <code>journalctl -e</code> in the terminal.</p>
    </Card>
  );
}

function ResourcesTab({ c, busy }) {
  const run = useAction();
  const [f, setF] = useState(null);
  const [check, setCheck] = useState(null);
  const [warn, setWarn] = useState(null);
  useEffect(() => {
    const l = c.limits || {};
    setF({
      cpu: l.cpu || 1, memoryMiB: l.memory ? Math.round(l.memory / MiB) : 1024, diskGiB: l.disk ? Math.round(l.disk / GiB) : Math.max(10, Math.ceil(c.diskUsed / GiB) + 5),
      ingressMbit: parseInt(l.ingress, 10) || '', egressMbit: parseInt(l.egress, 10) || '',
    });
  }, [c.name]);
  useEffect(() => {
    if (!f) return undefined;
    const t = setTimeout(() => api('/api/allocation/check', { method: 'POST', body: { cpu: Number(f.cpu), memoryMiB: Number(f.memoryMiB), diskGiB: Number(f.diskGiB), exclude: c.name } })
      .then(setCheck, (e) => setCheck({ ok: false, errors: [e.message], warnings: [] })), 300);
    return () => clearTimeout(t);
  }, [f?.cpu, f?.memoryMiB, f?.diskGiB]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e, acceptWarnings = false) {
    e?.preventDefault();
    try {
      await api(`/api/containers/${c.name}/resources`, { method: 'PUT', body: { ...f, cpu: Number(f.cpu), memoryMiB: Number(f.memoryMiB), diskGiB: Number(f.diskGiB), ingressMbit: f.ingressMbit || undefined, egressMbit: f.egressMbit || undefined, acceptWarnings } });
      setWarn(null);
    } catch (err) {
      if (err.data?.needsConfirm) setWarn(err.data.warnings);
      else await run(() => Promise.reject(err));
    }
  }
  return (
    <Card title="Resources" sub="CPU and memory limits apply immediately. Disk can only grow. Network limits apply to the server's network card.">
      <form className="form" onSubmit={save}>
        <div className="fgrid">
          <Field label="CPU cores"><input type="number" min={1} required value={f.cpu} onChange={set('cpu')} /></Field>
          <Field label="Memory (MiB)" hint={`${(f.memoryMiB / 1024).toFixed(2)} GiB`}><input type="number" min={128} step={128} required value={f.memoryMiB} onChange={set('memoryMiB')} /></Field>
          <Field label="Disk (GiB)" hint={`${bytes(c.diskUsed)} used now`}><input type="number" min={1} required value={f.diskGiB} onChange={set('diskGiB')} /></Field>
          <Field label="Download limit (Mbit/s)" hint="Empty = unlimited"><input type="number" min={1} value={f.ingressMbit} onChange={set('ingressMbit')} /></Field>
          <Field label="Upload limit (Mbit/s)" hint="Empty = unlimited"><input type="number" min={1} value={f.egressMbit} onChange={set('egressMbit')} /></Field>
        </div>
        {check && !check.ok && <Note tone="bad">{check.errors.map((x) => <div key={x}>{x}</div>)}</Note>}
        {check?.ok && check.warnings.length > 0 && <Note tone="warn">{check.warnings.map((x) => <div key={x}>{x}</div>)}</Note>}
        {warn && <Note tone="warn"><strong>Please confirm:</strong>{warn.map((x) => <div key={x}>{x}</div>)}
          <button type="button" className="btn btn--small btn--primary mt8" onClick={() => save(null, true)}>Apply anyway</button></Note>}
        <div><button type="submit" className="btn btn--primary" disabled={busy || (check && !check.ok)}>Apply limits</button></div>
      </form>
    </Card>
  );
}

function SettingsTab({ c, d, reload, busy }) {
  const { me } = useLive();
  const run = useAction();
  const confirm = useConfirm();
  const users = useApi('/api/users');
  const images = useApi('/api/images');
  const [owners, setOwners] = useState(null);
  const [ip, setIp] = useState('');
  const [notes, setNotes] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [newName, setNewName] = useState('');
  const [image, setImage] = useState('ubuntu-24.04');
  const sup = me.role === 'super_admin';
  useEffect(() => { setIp(d?.facts?.nic?.fixedIp || ''); setNotes(d?.meta?.notes || ''); }, [d]);
  useEffect(() => { if (users.data) setOwners(users.data.users.filter((u) => (c.owners || []).includes(u.username)).map((u) => u.id)); }, [users.data, c.name]);
  const isProtected = !!d?.meta?.protected;
  const stopped = c.status === 'Stopped';

  const saveOwners = () => run(() => api(`/api/containers/${c.name}/owners`, { method: 'PUT', body: { userIds: owners } }), 'Owners saved');
  const saveIp = async () => {
    if (await confirm({ title: ip ? `Set IP to ${ip}?` : 'Remove the fixed IP?', body: 'It takes effect after the next restart. Domains pointing at this server follow the new IP automatically.' })) {
      await run(() => api(`/api/containers/${c.name}/ip`, { method: 'PUT', body: { ip: ip || null } }));
    }
  };
  const protect = async (on) => {
    const typed = on ? true : await confirm({ title: `Remove protection from ${c.name}?`, typed: c.name, danger: true, confirmLabel: 'Remove protection', body: 'Without protection a super admin can delete or rebuild it.' });
    if (typed) { await run(() => api(`/api/containers/${c.name}/protection`, { method: 'PUT', body: { protected: on, confirm: typed === true ? undefined : typed } }), on ? 'Protected' : 'Protection removed'); reload(); }
  };
  const clone = () => run(() => api(`/api/containers/${c.name}/clone`, { method: 'POST', body: { newName: cloneName } }), `Cloning to ${cloneName}`);
  const rename = async () => {
    const typed = await confirm({ title: `Rename ${c.name} to ${newName}?`, typed: c.name, confirmLabel: 'Rename', body: 'The hostname changes. Users, apps and domains follow. Older backups stay under the old name.' });
    if (typed && await run(() => api(`/api/containers/${c.name}/rename`, { method: 'POST', body: { newName, confirm: typed } }))) setTimeout(() => go(`servers/${newName}`), 1500);
  };
  const rebuild = async () => {
    const typed = await confirm({ title: `Rebuild ${c.name}?`, typed: c.name, danger: true, confirmLabel: 'Rebuild', body: <p>The server's disk is replaced by a fresh <b>{image}</b> install. A snapshot of the current state is taken first. Everything else on the disk is lost.</p> });
    if (typed) await run(() => api(`/api/containers/${c.name}/rebuild`, { method: 'POST', body: { image, confirm: typed } }));
  };
  const del = async () => {
    const typed = await confirm({ title: `Delete ${c.name}?`, typed: c.name, danger: true, confirmLabel: 'Delete forever', body: <p>The server, its disk and its snapshots are deleted. Backups on /mnt/backup are kept. {c.status === 'Running' && 'It will be stopped first.'}</p> });
    if (typed && await run(() => api(`/api/containers/${c.name}`, { method: 'DELETE', body: { confirm: typed, stopFirst: true } }))) setTimeout(() => go('servers'), 1500);
  };

  return (
    <>
      <div className="grid2">
        <Card title="Owners" sub="Users who see this server in their dashboard">
          {!users.data || !owners ? <SkeletonRows rows={2} /> : (
            <>
              <div className="checks">{users.data.users.filter((u) => u.role === 'user').map((u) => (
                <label key={u.id} className="check"><input type="checkbox" checked={owners.includes(u.id)}
                  onChange={(e) => setOwners(e.target.checked ? [...owners, u.id] : owners.filter((x) => x !== u.id))} /> {u.username}</label>
              ))}</div>
              <button type="button" className="btn btn--primary mt12" onClick={saveOwners}>Save owners</button>
            </>
          )}
        </Card>
        <Card title="Fixed IP address" sub={`Current: ${c.ip || 'none'}${d?.facts?.nic?.network ? ` on ${d.facts.nic.network}` : ''}`}>
          <div className="inline-form">
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="Empty = DHCP" />
            <button type="button" className="btn btn--primary" disabled={busy} onClick={saveIp}>Save</button>
          </div>
        </Card>
      </div>
      <div className="grid2">
        <Card title="Clone" sub="Copy this server (without snapshots). The copy is stopped, has no fixed IP and no owner.">
          <div className="inline-form">
            <input value={cloneName} onChange={(e) => setCloneName(e.target.value.toLowerCase())} placeholder="new-server-name" />
            <button type="button" className="btn" disabled={busy || !cloneName} onClick={clone}><Icon name="copy" size={14} /> Clone</button>
          </div>
        </Card>
        <Card title="Notes" sub="Visible to admins only">
          <textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          <button type="button" className="btn btn--small mt8" onClick={() => run(() => api(`/api/containers/${c.name}/notes`, { method: 'PUT', body: { notes } }), 'Notes saved')}>Save notes</button>
        </Card>
      </div>
      {sup && (
        <Card title="Danger zone" className="danger" sub={isProtected ? 'Protected: delete and rebuild are blocked.' : 'These actions destroy data.'}>
          <div className="danger__row">
            <div><strong>Protection</strong><p className="muted small">Blocks delete and rebuild. Servers that existed before Kapil Cloud start protected.</p></div>
            {isProtected ? <button type="button" className="btn btn--danger" onClick={() => protect(false)}><Icon name="lock" size={14} /> Remove protection</button>
              : <button type="button" className="btn" onClick={() => protect(true)}><Icon name="lock" size={14} /> Protect</button>}
          </div>
          <div className="danger__row">
            <div><strong>Rename (hostname)</strong><p className="muted small">The server must be stopped.</p></div>
            <div className="inline-form"><input value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase())} placeholder="new-name" />
              <button type="button" className="btn" disabled={busy || !stopped || !newName} onClick={rename}>Rename</button></div>
          </div>
          <div className="danger__row">
            <div><strong>Rebuild</strong><p className="muted small">Fresh operating system, same name, limits and IP.</p></div>
            <div className="inline-form">
              <select value={image} onChange={(e) => setImage(e.target.value)}>{(images.data?.images || []).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>
              <button type="button" className="btn btn--danger" disabled={busy || isProtected} onClick={rebuild}>Rebuild</button>
            </div>
          </div>
          <div className="danger__row">
            <div><strong>Delete server</strong><p className="muted small">Remove its domains first.</p></div>
            <button type="button" className="btn btn--danger" disabled={busy || isProtected} onClick={del}><Icon name="trash" size={14} /> Delete</button>
          </div>
        </Card>
      )}
    </>
  );
}

export default function ServerDetail({ name, tab }) {
  const { me, cts, jobs } = useLive();
  const c = cts[name];
  const job = jobs[name];
  const busy = job?.status === 'running';
  const { data: d, error, reload } = useApi(`/api/containers/${encodeURIComponent(name)}`);
  useEffect(() => { if (job && job.status !== 'running') reload(); }, [job?.status, job?.id]);

  if (!c) {
    return (
      <>
        <PageHeader title={name} back={href('servers')} />
        {busy ? <Note>{job.action} in progress: {job.message || 'working…'}</Note>
          : error ? <ErrorNote error={error} /> : <Card><Empty icon="server" title="Server not found">It may have been renamed or deleted, or you may not have access.</Empty></Card>}
      </>
    );
  }

  const admin = me.isAdmin;
  const tabs = [['overview', 'Overview'], ['snapshots', 'Snapshots'], ['apps', 'Apps'], ['logs', 'Logs']];
  if (admin) tabs.push(['resources', 'Resources'], ['settings', 'Settings']);
  const current = tabs.some(([id]) => id === tab) ? tab : 'overview';

  return (
    <>
      <PageHeader back={href('servers')}
        title={<span className="title-with-badge">{name} <ServerStatus status={c.status} busy={busy ? `${job.action}…` : null} /></span>}
        sub={`${c.image || 'Linux container'}${c.ip ? ` · ${c.ip}` : ''}${admin && c.owners?.length ? ` · owner ${c.owners.join(', ')}` : ''}`}
        actions={<PowerButtons c={c} admin={admin} busy={busy} />} />
      {busy && <Note>{job.action} in progress{job.message ? `: ${job.message}` : '…'}</Note>}
      {job?.status === 'failure' && <ErrorNote error={`${job.action} failed: ${job.message}`} />}
      <Tabs tabs={tabs} value={current} hrefFor={(id) => href(`servers/${name}/${id}`)} />
      {current === 'overview' && <OverviewTab c={c} d={d} admin={admin} />}
      {current === 'snapshots' && <SnapshotsTab c={c} d={d} reload={reload} busy={busy} />}
      {current === 'apps' && <AppsTab c={c} />}
      {current === 'logs' && <LogsTab c={c} admin={admin} />}
      {current === 'resources' && admin && <ResourcesTab c={c} busy={busy} />}
      {current === 'settings' && admin && <SettingsTab c={c} d={d} reload={reload} busy={busy} />}
    </>
  );
}
