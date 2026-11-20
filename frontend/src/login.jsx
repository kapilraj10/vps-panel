import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, applyTheme } from './lib.jsx';
import { Logo } from './brand.jsx';
import { BILLING_LINE } from './landing.config.js';
import './index.css';
import './cloud.css';

applyTheme();

// /register: self sign-up (if the admin allows it). New accounts start with an empty wallet.
function Register() {
  const [f, setF] = useState({ fullName: '', email: '', username: '', password: '', website: '' });
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => { api('/api/public/info').then(setInfo).catch(() => setInfo({ signup: { enabled: true } })); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: k === 'username' ? e.target.value.toLowerCase().trim() : e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/api/register', { method: 'POST', body: f });
      if (r.pending) { setPending(true); setBusy(false); return; }
      window.location.href = '/#/wallet';
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const brand = <div className="login__brand"><a href="/" className="login__home" aria-label="Sampanna Cloud home"><Logo wordmark size={30} /></a></div>;
  if (pending) {
    return (
      <main className="login"><div className="panel form login__box">{brand}<h1>Account created</h1>
        <p className="top__meta">An administrator checks new accounts before they can log in. You can log in once it is approved.</p>
        <a className="btn btn--primary" href="/login">Go to log in</a></div></main>
    );
  }
  if (info && !info.signup.enabled) {
    return (
      <main className="login"><div className="panel form login__box">{brand}<h1>Sign-up is closed</h1>
        <p className="top__meta">Ask the administrator for an account.</p><a className="btn btn--primary" href="/login">Log in</a></div></main>
    );
  }
  return (
    <main className="login">
      <form className="panel form login__box" onSubmit={submit}>
        {brand}
        <h1>Create your account</h1>
        <p className="top__meta">Deploy apps, servers and databases. {BILLING_LINE}{info?.signup.credit ? ` New accounts get ${info.currency} ${(info.signup.credit / 100).toFixed(0)} free credit.` : ''}</p>
        <label>Full name<input required autoFocus autoComplete="name" maxLength={100} value={f.fullName} onChange={set('fullName')} /></label>
        <label>Email<input required type="email" autoComplete="email" value={f.email} onChange={set('email')} /></label>
        <label>Username<input required autoComplete="username" autoCapitalize="none" spellCheck={false} pattern="[a-z][a-z0-9_\-]{1,31}" title="2-32 lowercase letters, digits, _ or -, starting with a letter" value={f.username} onChange={set('username')} /></label>
        <label>Password<input required type="password" minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} /><small className="muted">At least 10 characters</small></label>
        <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label>
        {error && <p className="bad" role="alert">{error}</p>}
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted small">Already have an account? <a href="/login">Log in</a></p>
      </form>
    </main>
  );
}

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/api/login', { method: 'POST', body: { username, password } });
      if (r.twoFactor) { setTicket(r.ticket); setPassword(''); setBusy(false); return; }
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
      setPassword('');
      setBusy(false);
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login/2fa', { method: 'POST', body: { ticket, code } });
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
      setCode('');
      setBusy(false);
      if (/expired|password again/i.test(err.message)) setTicket(null);
    }
  }

  if (ticket) {
    return (
      <main className="login">
        <form className="panel form login__box" onSubmit={submitCode}>
          <div className="login__brand"><a href="/" className="login__home" aria-label="Sampanna Cloud home"><Logo wordmark size={30} /></a></div>
          <h1>Two-factor code</h1>
          <p className="top__meta">Open your authenticator app and enter the 6-digit code for Sampanna Cloud ({username}). Lost your phone? Use a recovery code.</p>
          <label>Code
            <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={11} value={code} onChange={(e) => setCode(e.target.value.trim())} />
          </label>
          {error && <p className="bad" role="alert">{error}</p>}
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
          <button type="button" className="btn" onClick={() => { setTicket(null); setError(''); }}>Back</button>
        </form>
      </main>
    );
  }

  return (
    <main className="login">
      <form className="panel form login__box" onSubmit={submit}>
        <div className="login__brand"><a href="/" className="login__home" aria-label="Sampanna Cloud home"><Logo wordmark size={30} /></a></div>
        <h1>Sign in</h1>
        <p className="top__meta">Manage your servers, apps and domains.</p>
        <label>Username
          <input required autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>Password
          <input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="bad" role="alert">{error}</p>}
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <p className="muted small">New here? <a href="/register">Create an account</a> · <a href="/">Sampanna Cloud home</a></p>
      </form>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {window.location.pathname.startsWith('/register') ? <Register /> : <Login />}
  </React.StrictMode>
);
