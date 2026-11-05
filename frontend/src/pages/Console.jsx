// SSH Console: several live SSH sessions to registered VPS servers, in tabs. The panel holds the SSH key and connects;
// the browser only sees terminal bytes. Sessions survive a short connection drop (they are re-attached automatically).
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ago, dateTime, Dialog } from '../lib.jsx';
import { useLive } from '../live.js';
import { PageHeader, Card, Badge, Empty, Icon, Note, href, useApi } from '../ui.jsx';
import { useNodes, NodeStatus } from './Fleet.jsx';

function Term({ tab, active, onState }) {
  const { socket } = useLive();
  const box = useRef(null);
  const ref = useRef({ id: null });
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 10000, allowProposedApi: false,
      fontFamily: "ui-monospace, 'IBM Plex Mono', SFMono-Regular, Menlo, monospace",
      theme: { background: '#111110', foreground: '#f0efec' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    fit.fit();
    let closed = false;
    const st = ref.current;
    const onData = (m) => { if (m.id === st.id) term.write(new Uint8Array(m.data)); };
    const onExit = (m) => {
      if (m.id !== st.id) return;
      term.write(`\r\n\x1b[33m[session closed: ${m.reason}]\x1b[0m\r\n`);
      st.id = null;
      onState('closed', m.reason);
    };
    socket.on('ssh:data', onData);
    socket.on('ssh:exit', onExit);
    const open = () => socket.emit('ssh:open', { nodeId: tab.nodeId, cols: term.cols, rows: term.rows }, (r) => {
      if (closed) { if (r?.id) socket.emit('ssh:close', { id: r.id }); return; }
      if (r?.error) { term.write(`\x1b[31m${r.error}\x1b[0m\r\n`); onState('error', r.error); return; }
      st.id = r.id;
      onState('live');
    });
    // after a socket reconnect, re-attach to the same SSH session (the panel keeps it ~2 minutes)
    const onReconnect = () => {
      if (!st.id) return;
      onState('reconnecting');
      term.write('\r\n\x1b[90m[reconnecting…]\x1b[0m\r\n');
      socket.emit('ssh:attach', { id: st.id }, (r) => {
        if (r?.error) { term.write(`\x1b[31m${r.error}\x1b[0m\r\n`); st.id = null; onState('closed', r.error); return; }
        term.reset();
        onState('live');
      });
    };
    const onDisconnect = () => { if (st.id) onState('reconnecting'); };
    socket.on('connect', onReconnect);
    socket.on('disconnect', onDisconnect);
    term.onData((d) => { if (st.id) socket.emit('ssh:input', { id: st.id, data: d }); });
    const resize = () => {
      if (!box.current?.offsetParent) return;
      try { fit.fit(); } catch { return; }
      if (st.id) socket.emit('ssh:resize', { id: st.id, cols: term.cols, rows: term.rows });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box.current);
    st.term = term;
    st.resize = resize;
    open();
    return () => {
      closed = true;
      ro.disconnect();
      socket.off('ssh:data', onData); socket.off('ssh:exit', onExit); socket.off('connect', onReconnect); socket.off('disconnect', onDisconnect);
      if (st.id) socket.emit('ssh:close', { id: st.id });
      term.dispose();
    };
  }, [socket, tab.key]);
  useEffect(() => { if (active) setTimeout(() => { ref.current.resize?.(); ref.current.term?.focus(); }, 30); }, [active]);
  return <div className="term term--ssh" ref={box} style={{ display: active ? 'block' : 'none' }} />;
}

function History() {
  const { data } = useApi('/api/terminal-sessions', { interval: 30000 });
  const [show, setShow] = useState(null);
  const cmds = useApi(show ? `/api/terminal-sessions/${show.id}/commands` : null);
  if (!data) return null;
  return (
    <Card pad={false} title="Recent sessions" sub="Every console session is recorded with its typed command lines (not input after password prompts)">
      {!data.sessions.length ? <div className="pad muted">No sessions yet.</div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Server</th><th>User</th><th>Started</th><th>Ended</th><th>Commands</th><th /></tr></thead>
          <tbody>{data.sessions.slice(0, 30).map((s) => (
            <tr key={s.id}><td>{s.node_name || '–'}</td><td>{s.username}</td><td>{dateTime(s.started_at)}</td>
              <td>{s.live ? <Badge tone="good" dot>open</Badge> : s.ended_at ? <>{ago(s.ended_at)}<br /><small className="muted">{s.end_reason}</small></> : '–'}</td>
              <td>{s.commands}</td><td><button type="button" className="btn btn--small" onClick={() => setShow(s)}>Commands</button></td></tr>
          ))}</tbody>
        </table></div>
      )}
      {show && (
        <Dialog open title={`Commands: ${show.node_name} · ${dateTime(show.started_at)}`} onClose={() => setShow(null)} wide>
          {cmds.error ? <Note tone="bad">{cmds.error}</Note> : <pre className="logbox mono">{(cmds.data?.commands || []).map((c) => `${new Date(c.ts).toLocaleTimeString()}  ${c.line}`).join('\n') || 'No commands.'}</pre>}
          <div className="dialog__buttons"><button type="button" className="btn btn--primary" onClick={() => setShow(null)}>Close</button></div>
        </Dialog>
      )}
    </Card>
  );
}

let seq = 0;
export default function ConsolePage() {
  const { me } = useLive();
  const { nodes } = useNodes();
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [pick, setPick] = useState('');
  const [full, setFull] = useState(false);
  const usable = nodes.filter((n) => n.ssh_host_key);
  const add = (nodeId) => {
    const n = nodes.find((x) => String(x.id) === String(nodeId));
    if (!n) return;
    seq += 1;
    const t = { key: `t${seq}`, nodeId: n.id, name: n.name, state: 'connecting', msg: '' };
    setTabs((x) => [...x, t]);
    setActive(t.key);
  };
  // #/console?node=3 opens that server directly
  useEffect(() => {
    const check = () => {
      const m = window.location.hash.match(/[?&]node=(\d+)/);
      if (m && nodes.length) { add(m[1]); window.history.replaceState(null, '', '#/console'); }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [nodes.length]);
  useEffect(() => {
    if (!full) return undefined;
    const esc = (e) => { if (e.key === 'Escape' && e.shiftKey) setFull(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [full]);
  const setState = (key) => (state, msg = '') => setTabs((x) => x.map((t) => (t.key === key ? { ...t, state, msg } : t)));
  const close = (key) => {
    setTabs((x) => {
      const rest = x.filter((t) => t.key !== key);
      if (active === key) setActive(rest.at(-1)?.key || null);
      return rest;
    });
  };
  if (me.role !== 'super_admin') return <><PageHeader title="SSH Console" /><Note tone="warn">Only a super admin can open server consoles.</Note></>;
  const tone = { live: 'good', connecting: 'warn', reconnecting: 'warn', closed: 'neutral', error: 'bad' };
  return (
    <>
      <PageHeader title="SSH Console" sub="Interactive shells on your VPS servers, through the panel's SSH key"
        actions={<form className="inline-form" style={{ margin: 0 }} onSubmit={(e) => { e.preventDefault(); add(pick); }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} required>
            <option value="">Select server…</option>
            {usable.map((n) => <option key={n.id} value={n.id}>{n.name} ({n.ssh_user}@{n.public_ip})</option>)}
          </select>
          <button type="submit" className="btn btn--primary"><Icon name="plus" /> Open</button>
        </form>} />
      {nodes.length > usable.length && <Note>Servers appear here after a successful “Test SSH” on their SSH tab (that checks the key and pins the host key). {nodes.filter((n) => !n.ssh_host_key).map((n) => <a key={n.id} href={href(`fleet/${n.id}/ssh`)} className="mr8">{n.name}</a>)}</Note>}
      {!tabs.length ? <Empty icon="terminal" title="No console open">Pick a server above. You can open several consoles side by side in tabs.</Empty> : (
        <div className={`console ${full ? 'console--full' : ''}`}>
          <div className="console__tabs" role="tablist">
            {tabs.map((t) => (
              <div key={t.key} role="tab" aria-selected={active === t.key} className="console__tab" onClick={() => setActive(t.key)}>
                <Badge tone={tone[t.state]} dot>{t.name}</Badge>
                <button type="button" className="icon-btn" aria-label={`Close ${t.name}`} onClick={(e) => { e.stopPropagation(); close(t.key); }}><Icon name="x" size={14} /></button>
              </div>
            ))}
            <span className="console__spacer" />
            {tabs.find((t) => t.key === active)?.msg && <span className="muted small">{tabs.find((t) => t.key === active).msg}</span>}
            <button type="button" className="icon-btn" title={full ? 'Exit full screen (Shift+Esc)' : 'Full screen'} onClick={() => setFull((v) => !v)}><Icon name={full ? 'x' : 'monitor'} /></button>
          </div>
          {tabs.map((t) => <Term key={t.key} tab={t} active={active === t.key} onState={setState(t.key)} />)}
          <p className="muted small console__hint">Copy: select text (Ctrl+Shift+C) · Paste: Ctrl+Shift+V · Idle sessions close automatically (Settings → terminal idle minutes).</p>
        </div>
      )}
      <History key={tabs.length} />
    </>
  );
}

export { NodeStatus };
