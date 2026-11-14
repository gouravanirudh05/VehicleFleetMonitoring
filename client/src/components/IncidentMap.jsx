import { useEffect, useRef } from 'react';
import maplibregl from '../lib/maplibre.js';
import { MAP_STYLE } from '../lib/mapStyle.js';

const fc = (points) => ({
  type: 'FeatureCollection',
  features: points.map(([lng, lat, rule, severity]) => ({ type: 'Feature', properties: { rule, w: severity === 'critical' ? 1 : 0.5 }, geometry: { type: 'Point', coordinates: [lng, lat] } })),
});

/**
 * Heatmap of where incidents happened. Zoomed out it shows hotspots; zoomed in it fades into
 * individual incident dots. Critical incidents weigh twice as much as warnings.
 */
export default function IncidentMap({ points }) {
  const el = useRef(null);
  const map = useRef(null);
  const ready = useRef(false);
  const latest = useRef(points);
  latest.current = points;

  useEffect(() => {
    const m = new maplibregl.Map({
      container: el.current, style: MAP_STYLE, center: [77.61, 12.99], zoom: 10.2,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: true,
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    m.on('load', () => {
      m.addSource('incidents', { type: 'geojson', data: fc(latest.current || []) });
      m.addLayer({
        id: 'heat', type: 'heatmap', source: 'incidents', maxzoom: 15,
        paint: {
          'heatmap-weight': ['get', 'w'],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 14, 1.4],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 26],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0.9, 15, 0],
          // transparent -> yellow -> orange -> brick red as incidents concentrate
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(243,240,236,0)', 0.15, 'rgba(244,222,96,.55)', 0.4, 'rgba(245,153,88,.75)', 0.7, 'rgba(226,104,52,.9)', 1, '#C43C2A'],
        },
      });
      m.addLayer({
        id: 'dots', type: 'circle', source: 'incidents', minzoom: 12,
        paint: {
          'circle-radius': 4, 'circle-color': ['case', ['==', ['get', 'w'], 1], '#C43C2A', '#F59958'],
          'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 1,
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, 1],
        },
      });
      ready.current = true;
    });
    return () => { ready.current = false; m.remove(); };
  }, []);

  useEffect(() => {
    if (ready.current) map.current.getSource('incidents')?.setData(fc(points || []));
  }, [points]);

  return <div ref={el} className="incident-map" role="region" aria-label="Map of where incidents happened" />;
}
