import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';
import MapView from '../components/MapView.jsx';
import VehicleList from '../components/VehicleList.jsx';
import Attention from '../components/Attention.jsx';
import IncidentPanel from '../components/IncidentPanel.jsx';
import VehicleDetail from '../components/VehicleDetail.jsx';
import { live, useLive } from '../lib/live.js';
import { useSession } from '../lib/session.jsx';
import { n0 } from '../lib/format.js';

const WIDE = '(min-width: 1280px)';
function useWide() {
  return useSyncExternalStore(
    (fn) => { const m = matchMedia(WIDE); m.addEventListener('change', fn); return () => m.removeEventListener('change', fn); },
    () => matchMedia(WIDE).matches,
  );
}

function Counters() {
  useLive();
  let moving = 0; let stopped = 0; let offline = 0;
  for (const v of live.vehicles.values()) {
    if (v.st === 'moving') moving++; else if (v.st === 'offline') offline++; else stopped++;
  }
  const open = live.openIncidents();
  const critical = open.filter((i) => i.severity === 'critical').length;
  return (
    <div className="counters" aria-label="Fleet at a glance">
      <div><b>{n0(moving)}</b><small>On the road</small></div>
      <div><b>{n0(stopped)}</b><small>Stopped</small></div>
      <div className={offline ? 'warnv' : ''}><b>{n0(offline)}</b><small>Not reporting</small></div>
      <div className={critical ? 'hot' : ''}><b>{n0(critical)}</b><small>Critical open</small></div>
    </div>
  );
}

/**
 * Control room. Left: incidents to work. Centre: the map. Right: the open incident, the
 * open vehicle, or the vehicle list. `?i=<incident>` and `?v=<vehicle>` make views linkable.
 */
export default function Live() {
  const { meta } = useSession();
  const wide = useWide();
  const [params, setParams] = useSearchParams();
  const vehicle = params.get('v');
  const incidentId = params.get('i');
  const [tab, setTab] = useState('attention');
  const [trail, setTrail] = useState(null);
  useLive();

  const go = useCallback((key, id) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete('v'); n.delete('i');
      if (id) n.set(key, id);
      return n;
    }, { replace: true });
  }, [setParams]);
  const openVehicle = useCallback((id) => go('v', id), [go]);
  const openIncident = useCallback((id) => go('i', id), [go]);
  const close = useCallback(() => go(null, null), [go]);

  useEffect(() => { if (!vehicle) setTrail(null); }, [vehicle]);

  const focus = vehicle || (incidentId && live.incidents.get(incidentId)?.vehicleId) || null;
  const open = live.openIncidents().length;

  let panel;
  if (incidentId) panel = <IncidentPanel key={incidentId} id={incidentId} onClose={close} onVehicle={openVehicle} />;
  else if (vehicle) panel = <VehicleDetail key={vehicle} id={vehicle} onClose={close} onTrail={setTrail} onIncident={openIncident} />;
  else panel = <VehicleList selectedId={vehicle} onSelect={openVehicle} />;

  return (
    <div className={`live-page${wide ? ' wide' : ''}`}>
      {wide && <Attention selectedId={incidentId} onOpen={openIncident} />}
      <div className="map-wrap">
        <MapView meta={meta} selectedId={focus} onSelect={openVehicle} trail={trail} />
        <Counters />
        {!live.fleets.length && <div className="map-note">No fleets selected. Choose one at the top.</div>}
      </div>
      <aside className="side">
        {wide || incidentId || vehicle ? panel : (
          <>
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'attention'} className={tab === 'attention' ? 'on' : ''} onClick={() => setTab('attention')}>
                Needs attention {open > 0 && <span className="badge">{open > 99 ? '99+' : open}</span>}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'vehicles'} className={tab === 'vehicles' ? 'on' : ''} onClick={() => setTab('vehicles')}>Vehicles</button>
            </div>
            {tab === 'attention' ? <Attention selectedId={incidentId} onOpen={openIncident} /> : panel}
          </>
        )}
      </aside>
    </div>
  );
}
