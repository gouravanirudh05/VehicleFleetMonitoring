import { useState } from 'react';
import { api } from '../lib/api.js';
import { live, useLive } from '../lib/live.js';
import { COMMAND_LABEL, FLEET_COLORS, OUTCOME_LABEL, RULE_LABEL, SUGGESTED, ago, isEarlyWarning } from '../lib/format.js';

const RANK = { critical: 0, warning: 1, info: 2 };
const CMD_STATE = {
  queued: 'waiting for the vehicle',
  delivered: 'on the driver\'s tablet',
  confirmed: 'driver confirmed',
  unconfirmed: 'no reply from driver',
  expired: 'not delivered',
  cancelled: 'cancelled',
};

export const sortIncidents = (a, b) =>
  RANK[a.severity] - RANK[b.severity] || (a.owner ? 1 : 0) - (b.owner ? 1 : 0) || b.lastSeenAt - a.lastSeenAt;

export async function runAction(id, action, body = {}) {
  const r = await api(`/incidents/${id}/${action}`, { method: 'POST', body });
  live.upsertIncidents([r.incident]);
  return r.incident;
}

export function lastCommand(inc) {
  return inc.commands?.length ? inc.commands[inc.commands.length - 1] : null;
}

export function CommandState({ cmd }) {
  if (!cmd) return null;
  return (
    <span className={`cmd-state ${cmd.status}`}>
      {cmd.label}: {CMD_STATE[cmd.status] || cmd.status}
    </span>
  );
}

/** One incident in the queue. The suggested instruction is one click away. */
export function IncidentCard({ inc, active, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const suggested = SUGGESTED[inc.rule];
  const inFlight = inc.commands?.some((c) => c.type === suggested && ['queued', 'delivered', 'confirmed'].includes(c.status));
  const cmd = lastCommand(inc);

  const send = async (e) => {
    e.stopPropagation();
    setBusy(true); setErr('');
    try { await runAction(inc.id, 'command', { type: suggested }); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <li>
      <article
        className={`inc-card ${inc.severity} is-${inc.status}${active ? ' selected' : ''}`}
        onClick={() => onOpen(inc.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(inc.id); }}
        tabIndex={0}
        aria-label={`${RULE_LABEL[inc.rule]} on ${inc.vehicleId}`}
      >
        <header>
          <span className="sev">{RULE_LABEL[inc.rule] || inc.rule}</span>
          {isEarlyWarning(inc.rule) && <span className="pill early" title="Raised by this vehicle's learned model, before any fixed limit was crossed">Early warning</span>}
          {inc.status === 'cleared' && <span className="pill">Stopped</span>}
          {inc.count > 1 && <span className="pill">{inc.count}×</span>}
          <time className="age" title={new Date(inc.ts).toLocaleString()}>{ago(inc.status === 'resolved' ? inc.resolvedAt : inc.lastSeenAt)}</time>
        </header>
        <div className="who">
          <i className="fleet" style={{ background: FLEET_COLORS[inc.fleetId] }} />
          <span className="mono">{inc.vehicleId}</span>
          <span className="dim">· {inc.driver?.name}</span>
        </div>
        {inc.status === 'resolved'
          ? <p className="dim">{OUTCOME_LABEL[inc.outcome] || 'Resolved'}{inc.owner ? ` · ${inc.owner.by}` : ''}</p>
          : <p>{inc.message}</p>}
        {inc.status !== 'resolved' && (
          <footer>
            {cmd ? <CommandState cmd={cmd} /> : <span className={inc.owner ? 'dim' : 'unowned'}>{inc.owner ? `Owned by ${inc.owner.by}` : 'Nobody on it yet'}</span>}
            {inc.status === 'cleared' && <span className="review">Review and close</span>}
            {inc.status === 'active' && suggested && !inFlight && (
              <button type="button" className="btn small" onClick={send} disabled={busy}>{busy ? 'Sending' : COMMAND_LABEL[suggested]}</button>
            )}
          </footer>
        )}
        {err && <p className="err">{err}</p>}
      </article>
    </li>
  );
}

/**
 * The dispatcher's queue for the fleets this screen follows: what is happening now, what has
 * stopped but still needs someone to close it, and what was resolved in the last two hours.
 */
export default function Attention({ selectedId, onOpen }) {
  useLive();
  const open = live.openIncidents();
  const now = open.filter((i) => i.status === 'active').sort(sortIncidents);
  const review = open.filter((i) => i.status === 'cleared').sort(sortIncidents);
  const resolved = [...live.incidents.values()]
    .filter((i) => i.status === 'resolved' && live.fleets.includes(i.fleetId))
    .sort((a, b) => b.resolvedAt - a.resolvedAt);
  const critical = open.filter((i) => i.severity === 'critical').length;
  const unowned = open.filter((i) => !i.owner).length;

  return (
    <section className="attention" aria-labelledby="attention-title">
      <header className="attention-head">
        <h2 id="attention-title">Needs attention</h2>
        <p className="small">
          {open.length
            ? <><b className={critical ? 'coral' : ''}>{critical} critical</b> · {open.length} open · {unowned} unassigned</>
            : <span className="dim">All clear</span>}
        </p>
      </header>
      <div className="attention-body">
        {!open.length && <p className="empty">No open incidents. New ones appear here the moment a vehicle trips a rule.</p>}
        {now.length > 0 && (
          <>
            <h3 className="group">Happening now <span>{now.length}</span></h3>
            <ul className="inc-list">{now.slice(0, 80).map((i) => <IncidentCard key={i.id} inc={i} active={i.id === selectedId} onOpen={onOpen} />)}</ul>
          </>
        )}
        {review.length > 0 && (
          <>
            <h3 className="group">Stopped, needs review <span>{review.length}</span></h3>
            <ul className="inc-list">{review.slice(0, 80).map((i) => <IncidentCard key={i.id} inc={i} active={i.id === selectedId} onOpen={onOpen} />)}</ul>
          </>
        )}
        {resolved.length > 0 && (
          <details className="handled">
            <summary>Resolved in the last 2 hours ({resolved.length})</summary>
            <ul className="inc-list">{resolved.slice(0, 40).map((i) => <IncidentCard key={i.id} inc={i} active={i.id === selectedId} onOpen={onOpen} />)}</ul>
          </details>
        )}
      </div>
    </section>
  );
}
