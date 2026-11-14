import * as maplibregl from 'maplibre-gl';
// MapLibre runs tile and GeoJSON work in a module worker. Vite bundles it as its own file and
// hands back its URL, because the library's default import.meta.url lookup breaks once bundled.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.setWorkerUrl(workerUrl);
export default maplibregl;
