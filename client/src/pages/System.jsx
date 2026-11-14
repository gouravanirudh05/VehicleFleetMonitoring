import { useEffect, useMemo, useState } from 'react';
import UChart from '../components/UChart.jsx';
import { api } from '../lib/api.js';
import { live, useLive } from '../lib/live.js';
import { useSession } from '../lib/session.jsx';
import { bytes, n0 } from '../lib/format.js';

const LEN = 180;
const BANNER = {
  ok: ['All systems normal', 'Vehicle data is arriving, being saved, and reaching screens on time.'],
  degraded: ['Degraded', 'Something needs a look. The checks below say what and what to do.'],
  down: ['Problem', 'Part of the platform is not working. Start with the red check below.'],
};
const ICON = { ok: '✓', warn: '!', fail: '×' };

/** System health for dispatchers: is data flowing, saved and delivered, and who is connected. */
export default function System() {
  useLive();
  const { meta } = useSession();
  const [series, setSeries] = useState([]);
  const [initial, setInitial] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const m = live.metrics || initial;

  useEffect(() => {
    api('/system').then((r) => { setInitial(r); setSeries(r.series); }).catch(() => {});
    api('/stress-results').then(setCapacity).catch(() => {});
  }, []);

  useEffect(() => {
    const p = live.metrics?.series?.[0];
    if (!p) return;
    setSeries((s) => (s.at(-1)?.t === p.t ? s : [...s, p].slice(-LEN)));
  }, [live.metrics]);

  const tput = useMemo(() => [series.map((p) => p.t / 1000), series.map((p) => p.accepted), series.map((p) => p.dropped)], [series]);
  const lat = useMemo(() => [series.map((p) => p.t / 1000), series.map((p) => p.p95)], [series]);
  const tputOpts = useMemo(() => () => ({
    legend: { show: false }, cursor: { y: false },
    scales: { x: { time: true }, y: { range: (u, min, max) => [0, Math.max(10, max * 1.15)] } },
    series: [{}, { label: 'Saved', stroke: '#1C1C1C', width: 1.5, fill: 'rgba(245,153,88,.18)' }, { label: 'Rejected', stroke: '#C43C2A', width: 1.5 }],
    axes: [{}, { size: 54 }],
  }), []);
  const latOpts = useMemo(() => () => ({
    legend: { show: false }, cursor: { y: false },
    scales: { x: { time: true }, y: { range: (u, min, max) => [0, Math.max(1000, max * 1.15)] } },
    series: [{}, { label: 'p95 ms', stroke: '#C43C2A', width: 1.5 }],
    axes: [{}, { size: 54 }],
  }), []);

  const health = m?.health;
  const t = m?.total || {};
  const r = m?.rate || {};
  const rejected = [
    ['Sent twice', 'duplicate', 'The device retried a reading the platform already had'],
    ['Arrived late', 'late', 'An older reading arrived after a newer one'],
    ['Malformed', 'invalid', 'Missing or impossible values'],
    ['Too frequent', 'rateLimited', 'A device sent faster than allowed'],
    ['Unknown vehicle', 'unknown', 'The device is not registered'],
    ['Server busy', 'overloaded', 'Turned away while storage caught up; devices retry'],
  ];
  const fleetName = (id) => meta?.fleets.find((f) => f.id === id)?.name || id;
  const screens = (m?.rooms || []).map((row) => {
    const [kind, id] = row.room.split(':');
    return { ...row, label: kind === 'fleet' ? fleetName(id) : id, what: kind === 'fleet' ? 'Live map and list' : 'Vehicle detail' };
  });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Platform</p>
          <h1>System health</h1>
        </div>
        <p className="dim small">Updates every second · up {m ? `${Math.floor(m.uptimeSec / 60)} min` : '–'}</p>
      </div>

      {health && (
        <section className={`banner ${health.status}`} role="status">
          <b>{BANNER[health.status][0]}</b>
          <span>{BANNER[health.status][1]}</span>
        </section>
      )}

      <ul className="checks">
        {health?.checks.map((c) => (
          <li key={c.id} className={c.status}>
            <i aria-hidden="true">{ICON[c.status]}</i>
            <div>
              <b>{c.label}</b>
              <span>{c.detail}</span>
              {c.action && <span className="action">{c.action}</span>}
            </div>
          </li>
        ))}
      </ul>

      <div className="grid2">
        <section className="panel">
          <h2>Readings per second <span className="legend"><i className="livel" />saved <i className="coralx" />rejected</span></h2>
          <UChart makeOptions={tputOpts} data={tput} height={190} />
        </section>
        <section className="panel">
          <h2>Time to reach screens, 95th percentile (ms)</h2>
          <UChart makeOptions={latOpts} data={lat} height={190} />
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>Connected screens <span className="dim small">{n0(m?.clients)} open now</span></h2>
          <table>
            <thead><tr><th>Watching</th><th>View</th><th className="num">Screens</th><th className="num">Updates / s</th><th className="num">Data / s</th></tr></thead>
            <tbody>
              {screens.map((row) => (
                <tr key={row.room}>
                  <td>{row.label}</td>
                  <td className="dim">{row.what}</td>
                  <td className="num">{n0(row.screens)}</td>
                  <td className="num">{n0(row.msgsPerSec)}</td>
                  <td className="num">{bytes(row.bytesPerSec)}</td>
                </tr>
              ))}
              {!screens.length && <tr><td colSpan={5} className="dim">No screens connected.</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>Rejected readings <span className="dim small">since the server started</span></h2>
          <table>
            <tbody>
              {rejected.map(([label, k, help]) => (
                <tr key={k}><td>{label}<div className="dim small">{help}</div></td><td className="num">{n0(t[k])}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>Server</h2>
          <table>
            <tbody>
              <tr><td>Readings in / saved per second</td><td className="num">{n0(r.received)} / {n0(r.accepted)}</td></tr>
              <tr><td>Readings saved since start</td><td className="num">{n0(t.written)}</td></tr>
              <tr><td>Waiting to be saved</td><td className="num">{n0(m?.flush?.pending)}</td></tr>
              <tr><td>Last save</td><td className="num">{n0(m?.flush?.lastDocs)} readings in {n0(m?.flush?.lastMs)} ms</td></tr>
              <tr><td>Vehicles known</td><td className="num">{n0(m?.vehicles)}</td></tr>
              <tr><td>Incidents raised since start</td><td className="num">{n0(t.alerts)}</td></tr>
              <tr><td>Event-loop delay, p99</td><td className="num">{m ? `${m.eventLoopP99Ms} ms` : '–'}</td></tr>
              <tr><td>Memory</td><td className="num">{m ? `${m.rssMb} MB` : '–'}</td></tr>
            </tbody>
          </table>
        </section>
        {capacity && (
          <section className="panel">
            <h2>Last capacity test <span className="dim small">{new Date(capacity.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span></h2>
            <table>
              <tbody>
                <tr><td>Vehicles reporting every second</td><td className="num">{n0(capacity.vehicles)}</td></tr>
                <tr><td>Readings saved per second</td><td className="num">{n0(capacity.acceptedPerSec)}</td></tr>
                <tr><td>Screens connected</td><td className="num">{n0(capacity.connectedAtEnd)} of {n0(capacity.clients)}</td></tr>
                <tr><td>Time to reach screens, median / 95th</td><td className="num">{capacity.latencyMs.p50} / {capacity.latencyMs.p95} ms</td></tr>
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
