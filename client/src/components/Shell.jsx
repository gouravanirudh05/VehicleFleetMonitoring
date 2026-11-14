import { NavLink } from 'react-router-dom';
import { live, useLive } from '../lib/live.js';
import { useSession } from '../lib/session.jsx';

export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="Fleetwake home">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 18 L10 6 L13 11" fill="none" stroke="#F59958" strokeWidth="2.4" />
        <path d="M11 18 L16 9 L21 18" fill="none" stroke="#1C1C1C" strokeWidth="2.4" />
      </svg>
      Fleetwake
    </a>
  );
}

/** Fleet subscription toggles. Each chip is one Socket.IO room this screen can join or leave. */
function FleetChips() {
  const { meta } = useSession();
  useLive();
  if (!meta) return null;
  const toggle = (id) => {
    const on = live.fleets.includes(id);
    live.subscribe(on ? live.fleets.filter((f) => f !== id) : [...live.fleets, id]);
  };
  return (
    <div className="chips" role="group" aria-label="Fleets shown">
      {meta.fleets.map((f) => {
        const on = live.fleets.includes(f.id);
        return (
          <button key={f.id} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(f.id)}
            title={`${f.purpose}. ${on ? 'Click to hide' : 'Click to show'} this fleet.`}>
            <i style={{ background: f.color }} />{f.name}
          </button>
        );
      })}
    </div>
  );
}

function Connection() {
  useLive();
  const label = { live: 'Live', connecting: 'Connecting', offline: 'Reconnecting', idle: 'Offline' }[live.status];
  return (
    <div className="status">
      <span className={`dot ${live.status}`} title={live.status === 'live' ? 'Receiving live updates' : 'Live updates paused; reconnecting automatically'}>{label}</span>
    </div>
  );
}

export default function Shell({ children }) {
  const { session, signOut } = useSession();
  const role = session.user.role === 'admin' ? 'Dispatcher' : 'Fleet manager';
  return (
    <div className="shell">
      <header className="topbar">
        <Wordmark />
        <nav aria-label="Dashboard">
          <NavLink to="/" end>Control room</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          {session.user.role === 'admin' && <NavLink to="/system">System health</NavLink>}
        </nav>
        <FleetChips />
        <Connection />
        <div className="user">
          <span><b>{session.user.username}</b> <span className="dim">{role}</span></span>
          <button type="button" className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
