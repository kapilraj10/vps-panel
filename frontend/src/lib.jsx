import { useEffect, useRef, useState } from 'react';

export const MAX_POINTS = 720;

// ---------- formatting ----------
export function bytes(n) {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
export const pct = (used, total) => (total ? Math.round((used / total) * 1000) / 10 : 0);
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const dateTime = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
export function uptime(s) {
  if (!s) return '–';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function ago(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const level = (p) => (p >= 90 ? 'alarm' : p >= 75 ? 'warn' : 'ok');

// Recharts needs real colour values, so read them from the CSS tokens
export function useColors() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return { muted: v('--muted'), line: v('--line'), signal: v('--signal'), ram: v('--ram'), surface: v('--surface'), ink: v('--ink') };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setC(read());
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return c;
}

// ---------- API ----------
let csrfToken = '';
export const setCsrf = (t) => { csrfToken = t; };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/api/login') {
    window.location.href = '/login';
    throw new Error('Please log in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- pieces ----------
export function Meter({ label, value, detail, percent }) {
  const p = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <div className={`meter meter--${level(p)}`}>
      <span className="meter__label">{label}</span>
      <div className="meter__track" role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="meter__fill" style={{ width: `${p}%` }} />
      </div>
      <span className="meter__value">{value}</span>
      <span className="meter__detail">{detail}</span>
    </div>
  );
}

export function ChartTip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <div className="tip__time">{clock(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="tip__row">
          <span className="tip__dot" style={{ background: p.color }} />
          {p.name}: <strong>{p.value}{unit}</strong>
        </div>
      ))}
    </div>
  );
}

// Modal built on <dialog>: opens when `open` is true, Escape / Cancel call onClose
export function Dialog({ open, title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'dialog dialog--wide' : 'dialog'} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
