// Warm light basemap drawn from OpenFreeMap's free OpenStreetMap vector tiles (OpenMapTiles
// schema, no API key). Cream land, white roads, quiet labels, so vehicles and alerts stand out.
const FONT = ['Noto Sans Regular'];
const LAND = '#F3F0EC';
const WATER = '#D5DADB';

const road = (classes) => ['match', ['get', 'class'], classes, true, false];

export const MAP_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': LAND } },
    { id: 'park', type: 'fill', source: 'osm', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['park', 'cemetery', 'grass', 'stadium', 'pitch']]], paint: { 'fill-color': '#E4E2D0', 'fill-opacity': 0.9 } },
    { id: 'wood', type: 'fill', source: 'osm', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland']]], paint: { 'fill-color': '#E8E5D7', 'fill-opacity': 0.7 } },
    { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': WATER } },
    { id: 'aeroway', type: 'line', source: 'osm', 'source-layer': 'aeroway', filter: ['==', ['get', 'class'], 'runway'], paint: { 'line-color': '#DDD5CB', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 2, 15, 20] } },
    { id: 'building', type: 'fill', source: 'osm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': '#E7E0D7', 'fill-opacity': 0.9 } },
    {
      id: 'road-minor', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 12,
      filter: road(['minor', 'service', 'tertiary']),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.5, 16, 6] },
    },
    {
      id: 'road-major', type: 'line', source: 'osm', 'source-layer': 'transportation',
      filter: road(['primary', 'secondary', 'trunk']),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 0.6, 12, 1.8, 16, 10] },
    },
    {
      id: 'road-motorway', type: 'line', source: 'osm', 'source-layer': 'transportation',
      filter: road(['motorway']),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#F7D4B6', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.8, 12, 2.4, 16, 12] },
    },
    {
      id: 'rail', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 11,
      filter: road(['rail', 'transit']),
      paint: { 'line-color': '#CFC5B8', 'line-width': 1, 'line-dasharray': [2, 2] },
    },
    {
      id: 'road-label', type: 'symbol', source: 'osm', 'source-layer': 'transportation_name', minzoom: 13,
      layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT, 'text-size': 10.5 },
      paint: { 'text-color': '#8C7867', 'text-halo-color': LAND, 'text-halo-width': 1.2 },
    },
    {
      id: 'place', type: 'symbol', source: 'osm', 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'neighbourhood', 'village']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT,
        'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 11],
        'text-transform': 'uppercase', 'text-letter-spacing': 0.08, 'text-max-width': 8,
      },
      paint: { 'text-color': ['match', ['get', 'class'], 'city', '#2A211B', '#8C7867'], 'text-halo-color': LAND, 'text-halo-width': 1.4 },
    },
  ],
};

export const MAP_FONT = FONT;
