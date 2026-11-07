import { useEffect, useState } from 'react';
import { api, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Empty, Icon, Field, Note, useToast, go } from '../ui.jsx';
import { ServerRow } from './Overview.jsx';

const blank = { name: '', image: 'ubuntu-24.04', cpu: 1, memoryMiB: 1024, diskGiB: 20, ownerId: '', ip: '', ingressMbit: '', egressMbit: '', start: true, count: 1 };
const noStack = { pm2: false, docker: false, cloudflared: false, tunnelToken: '' };

export function CreateServer({ open, onClose }) {
  const toast = useToast();
  const { me } = useLive();
  const sup = me.role === 'super_admin';
  const [f, setF] = useState(blank);
  const [st, setSt] = useState(noStack);
  const [images, setImages] = useState([]);
  const [owners, setOwners] = useState([]);
  const [check, setCheck] = useState(null);
  const [warn, setWarn] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF(blank);
    setSt(noStack);
    setWarn(null);
    api('/api/images').then((d) => setImages(d.images)).catch(() => {});
    api('/api/users').then((d) => setOwners(d.users.filter((u) => u.role === 'user' && u.status === 'active'))).catch(() => {});
  }, [open]);

  // Live allocation check while the form changes
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      api('/api/allocation/check', { method: 'POST', body: { cpu: Number(f.cpu), memoryMiB: Number(f.memoryMiB), diskGiB: Number(f.diskGiB), ownerId: f.ownerId || undefined, count: Number(f.count) || 1 } })
        .then(setCheck, (e) => setCheck({ ok: false, errors: [e.message], warnings: [] }));
    }, 300);
    return () => clearTimeout(t);
  }, [open, f.cpu, f.memoryMiB, f.diskGiB, f.ownerId, f.count]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setS = (k) => (e) => setSt({ ...st, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const count = Math.max(1, Number(f.count) || 1);
  const names = count > 1 ? Array.from({ length: count }, (_, i) => `${f.name || 'name'}-${i + 1}`) : [f.name];
  const components = ['pm2', 'docker', 'cloudflared'].filter((k) => st[k]);

  async function submit(e, acceptWarnings = false) {
    e?.preventDefault();
    setBusy(true);
    try {
      const body = {
        ...f, cpu: Number(f.cpu), memoryMiB: Number(f.memoryMiB), diskGiB: Number(f.diskGiB), ownerId: f.ownerId ? Number(f.ownerId) : undefined,
        ip: f.ip || undefined, ingressMbit: f.ingressMbit || undefined, egressMbit: f.egressMbit || undefined, acceptWarnings, count,
        stack: components.length ? { components, tunnelToken: st.cloudflared && st.tunnelToken.trim() ? st.tunnelToken.trim() : undefined } : undefined,
      };
      if (body.stack) body.start = true;
      await api('/api/containers', { method: 'POST', body });
      toast.info(count > 1 ? `Creating ${names.join(', ')}. Progress shows on each server.` : `Creating ${f.name}. Progress shows on the server page.`);
      onClose();
      go(count > 1 ? 'servers' : `servers/${f.name}`);
    } catch (err) {
      if (err.data?.needsConfirm) setWarn(err.data.warnings);
      else toast.err(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Create server" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="fgrid">
          <Field label="Name (also the hostname)" hint="Lowercase letters, digits and dashes">
            <input required autoFocus value={f.name} onChange={set('name')} pattern="[a-z][a-z0-9\-]{0,61}[a-z0-9]" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Image">
            <select value={f.image} onChange={set('image')}>{images.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>
          </Field>
          <Field label="Owner" hint="The user who gets this server in their dashboard">
            <select value={f.ownerId} onChange={set('ownerId')}>
              <option value="">No owner (admins only)</option>
              {owners.map((u) => <option key={u.id} value={u.id}>{u.username}{u.full_name ? ` (${u.full_name})` : ''}</option>)}
            </select>
          </Field>
          <Field label="CPU cores"><input type="number" min={1} max={64} required value={f.cpu} onChange={set('cpu')} /></Field>
          <Field label="Memory (MiB)" hint={`${(f.memoryMiB / 1024).toFixed(2)} GiB`}><input type="number" min={128} step={128} required value={f.memoryMiB} onChange={set('memoryMiB')} /></Field>
          <Field label="Disk (GiB)"><input type="number" min={1} required value={f.diskGiB} onChange={set('diskGiB')} /></Field>
          <Field label="Fixed IP (optional)" hint="Inside the LXD bridge subnet; empty = DHCP"><input value={f.ip} onChange={set('ip')} placeholder="10.10.10.30" /></Field>
          <Field label="Download limit Mbit/s (optional)"><input type="number" min={1} value={f.ingressMbit} onChange={set('ingressMbit')} /></Field>
          <Field label="Upload limit Mbit/s (optional)"><input type="number" min={1} value={f.egressMbit} onChange={set('egressMbit')} /></Field>
          <Field label="How many servers (replicas)" hint={count > 1 ? `Creates ${names.join(', ')}` : 'More than 1 = identical copies named name-1, name-2…'}>
            <input type="number" min={1} max={5} value={f.count} onChange={set('count')} />
          </Field>
        </div>
        {sup && (
          <fieldset className="stackbox">
            <legend>Ready stack <span className="muted small">(super admin)</span></legend>
            <p className="muted small">Installed inside each new server after it starts, then a snapshot <code>stack-ready-…</code> is taken. Everything runs inside the RAM limit above.</p>
            <label className="check"><input type="checkbox" checked={st.pm2} onChange={setS('pm2')} /> Node.js + PM2 (starts on boot, log rotation)</label>
            <label className="check"><input type="checkbox" checked={st.docker} onChange={setS('docker')} /> Docker + Compose <span className="muted small">(turns on LXD nesting for this server)</span></label>
            <label className="check"><input type="checkbox" checked={st.cloudflared} onChange={setS('cloudflared')} /> Cloudflare Tunnel connector (cloudflared)</label>
            {st.cloudflared && (
              <Field label="Tunnel token (optional)" hint={count > 1 ? 'Same token on every replica = one tunnel with several connectors (failover). Never stored.' : 'From Zero Trust → Tunnels → your tunnel. Never stored by the panel.'}>
                <input type="password" value={st.tunnelToken} onChange={setS('tunnelToken')} autoComplete="off" spellCheck={false} placeholder="eyJhIjoi…" />
              </Field>
            )}
            {st.docker && <Note tone="warn">Docker needs nesting, which weakens isolation a little. Only give such servers to people you trust.</Note>}
          </fieldset>
        )}
        <label className="check"><input type="checkbox" checked={f.start || components.length > 0} disabled={components.length > 0} onChange={set('start')} /> Start it after creating</label>
        {check && !check.ok && <Note tone="bad">{check.errors.map((x) => <div key={x}>{x}</div>)}</Note>}
        {check?.ok && check.warnings.length > 0 && <Note tone="warn">{check.warnings.map((x) => <div key={x}>{x}</div>)}</Note>}
        {check?.ok && !check.warnings.length && <Note tone="info">Fits within the host's capacity.</Note>}
        <p className="muted small">Containers are created unprivileged{st.docker ? '' : ', without nesting'}, with a hard RAM limit and the other limits above. The first server from an image downloads it (a few minutes).</p>
        {warn && (
          <Note tone="warn">
            <strong>Please confirm:</strong>
            {warn.map((x) => <div key={x}>{x}</div>)}
            <button type="button" className="btn btn--small btn--primary mt8" onClick={() => submit(null, true)}>Create anyway</button>
          </Note>
        )}
        <div className="dialog__buttons">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy || (check && !check.ok)}>{busy ? 'Creating…' : count > 1 ? `Create ${count} servers` : 'Create server'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Servers() {
  const { me, cts, jobs } = useLive();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(() => window.location.hash.includes('?new'));
  const list = Object.values(cts)
    .filter((c) => (me.isAdmin || me.containers.includes(c.name)))
    .filter((c) => !q || `${c.name} ${c.ip || ''} ${(c.owners || []).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
    .filter((c) => status === 'all' || (status === 'running' ? c.status === 'Running' : c.status !== 'Running'))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title={me.isAdmin ? 'Servers' : 'My servers'} sub={me.isAdmin ? 'Every LXD container on the master server' : 'Servers assigned to you'}
        actions={me.isAdmin && <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Create server</button>} />
      <div className="filters">
        <div className="input-icon"><Icon name="search" size={16} /><input placeholder="Filter by name, IP or owner" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="seg">
          {['all', 'running', 'stopped'].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s}</button>)}
        </div>
      </div>
      <Card pad={false}>
        {list.length ? list.map((c) => <ServerRow key={c.name} c={c} job={jobs[c.name]} />)
          : <Empty icon="server" title={Object.keys(cts).length ? 'No servers match the filter' : 'No servers yet'}>
            {me.isAdmin ? 'Create a server to get started.' : 'Ask the administrator to assign a server to you.'}
          </Empty>}
      </Card>
      {me.isAdmin && <CreateServer open={creating} onClose={() => { setCreating(false); if (window.location.hash.includes('?new')) go('servers'); }} />}
    </>
  );
}
