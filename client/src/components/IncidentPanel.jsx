import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { live, useLive } from '../lib/live.js';
import { COMMAND_LABEL, FLEET_COLORS, OUTCOME_LABEL, RULE_LABEL, STATUS_LABEL, STATUS_TEXT, SUGGESTED, clock, isEarlyWarning, n0 } from '../lib/format.js';
import { CommandState, runAction } from './Attention.jsx';

const ORDER = ['slowDown', 'returnToRoute', 'pullOver', 'resumeTrip', 'callControl'];

function suggestOutcome(inc) {
  if (inc.commands?.some((c) => c.status === 'confirmed')) return 'driverCorrected';
  if (inc.status === 'cleared' && !inc.commands?.length) return 'clearedOnItsOwn';
  return '';
}

/**
 * Everything needed to work one incident: what happened, the vehicle right now, instruct or
 * call the driver, notes, and resolving with an outcome (optionally booking a follow-up).
 */
export default function IncidentPanel({ id, onClose, onVehicle }) {
  useLive();
  const [fetched, setFetched] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState('');
  const [resolveNote, setResolveNote] = useState('');
  const [followUp, setFollowUp] = useState('');

  const inc = live.incidents.get(id) || fetched;
  const [model, setModel] = useState(null);
  const vehicleId = inc?.vehicleId;
  const early = inc && isEarlyWarning(inc.rule);

  // For early warnings, show what the vehicle's model considers normal, so the reason is visible.
  useEffect(() => {
    if (!early || !vehicleId) return undefined;
    let cancelled = false;
    api(`/vehicles/${encodeURIComponent(vehicleId)}`).then((r) => !cancelled && setModel(r.model)).catch(() => {});
    return () => { cancelled = true; };
  }, [early, vehicleId]);

  useEffect(() => {
    if (live.incidents.get(id)) return undefined;
    let cancelled = false;
    api(`/incidents/${id}`).then((r) => !cancelled && setFetched(r.incident)).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => { if (inc && !outcome) setOutcome(suggestOutcome(inc)); }, [inc, outcome]);

  if (!inc) {
    return (
      <section className="detail">
        <header className="detail-head"><h2>Incident</h2><button type="button" className="close" onClick={onClose} aria-label="Close">×</button></header>
        <p className={error ? 'err' : 'dim'}>{error || 'Loading…'}</p>
      </section>
    );
  }

  const v = live.vehicles.get(inc.vehicleId);
  const open = inc.status !== 'resolved';
  const suggested = SUGGESTED[inc.rule];
  const commands = [suggested, ...ORDER.filter((c) => c !== suggested)].filter(Boolean);
  const inFlight = (type) => inc.commands?.some((c) => c.type === type && ['queued', 'delivered'].includes(c.status));

  const act = async (key, action, body) => {
    setBusy(key); setError('');
    try { await runAction(inc.id, action, body); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(''); }
  };

  return (
    <section className="detail incident" aria-label={`${RULE_LABEL[inc.rule]} on ${inc.vehicleId}`}>
      <header className="detail-head">
        <div>
          <p className={`eyebrow sev-${inc.severity}`}>{inc.severity} · {STATUS_TEXT[inc.status]}</p>
          <h2>{RULE_LABEL[inc.rule] || inc.rule}</h2>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close incident">×</button>
      </header>

      <p className="inc-message">{inc.message}</p>
      {early && (
        <p className="why">
          <b>Early warning.</b> Raised by this vehicle's own learned model, not a fixed limit.
          {model?.normalEngineC != null && <> Its engine normally runs at {model.normalEngineC} °C at its current speed (±{model.engineSpreadC} °C).</>}
          {inc.rule === 'fuelDrop' && model?.fuelPerKm != null && <> It normally uses {model.fuelPerKm}% of its tank per km.</>}
        </p>
      )}
      <dl className="facts">
        <div><dt>Vehicle</dt><dd><button type="button" className="link mono" onClick={() => onVehicle(inc.vehicleId)}><i className="fleet" style={{ background: FLEET_COLORS[inc.fleetId] }} />{inc.vehicleId}</button></dd></div>
        <div><dt>Driver</dt><dd>{inc.driver?.name}</dd></div>
        <div><dt>Right now</dt><dd>{v ? `${STATUS_LABEL[v.st] || '–'} · ${n0(v.sp)} km/h` : '–'}</dd></div>
        <div><dt>First seen</dt><dd>{clock(inc.ts)}{inc.count > 1 ? ` · ${inc.count} times` : ''}</dd></div>
        <div><dt>Owner</dt><dd>
          {inc.owner ? inc.owner.by : open
            ? <button type="button" className="btn small" disabled={!!busy} onClick={() => act('ack', 'ack')}>{busy === 'ack' ? 'Taking' : 'Take it'}</button>
            : '–'}
        </dd></div>
      </dl>

      {open && (
        <>
          <h3 className="chart-title">Instruct the driver</h3>
          <div className="cmd-grid">
            {commands.map((c) => (
              <button key={c} type="button" className={`btn small${c === suggested ? '' : ' ghost'}`} disabled={!!busy || inFlight(c)} onClick={() => act(c, 'command', { type: c })}>
                {busy === c ? 'Sending' : COMMAND_LABEL[c]}
              </button>
            ))}
          </div>
          {inc.commands?.length > 0 && (
            <ul className="cmd-list">{inc.commands.slice().reverse().map((c) => <li key={c.id}><CommandState cmd={c} /><span className="dim">{clock(c.sentAt)}</span></li>)}</ul>
          )}

          <h3 className="chart-title">Call {inc.driver?.name?.split(' ')[0] || 'the driver'}</h3>
          <div className="cmd-grid">
            <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => act('reached', 'call', { result: 'reached' })}>Reached driver</button>
            <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => act('noAnswer', 'call', { result: 'noAnswer' })}>No answer</button>
          </div>

          <form className="note-form" onSubmit={async (e) => { e.preventDefault(); if (await act('note', 'note', { text: note })) setNote(''); }}>
            <label className="chart-title" htmlFor="inc-note">Add a note</label>
            <div className="row">
              <input id="inc-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What you did or found out" />
              <button type="submit" className="btn small ghost" disabled={!!busy || !note.trim()}>Add</button>
            </div>
          </form>

          <form className="resolve" onSubmit={async (e) => {
            e.preventDefault();
            if (await act('resolve', 'resolve', { outcome, note: resolveNote, followUp: followUp || null })) { setResolveNote(''); setFollowUp(''); }
          }}>
            <h3 className="chart-title">Resolve</h3>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} required aria-label="Outcome">
              <option value="" disabled>Pick an outcome</option>
              {Object.entries(OUTCOME_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <input value={resolveNote} maxLength={500} onChange={(e) => setResolveNote(e.target.value)} placeholder="Note for the record (optional)" aria-label="Resolution note" />
            <div className="seg" role="group" aria-label="Book a follow-up">
              {[['', 'No follow-up'], ['coaching', 'Coach driver'], ['maintenance', 'Maintenance check']].map(([k, label]) => (
                <button key={k} type="button" className={followUp === k ? 'on' : ''} aria-pressed={followUp === k} onClick={() => setFollowUp(k)}>{label}</button>
              ))}
            </div>
            <button type="submit" className="btn" disabled={!!busy || !outcome}>{busy === 'resolve' ? 'Resolving' : 'Resolve incident'}</button>
          </form>
        </>
      )}
      {!open && (
        <p className="resolved-line">Resolved {clock(inc.resolvedAt)}: <b>{OUTCOME_LABEL[inc.outcome]}</b>{inc.note ? ` · ${inc.note}` : ''}</p>
      )}
      {error && <p className="err" role="alert">{error}</p>}

      <h3 className="chart-title">Timeline</h3>
      <ol className="timeline">
        {inc.timeline.slice().reverse().map((e, i) => (
          <li key={`${e.t}-${i}`} className={`tl-${e.type}`}>
            <time>{clock(e.t)}</time>
            <span>{e.text}{e.by ? <span className="dim"> · {e.by}</span> : null}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
