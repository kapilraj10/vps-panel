import { useEffect, useState } from 'react';
import { api } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Field, Note, SkeletonRows, ErrorNote, useApi, useAction } from '../ui.jsx';
import { Allocation } from './Overview.jsx';

const GiB = 1024 ** 3;

export default function Settings() {
  const { me } = useLive();
  const run = useAction();
  const { data, error } = useApi('/api/settings');
  const alloc = useApi('/api/allocation');
  const [f, setF] = useState(null);
  useEffect(() => {
    if (data) setF({ ...data.settings, host_memory_reserve_gib: (data.settings.host_memory_reserve / GiB).toFixed(1), allowed_domain_suffixes: data.settings.allowed_domain_suffixes.join(', ') });
  }, [data]);
  const sup = me.role === 'super_admin';
  if (error) return <ErrorNote error={error} />;
  if (!f) return <SkeletonRows />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    const body = {
      cpu_overcommit: Number(f.cpu_overcommit), memory_overcommit: Number(f.memory_overcommit),
      host_memory_reserve: Math.round(Number(f.host_memory_reserve_gib) * GiB), disk_reserve_percent: Number(f.disk_reserve_percent),
      alert_cpu: Number(f.alert_cpu), alert_memory: Number(f.alert_memory), alert_disk: Number(f.alert_disk), alert_temp: Number(f.alert_temp),
      alert_backup_disk_free: Number(f.alert_backup_disk_free), alert_sustain_minutes: Number(f.alert_sustain_minutes),
      terminal_idle_minutes: Number(f.terminal_idle_minutes), terminal_max_minutes: Number(f.terminal_max_minutes),
      allowed_domain_suffixes: f.allowed_domain_suffixes.split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (await run(() => api('/api/settings', { method: 'PUT', body }), 'Settings saved')) alloc.reload();
  }
  return (
    <>
      <PageHeader title="Settings" sub={sup ? 'Platform-wide limits and thresholds' : 'Only a super admin can change these'} />
      <form className="form" onSubmit={save}>
        <fieldset disabled={!sup} className="bk-fieldset">
          <Card title="Resource allocation" sub="Kapil Cloud refuses new servers or bigger limits that go past these. Overcommit lets containers share capacity; it is safe for CPU, risky for memory.">
            <div className="fgrid">
              <Field label="CPU overcommit ratio" hint="1 = never promise more vCPUs than cores. 2 = up to twice as many."><input type="number" min={1} max={8} step={0.25} value={f.cpu_overcommit} onChange={set('cpu_overcommit')} /></Field>
              <Field label="Memory overcommit ratio" hint="Keep at 1 unless you know the workloads. Over 1 can trigger out-of-memory kills."><input type="number" min={1} max={2} step={0.05} value={f.memory_overcommit} onChange={set('memory_overcommit')} /></Field>
              <Field label="RAM reserved for the host (GiB)" hint="Never handed to containers"><input type="number" min={0.25} step={0.25} value={f.host_memory_reserve_gib} onChange={set('host_memory_reserve_gib')} /></Field>
              <Field label="Storage pool reserve (%)"><input type="number" min={0} max={50} value={f.disk_reserve_percent} onChange={set('disk_reserve_percent')} /></Field>
            </div>
            {alloc.data && <div className="mt12"><Allocation a={alloc.data} /></div>}
          </Card>
          <Card title="Alert thresholds" sub="Usage must stay above the line for the given number of minutes before an alert is raised.">
            <div className="fgrid">
              <Field label="CPU %"><input type="number" min={1} max={100} value={f.alert_cpu} onChange={set('alert_cpu')} /></Field>
              <Field label="Memory %"><input type="number" min={1} max={100} value={f.alert_memory} onChange={set('alert_memory')} /></Field>
              <Field label="Disk %"><input type="number" min={1} max={100} value={f.alert_disk} onChange={set('alert_disk')} /></Field>
              <Field label="CPU temperature °C"><input type="number" min={40} max={110} value={f.alert_temp} onChange={set('alert_temp')} /></Field>
              <Field label="Backup disk free below %"><input type="number" min={1} max={100} value={f.alert_backup_disk_free} onChange={set('alert_backup_disk_free')} /></Field>
              <Field label="Sustained for (minutes)"><input type="number" min={1} max={60} value={f.alert_sustain_minutes} onChange={set('alert_sustain_minutes')} /></Field>
            </div>
          </Card>
          <Card title="Terminal and domains">
            <div className="fgrid">
              <Field label="Terminal idle timeout (minutes)"><input type="number" min={1} max={240} value={f.terminal_idle_minutes} onChange={set('terminal_idle_minutes')} /></Field>
              <Field label="Terminal maximum session (minutes)"><input type="number" min={5} max={1440} value={f.terminal_max_minutes} onChange={set('terminal_max_minutes')} /></Field>
              <Field label="Domains users may request subdomains of" hint="Comma separated" wide><input value={f.allowed_domain_suffixes} onChange={set('allowed_domain_suffixes')} /></Field>
            </div>
          </Card>
          {sup && <div><button type="submit" className="btn btn--primary">Save settings</button></div>}
        </fieldset>
      </form>
      {!sup && <Note>You are an admin. Ask a super admin to change platform settings.</Note>}
    </>
  );
}
