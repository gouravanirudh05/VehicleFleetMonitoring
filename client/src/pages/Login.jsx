import { useState } from 'react';
import { useSession } from '../lib/session.jsx';
import { Wordmark } from '../components/Shell.jsx';

const DEMO = [
  ['admin', 'admin123', 'Dispatcher: all three fleets'],
  ['north', 'north123', 'Fleet manager: North Depot'],
  ['airport', 'airport123', 'Fleet manager: Airport Shuttle'],
];

export default function Login() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await signIn(username, password); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="login">
      <div className="login-card">
        <Wordmark />
        <h1>Sign in</h1>
        <p className="dim">Live locations, incidents and driver instructions for your fleets.</p>
        <form onSubmit={submit}>
          <label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
        </form>
        <details className="demo">
          <summary>Demo accounts</summary>
          <ul>
            {DEMO.map(([u, p, scope]) => (
              <li key={u}>
                <button type="button" className="link" onClick={() => { setUsername(u); setPassword(p); }}>
                  <span className="mono">{u} / {p}</span>
                </button>
                <span className="dim">{scope}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
