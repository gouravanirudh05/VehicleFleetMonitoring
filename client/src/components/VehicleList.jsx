import { useMemo, useRef, useState } from 'react';
import { live, useLive } from '../lib/live.js';
import { FLEET_COLORS, STATUS_LABEL, n0 } from '../lib/format.js';

const ROW = 46;
const OVERSCAN = 6;
const FILTERS = [['all', 'All'], ['moving', 'Moving'], ['idle', 'Idle'], ['stopped', 'Off'], ['offline', 'Offline']];

/**
 * Windowed list: only the rows in view (plus a few either side) are rendered, so 2,000
 * vehicles updating 4 times a second cost the same as twenty.
 */
export default function VehicleList({ selectedId, onSelect }) {
  useLive();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('id');
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef(null);

  const counts = { all: 0, moving: 0, idle: 0, stopped: 0, offline: 0 };
  for (const v of live.vehicles.values()) { counts.all++; counts[v.st] = (counts[v.st] || 0) + 1; }

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const list = [];
    for (const v of live.vehicles.values()) {
      if (filter !== 'all' && v.st !== filter) continue;
      if (needle && !v.id.includes(needle)) continue;
      list.push(v);
    }
    if (sort === 'speed') list.sort((a, b) => (b.sp ?? 0) - (a.sp ?? 0));
    else if (sort === 'fuel') list.sort((a, b) => (a.fu ?? 0) - (b.fu ?? 0));
    else list.sort((a, b) => (a.id < b.id ? -1 : 1));
    return list;
    // live.version drives recomputation at the UI tick rate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter, sort, live.version]);

  const first = Math.max(0, Math.floor(scroll / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + OVERSCAN);

  return (
    <div className="vlist">
      <header className="side-head">
        <h2>Vehicles</h2>
        <p className="dim small">{n0(live.vehicles.size)} in the fleets shown</p>
      </header>
      <div className="vlist-tools">
        <input type="search" placeholder="Search plate" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search vehicles by plate" />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort vehicles">
          <option value="id">Plate</option>
          <option value="speed">Fastest</option>
          <option value="fuel">Lowest fuel</option>
        </select>
      </div>
      <div className="seg" role="group" aria-label="Filter by status">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label} <span className="mono">{n0(counts[k] || 0)}</span>
          </button>
        ))}
      </div>
      <div
        className="vlist-scroll"
        ref={(node) => { box.current = node; if (node && node.clientHeight !== height) setHeight(node.clientHeight); }}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        role="listbox"
        aria-label="Vehicles"
      >
        {!rows.length && <p className="empty">{live.vehicles.size ? 'No vehicles match.' : 'Waiting for vehicles. Is the simulator running?'}</p>}
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((v, i) => (
            <button
              key={v.id}
              type="button"
              role="option"
              aria-selected={v.id === selectedId}
              className={`vrow${v.id === selectedId ? ' sel' : ''}${v.st === 'offline' ? ' off' : ''}`}
              style={{ top: (first + i) * ROW, height: ROW }}
              onClick={() => onSelect(v.id)}
            >
              <i className="fleet" style={{ background: FLEET_COLORS[v.fl] }} />
              <span className="plate">{v.id}</span>
              <span className={`st ${v.st}`}>{STATUS_LABEL[v.st] || '–'}</span>
              <span className="num">{v.sp != null ? `${n0(v.sp)} km/h` : '–'}</span>
              <span className="num dim">{v.fu != null ? `${n0(v.fu)}%` : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
