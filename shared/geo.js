// Geography shared by the server (rules, access control) and the simulator (routes).
// Coordinates are approximate polylines along real Bengaluru roads, drawn by hand.

export const FLEETS = [
  {
    id: 'north-depot',
    name: 'North Depot',
    purpose: 'Heavy trucks hauling building materials out of the Peenya industrial area',
    color: '#EE8640',
    kinds: ['truck', 'truck', 'truck', 'van'],
    geofence: { lat: 12.975, lng: 77.6, radiusKm: 16 },
  },
  {
    id: 'airport-shuttle',
    name: 'Airport Shuttle',
    purpose: 'Buses and cabs carrying passengers and crew to Kempegowda Airport',
    color: '#2A211B',
    kinds: ['bus', 'bus', 'suv', 'suv', 'sedan'],
    geofence: { lat: 13.08, lng: 77.64, radiusKm: 20 },
  },
  {
    id: 'city-logistics',
    name: 'City Logistics',
    purpose: 'Vans and bikes making last-mile parcel deliveries across the city',
    color: '#5D6C7B',
    kinds: ['van', 'van', 'bike', 'bike', 'sedan'],
    geofence: { lat: 12.95, lng: 77.62, radiusKm: 18 },
  },
];

export const FLEET_IDS = FLEETS.map((f) => f.id);

// Speed zones. Anywhere outside these uses DEFAULT_LIMIT_KMH.
export const DEFAULT_LIMIT_KMH = 60;
export const ZONES = [
  { id: 'cbd', name: 'Central business district', lat: 12.9756, lng: 77.605, radiusKm: 3, limitKmh: 40 },
  { id: 'airport-road', name: 'Airport road', lat: 13.13, lng: 77.62, radiusKm: 8, limitKmh: 80 },
  { id: 'ecity-flyover', name: 'Electronic City flyover', lat: 12.875, lng: 77.645, radiusKm: 3.5, limitKmh: 80 },
];

export const ROUTES = [
  {
    id: 'orr', fleetId: 'north-depot', name: 'Outer Ring Road', loop: true,
    points: [
      [13.0358, 77.597], [13.0446, 77.6215], [13.0352, 77.644], [13.0185, 77.672], [13.0076, 77.6957],
      [12.985, 77.704], [12.9569, 77.7011], [12.9365, 77.6905], [12.926, 77.6762], [12.9237, 77.648],
      [12.9177, 77.6233], [12.9166, 77.6101], [12.9063, 77.5857], [12.912, 77.563], [12.925, 77.545],
      [12.942, 77.523], [12.96, 77.51], [12.99, 77.515], [13.012, 77.524], [13.029, 77.532],
      [13.0335, 77.555], [13.0358, 77.597],
    ],
  },
  {
    id: 'tumkur-road', fleetId: 'north-depot', name: 'Tumkur Road', loop: false,
    points: [[12.9767, 77.5713], [12.995, 77.556], [13.0125, 77.5455], [13.029, 77.532], [13.04, 77.512], [13.045, 77.5]],
  },
  {
    id: 'airport', fleetId: 'airport-shuttle', name: 'Majestic to Airport', loop: false,
    points: [
      [12.9767, 77.5713], [12.9925, 77.5795], [13.014, 77.583], [13.0358, 77.597], [13.062, 77.5965],
      [13.1, 77.596], [13.135, 77.6105], [13.16, 77.638], [13.18, 77.675], [13.1986, 77.7066],
    ],
  },
  {
    id: 'airport-east', fleetId: 'airport-shuttle', name: 'Whitefield to Airport', loop: false,
    points: [[12.9698, 77.75], [12.995, 77.725], [13.0076, 77.6957], [13.0352, 77.644], [13.0446, 77.6215], [13.0358, 77.597], [13.1, 77.596], [13.1986, 77.7066]],
  },
  {
    id: 'hosur-road', fleetId: 'city-logistics', name: 'Electronic City to MG Road', loop: false,
    points: [[12.8452, 77.6602], [12.87, 77.648], [12.895, 77.632], [12.9177, 77.6233], [12.9352, 77.6245], [12.951, 77.618], [12.965, 77.61], [12.9756, 77.605]],
  },
  {
    id: 'old-airport-road', fleetId: 'city-logistics', name: 'Whitefield to MG Road', loop: false,
    points: [[12.9698, 77.75], [12.9569, 77.7011], [12.96, 77.675], [12.9606, 77.6484], [12.9719, 77.6412], [12.9745, 77.62], [12.9756, 77.605]],
  },
  {
    id: 'mysore-road', fleetId: 'city-logistics', name: 'Kengeri to Majestic', loop: false,
    points: [[12.9081, 77.4826], [12.922, 77.505], [12.942, 77.523], [12.955, 77.545], [12.966, 77.562], [12.9767, 77.5713]],
  },
];

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

export function zoneAt(lat, lng) {
  for (const z of ZONES) if (distanceKm(lat, lng, z.lat, z.lng) <= z.radiusKm) return z;
  return null;
}

export function speedLimitAt(lat, lng) {
  const z = zoneAt(lat, lng);
  return z ? z.limitKmh : DEFAULT_LIMIT_KMH;
}

export function fleetById(id) {
  return FLEETS.find((f) => f.id === id) || null;
}

export function insideGeofence(fleetId, lat, lng) {
  const f = fleetById(fleetId);
  if (!f) return true;
  return distanceKm(lat, lng, f.geofence.lat, f.geofence.lng) <= f.geofence.radiusKm;
}
