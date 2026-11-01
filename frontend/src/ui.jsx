// Kapil Cloud UI kit: icons, layout pieces, toasts, confirm dialogs, charts, command palette, hash router.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api, clock, useColors, Dialog } from './lib.jsx';

// ---------- router (#/servers/web1/terminal) ----------
const readHash = () => {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
};
export function useRoute() {
  const [r, setR] = useState(readHash);
  useEffect(() => {
    const on = () => setR(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}
export const go = (path) => { window.location.hash = `#/${path.replace(/^\/+/, '')}`; };
export const href = (path) => `#/${path.replace(/^\/+/, '')}`;

// ---------- icons (24px stroke set) ----------
const P = {
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  app: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  terminal: 'm4 17 6-6-6-6M12 19h8',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  backup: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  network: 'M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 14 0M1.4 9.3a15 15 0 0 1 21.2 0',
  chart: 'M3 3v18h18M7 15l4-4 3 3 6-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  audit: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  storage: 'M22 12H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1zM6 16h.01M10 16h.01',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  monitor: 'M2 3h20v14H2zM8 21h8M12 17v4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  play: 'M6 3l14 9-14 9z',
  stop: 'M6 6h12v12H6z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  copy: 'M9 9h13v13H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  menu: 'M3 12h18M3 6h18M3 18h18',
  chevron: 'm9 18 6-6-6-6',
  back: 'm15 18-6-6 6-6',
  cpu: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  memory: 'M2 7h20v10H2zM6 7v10M10 7v10M14 7v10M18 7v10',
  disk: 'M22 12H2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
};
export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || P.info} />
    </svg>
  );
}

// ---------- toasts ----------
const ToastCtx = createContext(null);
export function useToast() { return useContext(ToastCtx); }

// ---------- confirm (optionally "type the name to confirm") ----------
const ConfirmCtx = createContext(null);
export function useConfirm() { return useContext(ConfirmCtx); }

export function Providers({ children }) {
  const [toasts, setToasts] = useState([]);
  const [ask, setAsk] = useState(null);
  const [typed, setTyped] = useState('');
  const push = useCallback((tone, text, ms = 5000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-4), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const toast = useMemo(() => ({
    ok: (t) => push('ok', t), err: (t) => push('bad', t, 8000), info: (t) => push('info', t), warn: (t) => push('warn', t, 8000),
  }), [push]);
  const confirm = useCallback((o) => new Promise((resolve) => { setTyped(''); setAsk({ ...o, resolve }); }), []);
  const close = (v) => { ask?.resolve(v ? (ask.typed ? typed : true) : false); setAsk(null); };
  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast--${t.tone}`}>
              <Icon name={t.tone === 'ok' ? 'check' : t.tone === 'bad' ? 'alert' : 'info'} size={16} />
              <span>{t.text}</span>
            </div>
          ))}
        </div>
        <Dialog open={!!ask} title={ask?.title || ''} onClose={() => close(false)}>
          {ask && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); if (!ask.typed || typed === ask.typed) close(true); }}>
              {ask.body && <div className="confirm__body">{ask.body}</div>}
              {ask.typed && (
                <label>Type <code>{ask.typed}</code> to confirm
                  <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              )}
              <div className="dialog__buttons">
                <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
                <button type="submit" className={`btn ${ask.danger ? 'btn--primary btn--danger' : 'btn--primary'}`}
                  disabled={!!ask.typed && typed !== ask.typed}>{ask.confirmLabel || 'Confirm'}</button>
              </div>
            </form>
          )}
        </Dialog>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

// ---------- data hook ----------
export function useApi(path, { interval = 0, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    return api(path).then(
      (data) => { if (alive.current) setState({ data, error: null, loading: false }); },
      (error) => { if (alive.current) setState((s) => ({ ...s, error: error.message, loading: false })); },
    );
  }, [path]);
  useEffect(() => {
    alive.current = true;
    setState((s) => ({ ...s, loading: true }));
    load();
    const t = interval ? setInterval(load, interval) : null;
    return () => { alive.current = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, interval, ...deps]);
  return { ...state, reload: load };
}

// Runs an API call with toast feedback; returns the result or null
export function useAction() {
  const toast = useToast();
  return useCallback(async (fn, okText) => {
    try {
      const r = await fn();
      if (okText) toast.ok(typeof okText === 'function' ? okText(r) : okText);
      return r ?? true;
    } catch (err) {
      toast.err(err.message);
      return null;
    }
  }, [toast]);
}

// ---------- layout pieces ----------
export function PageHeader({ title, sub, actions, back }) {
  return (
    <header className="ph">
      <div className="ph__text">
        {back && <a className="ph__back" href={back}><Icon name="back" size={16} /> Back</a>}
        <h1>{title}</h1>
        {sub && <p className="ph__sub">{sub}</p>}
      </div>
      {actions && <div className="ph__actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, sub, actions, children, className = '', pad = true }) {
  return (
    <section className={`card ${pad ? '' : 'card--flush'} ${className}`}>
      {(title || actions) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {sub && <p className="card__sub">{sub}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, icon, tone = '', children }) {
  return (
    <div className={`kpi ${tone ? `kpi--${tone}` : ''}`}>
      <div className="kpi__top">
        <span className="kpi__label">{label}</span>
        {icon && <span className="kpi__icon"><Icon name={icon} size={16} /></span>}
      </div>
      <div className="kpi__value">{value ?? <Skeleton w="60%" h={26} />}</div>
      {sub && <div className="kpi__sub">{sub}</div>}
      {children}
    </div>
  );
}

const level = (p) => (p >= 90 ? 'alarm' : p >= 75 ? 'warn' : 'ok');
export function Bar({ value, tone }) {
  const p = Math.min(100, Math.max(0, Number(value) || 0));
  return (
    <div className={`bar2 bar2--${tone || level(p)}`} role="meter" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar2__fill" style={{ width: `${p}%` }} />
    </div>
  );
}

export function Badge({ tone = 'neutral', children, dot = false }) {
  return <span className={`badge badge--${tone}`}>{dot && <i className="badge__dot" />}{children}</span>;
}

const STATUS_TONE = { Running: 'good', Stopped: 'bad', Frozen: 'warn', Error: 'bad' };
export function ServerStatus({ status, busy }) {
  if (busy) return <Badge tone="warn" dot>{busy}</Badge>;
  return <Badge tone={STATUS_TONE[status] || 'neutral'} dot>{status || 'Unknown'}</Badge>;
}

export function Skeleton({ w = '100%', h = 14, r = 6 }) {
  return <span className="skel" style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}
export function SkeletonRows({ rows = 4 }) {
  return (
    <div className="skel-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={16} w={`${90 - i * 9}%`} />)}
    </div>
  );
}

export function Empty({ icon = 'info', title, children, action }) {
  return (
    <div className="empty2">
      <span className="empty2__icon"><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="note note--bad" role="alert">
      <Icon name="alert" size={16} /> <span>{error}</span>
      {onRetry && <button type="button" className="btn btn--small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Note({ tone = 'info', children }) {
  return <div className={`note note--${tone}`}><Icon name={tone === 'bad' || tone === 'warn' ? 'alert' : 'info'} size={16} /><div>{children}</div></div>;
}

export function Tabs({ tabs, value, onChange, hrefFor }) {
  return (
    <div className="tabs2" role="tablist">
      {tabs.map(([id, label]) => (hrefFor ? (
        <a key={id} role="tab" href={hrefFor(id)} aria-selected={value === id} className="tabs2__tab">{label}</a>
      ) : (
        <button key={id} type="button" role="tab" aria-selected={value === id} className="tabs2__tab" onClick={() => onChange(id)}>{label}</button>
      )))}
    </div>
  );
}

export function Field({ label, hint, children, wide = false }) {
  return (
    <label className={`field ${wide ? 'field--wide' : ''}`}>
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function Copy({ text }) {
  const toast = useToast();
  return (
    <button type="button" className="icon-btn" title="Copy" aria-label="Copy"
      onClick={() => navigator.clipboard?.writeText(text).then(() => toast.ok('Copied'), () => toast.err('Could not copy'))}>
      <Icon name="copy" size={14} />
    </button>
  );
}

// ---------- charts ----------
// Time series with one shared y-axis, legend, crosshair tooltip. series: [{ key, name, color }]
export function TimeChart({ data, series, unit = '', height = 220, domain, format = (v) => v, tickTime = clock }) {
  const colors = useColors();
  const axis = { stroke: colors.muted, fontSize: 11, tickLine: false, axisLine: false };
  if (!data || data.length < 2) return <div className="chart-empty" style={{ height }}>Collecting data… charts fill in after a couple of samples.</div>;
  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors[s.color] || s.color} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={colors[s.color] || s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke={colors.line} vertical={false} />
            <XAxis dataKey="t" tickFormatter={tickTime} minTickGap={60} {...axis} />
            <YAxis width={72} domain={domain} tickFormatter={(v) => String(format(v)).replace(/\/s$/, "")} {...axis} />
            <Tooltip content={<Tip unit={unit} format={format} tickTime={tickTime} />} cursor={{ stroke: colors.muted, strokeDasharray: '3 3' }} />
            {series.map((s) => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={colors[s.color] || s.color} strokeWidth={2}
                fill={`url(#g-${s.key})`} dot={false} isAnimationActive={false} connectNulls />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => <span key={s.key}><i style={{ background: colors[s.color] || s.color }} />{s.name}</span>)}
        </div>
      )}
    </div>
  );
}

function Tip({ active, payload, label, unit, format, tickTime }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <div className="tip__time">{tickTime(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="tip__row">
          <span className="tip__dot" style={{ background: p.color }} />
          {p.name}: <strong>{p.value == null ? '–' : format(p.value)}{unit}</strong>
        </div>
      ))}
    </div>
  );
}

// ---------- command palette (Ctrl/Cmd + K) ----------
export function CommandPalette({ open, onClose, items }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const ref = useRef(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? items.filter((x) => `${x.label} ${x.group || ''} ${x.keywords || ''}`.toLowerCase().includes(s)) : items).slice(0, 40);
  }, [q, items]);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => ref.current?.focus(), 10); } }, [open]);
  useEffect(() => setI(0), [q]);
  if (!open) return null;
  const run = (x) => { onClose(); x.run(); };
  return (
    <div className="cmdk__backdrop" onMouseDown={onClose}>
      <div className="cmdk" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk__input">
          <Icon name="search" size={16} />
          <input ref={ref} value={q} placeholder="Search pages, servers, actions…" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(list.length - 1, n + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); }
              else if (e.key === 'Enter' && list[i]) run(list[i]);
            }} />
          <kbd>Esc</kbd>
        </div>
        <ul className="cmdk__list">
          {list.map((x, n) => (
            <li key={`${x.group}-${x.label}`}>
              <button type="button" className={n === i ? 'is-active' : ''} onMouseEnter={() => setI(n)} onClick={() => run(x)}>
                <Icon name={x.icon || 'chevron'} size={16} />
                <span>{x.label}</span>
                {x.group && <small>{x.group}</small>}
              </button>
            </li>
          ))}
          {!list.length && <li className="cmdk__none">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

export { useColors };
