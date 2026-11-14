import { useEffect, useRef } from 'react';
import maplibregl from '../lib/maplibre.js';
import { live } from '../lib/live.js';
import { FLEET_COLORS } from '../lib/format.js';
import { MAP_STYLE, MAP_FONT } from '../lib/mapStyle.js';

function circle(lat, lng, km, steps = 72) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([lng + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
  }
  return ring;
}

const fc = (features) => ({ type: 'FeatureCollection', features });


/** Live map. Reads vehicles straight from the store on each UI tick instead of via React props. */
export default function MapView({ meta, selectedId, onSelect, trail }) {
  const el = useRef(null);
  const map = useRef(null);
  const ready = useRef(false);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const m = new maplibregl.Map({
      container: el.current,
      style: MAP_STYLE,
      center: [77.61, 12.99],
      zoom: 10.4,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

    m.on('load', () => {
      m.addSource('zones', { type: 'geojson', data: fc([]) });
      m.addSource('fences', { type: 'geojson', data: fc([]) });
      m.addSource('trail', { type: 'geojson', data: fc([]) });
      m.addSource('vehicles', { type: 'geojson', data: fc([]) });

      m.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#F59958', 'fill-opacity': 0.1 } });
      m.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': '#D9772F', 'line-opacity': 0.55, 'line-width': 1 } });
      m.addLayer({ id: 'zones-label', type: 'symbol', source: 'zones', layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': MAP_FONT, 'symbol-placement': 'line', 'text-offset': [0, -0.7] }, paint: { 'text-color': '#A4501E', 'text-halo-color': '#F3F0EC', 'text-halo-width': 1.2 } });
      m.addLayer({ id: 'fences', type: 'line', source: 'fences', paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.45, 'line-width': 1.2, 'line-dasharray': [3, 3] } });
      m.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.95 } });
      m.addLayer({ id: 'alert-halo', type: 'circle', source: 'vehicles', filter: ['==', ['get', 'al'], 1], paint: { 'circle-radius': 11, 'circle-color': 'rgba(196,60,42,0.14)', 'circle-stroke-color': '#C43C2A', 'circle-stroke-width': 1.5 } });
      m.addLayer({
        id: 'vehicles', type: 'circle', source: 'vehicles',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.6, 12, 4.5, 15, 7],
          'circle-color': ['case', ['==', ['get', 'st'], 'offline'], '#C1B2A2', ['get', 'color']],
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 1,
        },
      });
      m.addLayer({ id: 'selected', type: 'circle', source: 'vehicles', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#1C1C1C', 'circle-stroke-width': 2.5 } });

      m.on('click', 'vehicles', (e) => onSelect(e.features[0]?.properties.id));
      m.on('click', 'alert-halo', (e) => onSelect(e.features[0]?.properties.id));
      m.on('mouseenter', 'vehicles', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'vehicles', () => { m.getCanvas().style.cursor = ''; });
      ready.current = true;
      draw();
    });

    function draw() {
      if (!ready.current) return;
      // A ring marks every vehicle with an incident that is happening right now.
      const alerting = new Set();
      for (const i of live.incidents.values()) if (i.status === 'active') alerting.add(i.vehicleId);
      const features = [];
      for (const v of live.vehicles.values()) {
        if (v.la == null) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [v.ln, v.la] },
          properties: { id: v.id, st: v.st, color: FLEET_COLORS[v.fl] || '#5D6C7B', al: alerting.has(v.id) ? 1 : 0 },
        });
      }
      m.getSource('vehicles')?.setData(fc(features));
    }

    const unsub = live.subscribeStore(draw);
    return () => { unsub(); ready.current = false; m.remove(); };
    // onSelect is stable for the page's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Geofences and speed zones once fleet metadata arrives.
  useEffect(() => {
    const m = map.current;
    if (!meta || !m) return;
    const apply = () => {
      m.getSource('fences')?.setData(fc(meta.fleets.map((f) => ({
        type: 'Feature', properties: { color: f.color }, geometry: { type: 'LineString', coordinates: circle(f.geofence.lat, f.geofence.lng, f.geofence.radiusKm) },
      }))));
      const zones = meta.zones.map((z) => circle(z.lat, z.lng, z.radiusKm));
      m.getSource('zones')?.setData(fc(meta.zones.map((z, i) => ({
        type: 'Feature', properties: { label: `${z.limitKmh} km/h · ${z.name}` }, geometry: { type: 'Polygon', coordinates: [zones[i]] },
      }))));
    };
    if (ready.current) apply(); else m.once('load', apply);
  }, [meta]);

  // Selected vehicle ring and trail.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      m.setFilter('selected', ['==', ['get', 'id'], selectedId || '']);
      const features = [];
      if (trail?.history?.length > 1) features.push({ type: 'Feature', properties: { color: '#B9A897', width: 3 }, geometry: { type: 'LineString', coordinates: trail.history } });
      if (trail?.live?.length > 1) features.push({ type: 'Feature', properties: { color: '#1C1C1C', width: 3.5 }, geometry: { type: 'LineString', coordinates: trail.live } });
      m.getSource('trail')?.setData(fc(features));
    };
    if (ready.current) apply(); else m.once('load', apply);
  }, [selectedId, trail]);

  // Fly to a newly selected vehicle.
  useEffect(() => {
    const v = selectedId && live.vehicles.get(selectedId);
    if (v && map.current) map.current.easeTo({ center: [v.ln, v.la], zoom: Math.max(map.current.getZoom(), 12.5), duration: 700 });
  }, [selectedId]);

  return <div ref={el} className="map" role="region" aria-label="Live map of vehicles" />;
}
