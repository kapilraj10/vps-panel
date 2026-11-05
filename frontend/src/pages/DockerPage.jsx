// Docker Manager: containers (with live CPU/RAM), images, volumes, networks, Compose projects on this server.
import { useState } from 'react';
import { api, bytes, ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, SkeletonRows, ErrorNote, Field, Icon, Tabs, Note, Stat, useApi, useAction, useConfirm } from '../ui.jsx';
import { LogDialog } from './Pm2Page.jsx';

const TONE = { running: 'good', exited: 'neutral', created: 'neutral', paused: 'warn', restarting: 'warn', dead: 'bad' };

function NewContainer({ onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', image: '', hostPort: '', containerPort: '', volume: '', mount: '', memoryMb: '', cpus: '', restart: 'unless-stopped', env: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    const body = {
      name: f.name, image: f.image, restart: f.restart, env: f.env,
      ports: f.hostPort ? [{ host: Number(f.hostPort), container: Number(f.containerPort) }] : [],
      volumes: f.volume ? [{ source: f.volume, target: f.mount }] : [],
      memoryMb: f.memoryMb ? Number(f.memoryMb) : undefined, cpus: f.cpus || undefined,
    };
    if (await run(() => api('/api/docker/containers', { method: 'POST', body }), `Container ${f.name} started`)) { onDone(); onClose(); }
  }
  return (
    <Dialog open title="Create container" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
          <Field label="Image" hint="Pulled first"><input required value={f.image} onChange={set('image')} placeholder="postgres:16-alpine" /></Field>
          <Field label="Host port" hint="Bound to 127.0.0.1 only"><input type="number" min={1024} max={65535} value={f.hostPort} onChange={set('hostPort')} /></Field>
          <Field label="Container port"><input type="number" min={1} max={65535} value={f.containerPort} onChange={set('containerPort')} required={!!f.hostPort} /></Field>
          <Field label="Named volume" hint="Host folders cannot be mounted"><input value={f.volume} onChange={set('volume')} placeholder="pgdata" /></Field>
          <Field label="Mount path"><input value={f.mount} onChange={set('mount')} placeholder="/var/lib/postgresql/data" required={!!f.volume} /></Field>
          <Field label="Memory limit (MB)"><input type="number" min={16} value={f.memoryMb} onChange={set('memoryMb')} /></Field>
          <Field label="CPUs"><input type="number" step="0.1" min={0.1} value={f.cpus} onChange={set('cpus')} /></Field>
          <Field label="Restart policy"><select value={f.restart} onChange={set('restart')}>{['unless-stopped', 'always', 'on-failure', 'no'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        </div>
        <Field label="Environment" hint="KEY=value per line. Values are never shown again." wide><textarea className="textarea mono" rows={4} value={f.env} onChange={set('env')} spellCheck={false} /></Field>
        <Note>Containers are never privileged, get <code>no-new-privileges</code>, and publish ports on 127.0.0.1 only. Expose them through a domain (Nginx / Cloudflare Tunnel).</Note>
        <div className="dialog__buttons"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn--primary">Create</button></div>
      </form>
    </Dialog>
  );
}

function Inspect({ id, onClose }) {
  const { data, error } = useApi(`/api/docker/containers/${id}`);
  const c = data?.container;
  return (
    <Dialog open title={c ? c.name : 'Container'} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!c ? <SkeletonRows /> : (
        <dl className="kv">
          <dt>Image</dt><dd className="mono">{c.image}</dd>
          <dt>State</dt><dd>{c.state.Status}{c.health ? ` · health ${c.health}` : ''} · restarts {c.restartCount}</dd>
          <dt>Created</dt><dd>{dateTime(c.createdAt)}</dd>
          <dt>Restart policy</dt><dd>{c.restartPolicy || 'no'}</dd>
          <dt>Limits</dt><dd>{c.memoryLimit ? bytes(c.memoryLimit) : 'no memory limit'} · {c.nanoCpus ? `${c.nanoCpus / 1e9} CPU` : 'no CPU limit'}{c.privileged ? ' · PRIVILEGED' : ''}</dd>
          <dt>Command</dt><dd className="mono">{[...(c.entrypoint || []), ...(c.cmd || [])].join(' ') || '(image default)'}</dd>
          <dt>Networks</dt><dd>{c.networks.join(', ')}</dd>
          <dt>Mounts</dt><dd className="mono">{c.mounts.map((m) => `${m.source} → ${m.target}${m.rw ? '' : ' (ro)'}`).join(', ') || 'none'}</dd>
          <dt>Env (names)</dt><dd className="mono">{c.envKeys.join(', ') || 'none'}</dd>
        </dl>
      )}
      <div className="dialog__buttons"><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function Containers({ sup }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/docker/containers', { interval: 5000 });
  const stats = useApi('/api/docker/stats', { interval: 10000 });
  const [q, setQ] = useState('');
  const [logs, setLogs] = useState(null);
  const [inspect, setInspect] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = (data?.containers || []).filter((c) => !q || `${c.name} ${c.image} ${c.compose || ''}`.toLowerCase().includes(q.toLowerCase()));
  const act = async (c, a) => { if (await run(() => api(`/api/docker/containers/${c.id}/${a}`, { method: 'POST' }), `${c.name}: ${a} done`)) reload(); };
  async function remove(c) {
    const typed = await confirm({ title: `Remove ${c.name}?`, body: 'The container is deleted (forced if running). Named volumes are kept.', typed: c.name, danger: true, confirmLabel: 'Remove' });
    if (typed && await run(() => api(`/api/docker/containers/${c.id}`, { method: 'DELETE', body: { confirm: typed, force: true } }), `${c.name} removed`)) reload();
  }
  const s = stats.data?.stats || {};
  return (
    <Card pad={false} title="Containers" actions={<><input className="filter" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />{sup && <button type="button" className="btn btn--primary btn--small" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New</button>}</>}>
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error && <div className="pad"><SkeletonRows /></div>}
      {data && !list.length && <Empty icon="app" title="No containers" />}
      {list.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Image</th><th>State</th><th>CPU</th><th>Memory</th><th>Ports</th><th>Created</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong> {c.managedApp && <Badge tone="info">replica</Badge>} {c.compose && <Badge>{c.compose}</Badge>}</td>
                  <td className="mono small">{c.image}</td>
                  <td><Badge tone={TONE[c.state] || 'neutral'} dot>{c.state}</Badge><br /><small className="muted">{c.status}</small></td>
                  <td>{s[c.id] ? `${s[c.id].cpu}%` : '–'}</td>
                  <td>{s[c.id] ? `${bytes(s[c.id].memory)}${s[c.id].memoryLimit && s[c.id].memoryLimit < 1e12 ? ` / ${bytes(s[c.id].memoryLimit)}` : ''}` : '–'}</td>
                  <td className="mono small">{c.ports.map((p) => `${p.ip || '0.0.0.0'}:${p.host}→${p.container}`).join(', ') || '–'}</td>
                  <td>{ago(c.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn--small" onClick={() => setLogs(c)}>Logs</button>
                      <button type="button" className="btn btn--small" onClick={() => setInspect(c.id)}>Inspect</button>
                      {sup && (c.state === 'running'
                        ? <><button type="button" className="btn btn--small" onClick={() => act(c, 'restart')}>Restart</button><button type="button" className="btn btn--small" onClick={() => act(c, 'stop')}>Stop</button></>
                        : <button type="button" className="btn btn--small" onClick={() => act(c, 'start')}>Start</button>)}
                      {sup && !c.managedApp && <button type="button" className="btn btn--small btn--danger" onClick={() => remove(c)}>Remove</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {logs && <LogDialog title={`Logs: ${logs.name}`} url={`/api/docker/containers/${logs.id}/logs?tail=300`} onClose={() => setLogs(null)} />}
      {inspect && <Inspect id={inspect} onClose={() => setInspect(null)} />}
      {creating && <NewContainer onClose={() => setCreating(false)} onDone={reload} />}
    </Card>
  );
}

function Images({ sup }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi('/api/docker/images');
  const [pull, setPull] = useState('');
  const [build, setBuild] = useState({ tag: '', context: '' });
  const [busy, setBusy] = useState('');
  async function doPull(e) {
    e.preventDefault();
    setBusy('pull');
    if (await run(() => api('/api/docker/images/pull', { method: 'POST', body: { image: pull } }), `Pulled ${pull}`)) { setPull(''); reload(); }
    setBusy('');
  }
  async function doBuild(e) {
    e.preventDefault();
    setBusy('build');
    if (await run(() => api('/api/docker/images/build', { method: 'POST', body: build }), `Built ${build.tag}`)) reload();
    setBusy('');
  }
  async function remove(i) {
    const ref = i.tags[0] || i.id;
    const typed = await confirm({ title: `Remove image ${ref}?`, typed: ref, danger: true, confirmLabel: 'Remove' });
    if (typed && await run(() => api(`/api/docker/images/${encodeURIComponent(ref)}`, { method: 'DELETE', body: { confirm: typed } }), 'Image removed')) reload();
  }
  return (
    <>
      {sup && (
        <div className="grid2">
          <Card title="Pull image"><form className="inline-form" onSubmit={doPull}><input required value={pull} onChange={(e) => setPull(e.target.value)} placeholder="node:22-alpine" /><button type="submit" className="btn btn--primary" disabled={busy === 'pull'}>{busy === 'pull' ? 'Pulling…' : 'Pull'}</button></form></Card>
          <Card title="Build image" sub="docker build from a folder inside HOST_APP_ROOTS"><form className="inline-form" onSubmit={doBuild}><input required value={build.tag} onChange={(e) => setBuild({ ...build, tag: e.target.value })} placeholder="pos:2026-11-05" /><input required value={build.context} onChange={(e) => setBuild({ ...build, context: e.target.value })} placeholder="/home/kapil/apps/pos" /><button type="submit" className="btn btn--primary" disabled={busy === 'build'}>{busy === 'build' ? 'Building…' : 'Build'}</button></form></Card>
        </div>
      )}
      <Card pad={false} title="Images">
        <ErrorNote error={error} onRetry={reload} />
        {!data && !error && <div className="pad"><SkeletonRows /></div>}
        {data && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Tags</th><th>ID</th><th>Size</th><th>Created</th><th /></tr></thead>
            <tbody>{data.images.map((i) => (
              <tr key={i.id}><td className="mono small">{i.tags.join(', ') || '<none>'}</td><td className="mono small">{i.id}</td><td>{bytes(i.size)}</td><td>{ago(i.createdAt)}</td>
                <td>{sup && <button type="button" className="btn btn--small btn--danger" onClick={() => remove(i)}>Remove</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

function Simple({ kind, sup }) {
  const run = useAction();
  const confirm = useConfirm();
  const { data, error, reload } = useApi(`/api/docker/${kind}`);
  const [name, setName] = useState('');
  const rows = data?.[kind] || [];
  async function create(e) {
    e.preventDefault();
    if (await run(() => api(`/api/docker/${kind}`, { method: 'POST', body: { name } }), `Created ${name}`)) { setName(''); reload(); }
  }
  async function remove(x) {
    const typed = await confirm({ title: `Remove ${kind === 'volumes' ? 'volume' : 'network'} ${x.name}?`, body: kind === 'volumes' ? 'All data in this volume is deleted. Back it up first.' : null, typed: x.name, danger: true, confirmLabel: 'Remove' });
    if (typed && await run(() => api(`/api/docker/${kind}/${kind === 'volumes' ? x.name : x.id}`, { method: 'DELETE', body: { confirm: typed } }), `${x.name} removed`)) reload();
  }
  return (
    <Card pad={false} title={kind === 'volumes' ? 'Volumes' : 'Networks'}
      actions={sup && <form className="inline-form" onSubmit={create}><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="name" /><button type="submit" className="btn btn--small btn--primary">Create</button></form>}>
      <ErrorNote error={error} onRetry={reload} />
      {!data && !error && <div className="pad"><SkeletonRows /></div>}
      {data && !rows.length && <Empty title={`No ${kind}`} />}
      {rows.length > 0 && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th>{kind === 'volumes' ? <><th>Size</th><th>In use by</th><th>Project</th></> : <><th>Driver</th><th>Subnet</th><th>Scope</th></>}<th /></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.name}>
              <td className="mono">{x.name}</td>
              {kind === 'volumes' ? <><td>{x.size != null ? bytes(x.size) : '–'}</td><td>{x.refs ?? '–'}</td><td>{x.compose || '–'}</td></> : <><td>{x.driver}</td><td className="mono">{x.subnet || '–'}</td><td>{x.scope}</td></>}
              <td>{sup && !['bridge', 'host', 'none'].includes(x.name) && <button type="button" className="btn btn--small btn--danger" onClick={() => remove(x)}>Remove</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function Compose({ sup }) {
  const run = useAction();
  const { data, error, reload } = useApi('/api/docker/compose', { interval: 10000 });
  const act = async (p, a) => { if (await run(() => api(`/api/docker/compose/${p.name}/${a}`, { method: 'POST', body: { dir: p.dir } }), `${p.name}: ${a} done`)) reload(); };
  return (
    <Card pad={false} title="Compose projects" sub="Grouped by Docker Compose labels">
      <ErrorNote error={error} onRetry={reload} />
      {data && !data.projects.length && <Empty title="No Compose projects running" />}
      {data?.projects.length > 0 && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Project</th><th>Folder</th><th>Services</th><th /></tr></thead>
          <tbody>{data.projects.map((p) => (
            <tr key={p.name}>
              <td><strong>{p.name}</strong><br /><small className="muted">{p.running}/{p.total} running</small></td>
              <td className="mono small">{p.dir || '–'}</td>
              <td>{p.services.map((s) => <Badge key={s.id} tone={TONE[s.state] || 'neutral'} dot>{s.service}</Badge>)}</td>
              <td>{sup && <div className="row-actions">
                {['start', 'restart', 'stop'].map((a) => <button key={a} type="button" className="btn btn--small" onClick={() => act(p, a)}>{a[0].toUpperCase() + a.slice(1)}</button>)}
                {p.dir && <button type="button" className="btn btn--small" title="docker compose pull && up -d" onClick={() => run(() => api(`/api/docker/compose/${p.name}/up`, { method: 'POST', body: { dir: p.dir, pull: true } }), `${p.name} updated`).then(reload)}>Pull & up</button>}
              </div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

export default function DockerPage() {
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const [tab, setTab] = useState('containers');
  const info = useApi('/api/docker/info', { interval: 15000 });
  const i = info.data;
  return (
    <>
      <PageHeader title="Docker Manager" sub="Containers, images, volumes and networks on this server" />
      {info.error ? <ErrorNote error={info.error} onRetry={info.reload} /> : (
        <div className="kpis">
          <Stat label="Docker" icon="app" value={i ? i.version : null} sub={i ? `API ${i.api} · ${i.driver}` : ''} />
          <Stat label="Containers" icon="server" value={i ? i.containers : null} sub={i ? `${i.running} running` : ''} />
          <Stat label="Images" icon="storage" value={i ? i.images : null} />
          <Stat label="Swarm" icon="network" value={i ? i.swarm : null} sub="not needed on a single node" />
        </div>
      )}
      <Tabs tabs={[['containers', 'Containers'], ['images', 'Images'], ['volumes', 'Volumes'], ['networks', 'Networks'], ['compose', 'Compose']]} value={tab} onChange={setTab} />
      {tab === 'containers' && <Containers sup={sup} />}
      {tab === 'images' && <Images sup={sup} />}
      {tab === 'volumes' && <Simple kind="volumes" sup={sup} />}
      {tab === 'networks' && <Simple kind="networks" sup={sup} />}
      {tab === 'compose' && <Compose sup={sup} />}
    </>
  );
}
