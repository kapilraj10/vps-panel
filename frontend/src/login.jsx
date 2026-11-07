import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, applyTheme } from './lib.jsx';
import './index.css';
import './cloud.css';

applyTheme();

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
          <div className="login__brand"><span className="brand__mark">K</span><span>Kapil Cloud</span></div>
          <h1>Two-factor code</h1>
          <p className="top__meta">Open your authenticator app and enter the 6-digit code for Kapil Cloud ({username}). Lost your phone? Use a recovery code.</p>
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
        <div className="login__brand"><span className="brand__mark">K</span><span>Kapil Cloud</span></div>
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
      </form>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Login />
  </React.StrictMode>
);
