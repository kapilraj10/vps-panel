import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './lib.jsx';
import './index.css';

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login', { method: 'POST', body: { username, password } });
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="panel form login__box" onSubmit={submit}>
        <h1>Server panel</h1>
        <p className="top__meta">Log in to see your server.</p>
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
