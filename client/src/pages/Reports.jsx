import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import uPlot from 'uplot';
import UChart from '../components/UChart.jsx';
import IncidentMap from '../components/IncidentMap.jsx';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { FLEET_COLORS, RULE_LABEL, ago, duration, n0, n1 } from '../lib/format.js';

const RANGES = [[1, 'Last hour'], [6, '6 hours'], [24, '24 hours']];
const bars = uPlot.paths.bars({ size: [0.72, 40] });
const per100 = (n, km) => (km > 1 ? (n / km) * 100 : null);
const day = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function BookButtons({ v, onBooked }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const has = (k) => v.followUps.find((f) => f.kind === k);
  const book = async (kind) => {
    setBusy(kind); setErr('');
    try {
      await api('/followups', { method: 'POST', body: { vehicleId: v.vehicleId, kind, dueInDays: kind === 'maintenance' ? 2 : 7, reason: `${v.incidents} incidents: ${v.rules.map((r) => RULE_LABEL[r] || r).join(', ')}` } });
      onBooked();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  return (
    <div className="row-actions">
      {has('coaching') ? <span className="booked">Coaching {day(has('coaching').due)}</span>
        : <button type="button" className="btn small" disabled={!!busy} onClick={() => book('coaching')}>{busy === 'coaching' ? 'Booking' : 'Book coaching'}</button>}
      {has('maintenance') ? <span className="booked">Check {day(has('maintenance').due)}</span>
        : <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => book('maintenance')}>{busy === 'maintenance' ? 'Booking' : 'Book check'}</button>}
      {err && <span className="err">{err}</span>}
    </div>
  );
}

export default function Reports() {
  const { meta } = useSession();
  const [fleet, setFleet] = useState('');
  const [hours, setHours] = useState(1);
  const [rule, setRule] = useState('');
  const [data, setData] = useState(null);
  const [followUps, setFollowUps] = useState([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const q = `${fleet ? `fleet=${fleet}&` : ''}`;
    const load = () => Promise.all([api(`/analytics?${q}hours=${hours}`), api(`/followups?${q}`)])
      .then(([d, f]) => { if (!cancelled) { setData(d); setFollowUps(f.followUps); setError(''); } })
      .catch((e) => !cancelled && setError(e.message));
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [fleet, hours, tick]);

  const totals = useMemo(() => {
    if (!data) return null;
    const km = data.perFleet.reduce((s, f) => s + f.km, 0);
    const incidents = data.perFleet.reduce((s, f) => s + f.incidents, 0);
    return { km, incidents, rate: per100(incidents, km) };
  }, [data]);

  const points = useMemo(() => (data ? data.points.filter((p) => !rule || p[2] === rule) : []), [data, rule]);
  const when = useMemo(() => data && [data.incidentsOverTime.map((a) => a.t / 1000), data.incidentsOverTime.map((a) => a.n), data.incidentsOverTime.map((a) => a.critical)], [data]);
  const maxRule = data ? Math.max(1, ...data.byRule.map((r) => r.n)) : 1;
  const resolvedTotal = data ? data.outcomes.reduce((s, o) => s + o.n, 0) : 0;
  const falseAlarms = data?.outcomes.find((o) => o.outcome === 'falseAlarm')?.n || 0;
  const fleetName = (id) => meta?.fleets.find((f) => f.id === id)?.name || id;

  const done = async (id) => {
    try { await api(`/followups/${id}/done`, { method: 'POST' }); refresh(); } catch (e) { setError(e.message); }
  };

  const whenOpts = useMemo(() => () => ({
    legend: { show: false }, cursor: { y: false },
    scales: { x: { time: true }, y: { range: (u, min, max) => [0, Math.max(4, max * 1.15)] } },
    series: [{},
      { label: 'All incidents', stroke: '#C1B2A2', fill: 'rgba(193,178,162,.7)', paths: bars, points: { show: false } },
      { label: 'Critical', stroke: '#C43C2A', fill: 'rgba(196,60,42,.85)', paths: bars, points: { show: false } }],
    axes: [{}, { size: 40 }],
  }), []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Safety and response</p>
          <h1>Reports</h1>
          <p className="lede">Who needs coaching or a maintenance check, how quickly incidents are handled, and where trouble happens.</p>
        </div>
        <div className="controls">
          <select value={fleet} onChange={(e) => setFleet(e.target.value)} aria-label="Fleet">
            <option value="">All my fleets</option>
            {meta?.fleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <div className="seg" role="group" aria-label="Period">
            {RANGES.map(([h, label]) => (
              <button key={h} type="button" className={h === hours ? 'on' : ''} aria-pressed={h === hours} onClick={() => setHours(h)}>{label}</button>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="err">{error}</p>}

      <div className="tiles">
        <div className={data?.open.critical ? 'hot' : ''}>
          <b>{n0(data?.open.total)}</b><small>Open now · {n0(data?.open.unowned)} unassigned</small>
          {data?.open.total > 0 && <Link className="tile-link" to="/">Go to control room</Link>}
        </div>
        <div><b>{duration(data?.response.ackSec)}</b><small>Median time to take ownership</small></div>
        <div><b>{duration(data?.response.resolveSec)}</b><small>Median time to resolve</small></div>
        <div><b>{totals?.rate == null ? '–' : n1(totals.rate)}</b><small>Incidents per 100 km · {n0(totals?.km)} km driven</small></div>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>Drivers to follow up <span className="dim small">most incidents in this period</span></h2>
          {!data?.topVehicles.length && <p className="empty">No incidents in this period.</p>}
          {!!data?.topVehicles.length && (
            <table>
              <thead><tr><th>Driver and vehicle</th><th>What happened</th><th className="num">Incidents</th><th>Action</th></tr></thead>
              <tbody>
                {data.topVehicles.slice(0, 8).map((v) => (
                  <tr key={v.vehicleId}>
                    <td>
                      <b className="cell-title">{v.driver?.name || '–'}</b>
                      <div className="small"><i className="fleet" style={{ background: FLEET_COLORS[v.fleetId] }} /><Link to={`/?v=${encodeURIComponent(v.vehicleId)}`} className="mono">{v.vehicleId}</Link> <span className="dim">· {ago(v.last)}</span></div>
                    </td>
                    <td className="dim">{v.rules.map((r) => RULE_LABEL[r] || r).join(', ')}</td>
                    <td className="num">{n0(v.incidents)}{v.critical ? <div className="coral small">{v.critical} critical</div> : null}</td>
                    <td className="actions-cell"><BookButtons v={v} onBooked={refresh} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="panel">
          <h2>Booked follow-ups <span className="dim small">{followUps.length} open</span></h2>
          {!followUps.length && <p className="empty">Nothing booked. Book coaching or a check from the list, a vehicle, or when resolving an incident.</p>}
          <ul className="fu-table">
            {followUps.map((f) => {
              const overdue = f.due < Date.now();
              return (
                <li key={f.id}>
                  <div>
                    <b>{f.kind === 'coaching' ? 'Coach' : 'Check'} {f.kind === 'coaching' ? f.driver?.name : f.vehicleId}</b>
                    <div className="small dim">{f.kind === 'coaching' ? f.vehicleId : f.driver?.name} · {f.reason}</div>
                  </div>
                  <span className={`due${overdue ? ' overdue' : ''}`}>{overdue ? 'Overdue' : 'Due'} {day(f.due)}</span>
                  <button type="button" className="btn small ghost" onClick={() => done(f.id)}>Mark done</button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <div className="grid-map">
        <section className="panel">
          <h2>Where incidents happen <span className="dim small">{n0(points.length)} incidents{rule ? `, ${RULE_LABEL[rule]} only` : ''}</span></h2>
          <IncidentMap points={points} />
        </section>
        <section className="panel">
          <h2>What happened</h2>
          {!data?.byRule.length && <p className="empty">No incidents in this period.</p>}
          <ul className="hbars">
            {data?.byRule.map((r) => (
              <li key={r.rule}>
                <button type="button" className={`hbar-btn${rule === r.rule ? ' on' : ''}`} aria-pressed={rule === r.rule}
                  onClick={() => setRule(rule === r.rule ? '' : r.rule)} title="Show only this type on the map">
                  {RULE_LABEL[r.rule] || r.label}
                </button>
                <span className="bar"><i style={{ width: `${(r.n / maxRule) * 100}%` }} /></span>
                <b className="mono">{n0(r.n)}</b>
              </li>
            ))}
          </ul>
          {rule && <button type="button" className="link small" onClick={() => setRule('')}>Show all types on the map</button>}
          <h2 className="sub">When <span className="legend"><i className="coralx" />critical <i className="hist" />all</span></h2>
          <UChart makeOptions={whenOpts} data={when || [[], [], []]} height={160} />
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>How incidents were closed</h2>
          {!resolvedTotal && <p className="empty">Nothing resolved in this period yet.</p>}
          <ul className="hbars">
            {data?.outcomes.map((o) => (
              <li key={o.outcome}>
                <span>{o.label}</span>
                <span className="bar"><i style={{ width: `${(o.n / Math.max(1, resolvedTotal)) * 100}%` }} /></span>
                <b className="mono">{n0(o.n)}</b>
              </li>
            ))}
          </ul>
          {resolvedTotal >= 10 && falseAlarms / resolvedTotal > 0.25 && (
            <p className="callout">{Math.round((falseAlarms / resolvedTotal) * 100)}% were false alarms. Consider raising the thresholds for the rules that cause them.</p>
          )}
        </section>
        <section className="panel">
          <h2>Fleets compared</h2>
          <table>
            <thead><tr><th>Fleet</th><th className="num">Km</th><th className="num">Avg km/h</th><th className="num">Incidents</th><th className="num">Per 100 km</th></tr></thead>
            <tbody>
              {data?.perFleet.map((f) => (
                <tr key={f.fleetId}>
                  <td><i className="fleet" style={{ background: FLEET_COLORS[f.fleetId] }} />{fleetName(f.fleetId)}<div className="dim small">{n0(f.vehicles)} vehicles</div></td>
                  <td className="num">{n0(f.km)}</td>
                  <td className="num">{n1(f.avgSpeed)}</td>
                  <td className="num">{n0(f.incidents)}{f.critical ? <div className="coral small">{f.critical} critical</div> : null}</td>
                  <td className="num">{per100(f.incidents, f.km) == null ? '–' : n1(per100(f.incidents, f.km))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
