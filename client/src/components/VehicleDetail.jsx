import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { live, useLive } from '../lib/live.js';
import { FLEET_COLORS, STATUS_LABEL, driverFor, n0, clock } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import UChart from './UChart.jsx';
import { IncidentCard, sortIncidents } from './Attention.jsx';

const RANGES = [5, 15, 60];
// tuple: [seq, ts, lat, lng, speed, fuel, engine]

/**
 * History + live for one vehicle, without gaps or duplicates:
 *   1. join the vehicle's room and hold incoming events,
 *   2. load history (the server includes events it has not written yet),
 *   3. merge both into one map keyed by sequence number, so overlap is dropped.
 * The last history seq is the "seam" drawn on the chart and the map trail.
 */
function useMergedSeries(id, minutes, online) {
  const points = useRef(new Map());
  const seam = useRef(null);
  const stats = useRef({ history: 0, live: 0, dupes: 0 }); // kept for debugging the merge
  const dirty = useRef(true);
  const [status, setStatus] = useState({ loading: true, error: '' });

  useEffect(() => {
    if (!online) return undefined;
    points.current = new Map();
    seam.current = null;
    stats.current = { history: 0, live: 0, dupes: 0 };
    dirty.current = true;
    setStatus({ loading: true, error: '' });

    let loaded = false;
    let cancelled = false;
    const held = [];
    const add = (events) => {
      for (const e of events) {
        if (points.current.has(e[0])) stats.current.dupes++;
        else { points.current.set(e[0], e); stats.current.live++; }
      }
      dirty.current = true;
    };
    const w = live.watch(id, (events) => (loaded ? add(events) : held.push(...events)));

    (async () => {
      await w.ready;
      const h = await api(`/vehicles/${encodeURIComponent(id)}/history?minutes=${minutes}`);
      if (cancelled) return;
      for (const p of h.points) points.current.set(p[0], p);
      stats.current.history = h.points.length;
      seam.current = h.lastSeq;
      loaded = true;
      add(held);
      setStatus({ loading: false, error: '' });
    })().catch((e) => !cancelled && setStatus({ loading: false, error: e.message }));

    return () => { cancelled = true; w.stop(); };
  }, [id, minutes, online]);

  return { points, seam, stats, dirty, status };
}

function buildSeries(points, seamSeq, minutes) {
  const cutoff = Date.now() - minutes * 60_000;
  const list = [...points.values()].filter((p) => p[1] >= cutoff).sort((a, b) => a[0] - b[0]);
  const xs = []; const hist = []; const liv = []; const fuel = []; const eng = [];
  const trail = { history: [], live: [] };
  let seamX = null;
  for (const p of list) {
    const isHist = seamSeq != null && p[0] <= seamSeq;
    const isSeam = p[0] === seamSeq;
    xs.push(p[1] / 1000);
    hist.push(isHist ? p[4] : null);
    liv.push(!isHist || isSeam ? p[4] : null);
    fuel.push(p[5]);
    eng.push(p[6]);
    if (isHist) trail.history.push([p[3], p[2]]);
    if (!isHist || isSeam) trail.live.push([p[3], p[2]]);
    if (isSeam) seamX = p[1] / 1000;
  }
  return { speed: [xs, hist, liv], engine: [xs, eng, fuel], trail, seamX, count: list.length };
}

const seamPlugin = (seamRef) => ({
  hooks: {
    draw: [(u) => {
      const x = seamRef.current;
      if (x == null || x < u.scales.x.min || x > u.scales.x.max) return;
      const cx = Math.round(u.valToPos(x, 'x', true));
      const { ctx } = u;
      const { top, height } = u.bbox;
      ctx.save();
      ctx.strokeStyle = '#F59958';
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + height); ctx.stroke();
      ctx.fillStyle = '#A4501E';
      ctx.font = `${10 * devicePixelRatio}px "IBM Plex Mono", monospace`;
      ctx.fillText('NOW', cx + 5 * devicePixelRatio, top + 12 * devicePixelRatio);
      ctx.restore();
    }],
  },
});

function FollowUps({ id, list, onChange }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const has = (kind) => list.some((f) => f.kind === kind);
  const book = async (kind) => {
    setBusy(kind); setErr('');
    try {
      await api('/followups', { method: 'POST', body: { vehicleId: id, kind, dueInDays: kind === 'maintenance' ? 2 : 7, reason: 'Booked from the control room' } });
      onChange();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  return (
    <>
      <h3 className="chart-title">Follow-ups</h3>
      {list.length > 0 && (
        <ul className="fu-list">
          {list.map((f) => <li key={f.id}><b>{f.kind === 'coaching' ? 'Driver coaching' : 'Maintenance check'}</b> <span className="dim">due {new Date(f.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></li>)}
        </ul>
      )}
      <div className="cmd-grid">
        {!has('coaching') && <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => book('coaching')}>{busy === 'coaching' ? 'Booking' : 'Book driver coaching'}</button>}
        {!has('maintenance') && <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => book('maintenance')}>{busy === 'maintenance' ? 'Booking' : 'Book maintenance check'}</button>}
      </div>
      {err && <p className="err">{err}</p>}
    </>
  );
}

export default function VehicleDetail({ id, onClose, onTrail, onIncident }) {
  useLive();
  const { meta } = useSession();
  const [minutes, setMinutes] = useState(15);
  const online = live.status === 'live';
  const { points, seam, dirty, status } = useMergedSeries(id, minutes, online);
  const [series, setSeries] = useState(null);
  const seamX = useRef(null);
  const [info, setInfo] = useState({ resolved: [], followUps: [] });
  const [reload, setReload] = useState(0);

  // Rebuild chart arrays at most once per UI tick, and only if new points arrived.
  useEffect(() => {
    if (!dirty.current || status.loading) return;
    dirty.current = false;
    const s = buildSeries(points.current, seam.current, minutes);
    seamX.current = s.seamX;
    setSeries(s);
    onTrail?.(s.trail);
  });

  useEffect(() => () => onTrail?.(null), [onTrail]);

  useEffect(() => {
    let cancelled = false;
    api(`/vehicles/${encodeURIComponent(id)}`).then((r) => !cancelled && setInfo(r)).catch(() => {});
    return () => { cancelled = true; };
  }, [id, reload]);

  const open = [...live.incidents.values()].filter((i) => i.vehicleId === id && i.status !== 'resolved').sort(sortIncidents);
  const v = live.vehicles.get(id);
  const fleet = meta?.fleets.find((f) => f.id === v?.fl);
  const driver = driverFor(id);
  const speedOpts = useMemo(() => () => ({
    legend: { show: false },
    cursor: { y: false, points: { size: 6 } },
    scales: { x: { time: true }, y: { range: (u, min, max) => [0, Math.max(80, Math.ceil((max || 0) / 20) * 20)] } },
    series: [{}, { label: 'Earlier', stroke: '#B9A897', width: 1.5 }, { label: 'Live', stroke: '#1C1C1C', width: 2 }],
    axes: [{}, { size: 42, values: (u, vals) => vals.map((x) => `${x}`) }],
    plugins: [seamPlugin(seamX)],
  }), []);
  const engOpts = useMemo(() => () => ({
    legend: { show: false },
    cursor: { y: false },
    scales: { x: { time: true }, t: { range: [60, 120] }, f: { range: [0, 100] } },
    series: [{}, { label: 'Engine °C', stroke: '#C43C2A', width: 1.5, scale: 't' }, { label: 'Fuel %', stroke: '#5D6C7B', width: 1.5, scale: 'f' }],
    axes: [{}, { scale: 't', size: 42 }, { scale: 'f', side: 1, size: 36, grid: { show: false } }],
  }), []);

  return (
    <section className="detail" aria-label={`Vehicle ${id}`}>
      <header className="detail-head">
        <div>
          <p className="eyebrow"><i className="fleet" style={{ background: FLEET_COLORS[v?.fl] }} />{fleet?.name || v?.fl || ''} · {v?.k || ''}</p>
          <h2>{id}</h2>
          <p className="small">{driver.name} <span className="dim">· last report {v?.ts ? clock(v.ts) : '–'}</span></p>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close vehicle details">×</button>
      </header>

      <div className="kpis">
        <div><b>{n0(v?.sp)}</b><small>km/h</small></div>
        <div className={v?.fu < 15 ? 'warnv' : ''}><b>{n0(v?.fu)}</b><small>fuel %</small></div>
        <div className={v?.en >= 105 ? 'hot' : ''}><b>{n0(v?.en)}</b><small>engine °C</small></div>
        <div><b className={`st ${v?.st}`}>{STATUS_LABEL[v?.st] || '–'}</b><small>status</small></div>
      </div>

      {open.length > 0 && (
        <>
          <h3 className="chart-title">Open incidents</h3>
          <ul className="inc-list">{open.map((i) => <IncidentCard key={i.id} inc={i} onOpen={onIncident} />)}</ul>
        </>
      )}

      <div className="detail-bar">
        <h3 className="chart-title">Speed, km/h</h3>
        <div className="seg" role="group" aria-label="How far back">
          {RANGES.map((m) => (
            <button key={m} type="button" className={m === minutes ? 'on' : ''} aria-pressed={m === minutes} onClick={() => setMinutes(m)}>{m} min</button>
          ))}
        </div>
      </div>
      {status.error && <p className="err">{status.error}</p>}
      {status.loading && !status.error && <p className="dim loading">Loading the last {minutes} minutes…</p>}
      <UChart makeOptions={speedOpts} data={series?.speed || [[], [], []]} height={150} />
      <h3 className="chart-title">Engine and fuel <span className="legend"><i className="coralx" />engine °C <i className="mistl" />fuel %</span></h3>
      <UChart makeOptions={engOpts} data={series?.engine || [[], [], []]} height={130} />

      <h3 className="chart-title">What's normal for this vehicle</h3>
      {info.model ? (
        info.model.trained ? (
          <ul className="model-facts">
            <li><span>Engine at this speed</span><b>{info.model.normalEngineC} °C <span className="dim">±{info.model.engineSpreadC}</span></b></li>
            <li><span>Fuel use</span><b>{info.model.fuelPerKm != null ? `${info.model.fuelPerKm.toFixed(2)}% per km` : 'still learning'}</b></li>
            <li><span>Now</span><b>{v?.en != null && info.model.normalEngineC != null ? `${v.en - info.model.normalEngineC >= 0 ? '+' : ''}${(v.en - info.model.normalEngineC).toFixed(1)} °C vs normal` : '–'}</b></li>
          </ul>
        ) : <p className="dim small">{info.model.needsVariedDriving
          ? 'Still learning: this vehicle needs to drive at a few different speeds before its engine can be judged.'
          : `Learning this vehicle's normal behaviour (${Math.round(info.model.progress * 100)}%). Early warnings start after about 6 minutes of driving.`}</p>
      ) : <p className="dim small">No data yet.</p>}

      <FollowUps id={id} list={info.followUps || []} onChange={() => setReload((n) => n + 1)} />

      {info.resolved?.length > 0 && (
        <>
          <h3 className="chart-title">Recently resolved</h3>
          <ul className="inc-list">{info.resolved.slice(0, 5).map((i) => <IncidentCard key={i.id} inc={i} onOpen={onIncident} />)}</ul>
        </>
      )}
    </section>
  );
}
