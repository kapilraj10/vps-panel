// Browser terminal: xterm.js over the authenticated socket. The panel opens a shell INSIDE the chosen server
// (LXD exec) and never on the host. Idle sessions close automatically; every session is audited.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useLive } from '../live.js';
import { PageHeader, Card, Empty, Icon, Note, go, href } from '../ui.jsx';

function Term({ name }) {
  const { socket } = useLive();
  const box = useRef(null);
  const [state, setState] = useState({ phase: 'connecting', msg: '' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000,
      fontFamily: "ui-monospace, 'IBM Plex Mono', SFMono-Regular, Menlo, monospace",
      theme: dark ? { background: '#111110', foreground: '#f0efec' } : { background: '#151515', foreground: '#f0efec' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    fit.fit();
    let id = null;
    let closed = false;

    const onData = (m) => { if (m.id === id) term.write(new Uint8Array(m.data)); };
    const onExit = (m) => {
      if (m.id !== id) return;
      term.write(`\r\n\x1b[33m[session closed: ${m.reason}]\x1b[0m\r\n`);
      setState({ phase: 'closed', msg: m.reason });
      id = null;
    };
    socket.on('term:data', onData);
    socket.on('term:exit', onExit);
    socket.emit('term:open', { container: name, cols: term.cols, rows: term.rows }, (r) => {
      if (closed) { if (r?.id) socket.emit('term:close', { id: r.id }); return; }
      if (r?.error) { setState({ phase: 'error', msg: r.error }); term.write(`\x1b[31m${r.error}\x1b[0m\r\n`); return; }
      id = r.id;
      setState({ phase: 'open', msg: '' });
      term.focus();
    });
    const input = term.onData((data) => { if (id) socket.emit('term:input', { id, data }); });
    const resize = () => {
      try { fit.fit(); } catch { /* hidden */ }
      if (id) socket.emit('term:resize', { id, cols: term.cols, rows: term.rows });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box.current);
    return () => {
      closed = true;
      ro.disconnect();
      input.dispose();
      socket.off('term:data', onData);
      socket.off('term:exit', onExit);
      if (id) socket.emit('term:close', { id });
      term.dispose();
    };
  }, [name, socket, attempt]);

  return (
    <Card pad={false} className="term-card">
      <div className="term-bar">
        <span><Icon name="terminal" size={14} /> root@{name}</span>
        <span className={`term-state term-state--${state.phase}`}>{state.phase === 'open' ? 'Connected' : state.phase === 'connecting' ? 'Connecting…' : state.phase === 'error' ? 'Error' : 'Closed'}</span>
        {(state.phase === 'closed' || state.phase === 'error') && <button type="button" className="btn btn--small" onClick={() => { setState({ phase: 'connecting', msg: '' }); setAttempt((n) => n + 1); }}>Reconnect</button>}
      </div>
      <div className="term" ref={box} />
    </Card>
  );
}

export default function TerminalPage({ name }) {
  const { me, cts } = useLive();
  const mine = Object.values(cts).filter((c) => me.isAdmin || me.containers.includes(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  const running = mine.filter((c) => c.status === 'Running');
  const target = name && cts[name] ? name : null;
  useEffect(() => { if (!name && running.length === 1) go(`terminal/${running[0].name}`); }, [name, running.length]);
  return (
    <>
      <PageHeader title="Terminal" sub="A root shell inside your server, in the browser. Closes after inactivity; sessions are logged."
        actions={mine.length > 0 && (
          <select className="select" value={target || ''} onChange={(e) => go(`terminal/${e.target.value}`)} aria-label="Server">
            <option value="" disabled>Choose a server…</option>
            {mine.map((c) => <option key={c.name} value={c.name} disabled={c.status !== 'Running'}>{c.name}{c.status !== 'Running' ? ` (${c.status.toLowerCase()})` : ''}</option>)}
          </select>
        )} />
      {!mine.length && <Card><Empty icon="terminal" title="No servers">There is nothing to connect to yet.</Empty></Card>}
      {target && cts[target].status !== 'Running' && <Note tone="warn">{target} is {cts[target].status.toLowerCase()}. <a href={href(`servers/${target}`)}>Start it</a> to open a terminal.</Note>}
      {target && cts[target].status === 'Running' && <Term key={target} name={target} />}
      {!target && mine.length > 0 && <Card><Empty icon="terminal" title="Pick a server">Choose a running server above.</Empty></Card>}
      {me.isAdmin && <p className="muted small">Admins get a shell in any server. This never opens a shell on the master host.</p>}
    </>
  );
}
