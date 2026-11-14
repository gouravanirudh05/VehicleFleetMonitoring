#!/usr/bin/env node
// Simulated fleet. Each vehicle drives a hand-drawn Bengaluru route, reports once a second,
// and now and then misbehaves (overspeed, harsh braking, overheating, long stops, leaving its
// geofence) so the server's rules have something to catch. The network is unreliable on
// purpose: a small share of events is resent (duplicates) or delivered out of order.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { FLEETS, ROUTES, distanceKm, speedLimitAt, fleetById } from '../shared/geo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SIM_URL || 'http://localhost:4000' },
    key: { type: 'string', default: process.env.DEVICE_API_KEY || 'dev-device-key' },
    vehicles: { type: 'string', default: process.env.SIM_VEHICLES || '300' },
    hz: { type: 'string', default: '1' },
    'batch-ms': { type: 'string', default: '250' },
    dup: { type: 'string', default: '0.01' },
    late: { type: 'string', default: '0.005' },
    malformed: { type: 'string', default: '0' },
    anomaly: { type: 'string', default: '1' },
    duration: { type: 'string', default: '0' },
    quiet: { type: 'boolean', default: false },
    truth: { type: 'string', default: '' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Usage: npm run simulate -- [options]
  --vehicles N     number of vehicles (default ${args.vehicles})
  --hz N           reports per vehicle per second (default 1)
  --batch-ms N     how often batches are POSTed (default 250)
  --dup P          share of events resent as duplicates (default 0.01)
  --late P         share of events delivered out of order (default 0.005)
  --malformed P    share of deliberately invalid events (default 0)
  --anomaly X      multiplier on anomaly frequency (default 1)
  --duration S     stop after S seconds (default: run forever)
  --truth FILE     append each injected fault (vehicle, type, start) to FILE as JSON lines
  --url URL        server (default ${args.url})`);
  process.exit(0);
}

const N = Math.max(1, Number(args.vehicles));
const HZ = Math.max(0.1, Number(args.hz));
const BATCH_MS = Math.max(50, Number(args['batch-ms']));
const P_DUP = Number(args.dup);
const P_LATE = Number(args.late);
const P_BAD = Number(args.malformed);
const ANOM = Number(args.anomaly);
const MAX_BATCH = 1000;

/* ---------------- deterministic randomness ---------------- */
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(20261113);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + rnd() * (b - a);

/* ---------------- routes as measured polylines ---------------- */
const routes = ROUTES.map((r) => {
  const cum = [0];
  for (let i = 1; i < r.points.length; i++) {
    cum.push(cum[i - 1] + distanceKm(...r.points[i - 1], ...r.points[i]));
  }
  return { ...r, cum, lengthKm: cum.at(-1) };
});

function pointAt(route, km) {
  const { points, cum } = route;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < km) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (km - cum[i - 1]) / seg));
  const [a1, o1] = points[i - 1];
  const [a2, o2] = points[i];
  const bearing = (Math.atan2((o2 - o1) * Math.cos((a1 * Math.PI) / 180), a2 - a1) * 180) / Math.PI;
  return { lat: a1 + (a2 - a1) * f, lng: o1 + (o2 - o1) * f, heading: (bearing + 360) % 360 };
}

/* ---------------- vehicles ---------------- */
const KIND = {
  truck: { cruise: [38, 55], tank: 300 },
  van: { cruise: [35, 58], tank: 70 },
  bus: { cruise: [40, 62], tank: 250 },
  suv: { cruise: [42, 65], tank: 65 },
  sedan: { cruise: [42, 65], tank: 50 },
  bike: { cruise: [30, 55], tank: 12 },
};
const STATES = ['KA01', 'KA02', 'KA03', 'KA04', 'KA05', 'KA41', 'KA51', 'KA53'];
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
function plate(i) {
  const r = (i * 7919) % 9000;
  return `${STATES[i % STATES.length]}-${LETTERS[(i * 7) % 23]}${LETTERS[(i * 13 + 5) % 23]}-${1000 + r}`;
}

// Device sequence numbers must keep rising across simulator restarts, as a real device's
// would. Starting from tenths of a second since the epoch guarantees that at <= 10 Hz.
const SEQ_START = Math.floor(Date.now() / 100);

const vehicles = Array.from({ length: N }, (_, i) => {
  const fleet = FLEETS[i % FLEETS.length];
  const kind = pick(fleet.kinds);
  const fleetRoutes = routes.filter((r) => r.fleetId === fleet.id);
  const route = pick(fleetRoutes);
  return {
    vehicleId: plate(i),
    fleetId: fleet.id,
    kind,
    route,
    km: rnd() * route.lengthKm,
    dir: rnd() < 0.5 ? 1 : -1,
    lane: between(-0.00012, 0.00012),
    speed: between(...KIND[kind].cruise) * 0.6,
    cruise: between(...KIND[kind].cruise),
    fuel: between(35, 95),
    engine: between(82, 92),
    seq: SEQ_START,
    episode: null, // { type, until, ... }
    held: null,
  };
});

/* ---------------- anomalies ---------------- */
// Per-vehicle chance per second of starting an episode, before the --anomaly multiplier.
// Tuned so 300 vehicles raise roughly two incidents a minute: enough to watch, few enough that
// hotspots stand out on the Reports heatmap. Use --anomaly to scale them for a busier demo.
const EPISODES = [
  ['overspeed', 0.00006, () => ({ extra: between(18, 40), secs: between(14, 26) })],
  ['brake', 0.00004, () => ({ secs: between(6, 12) })],
  // A failing fan: temperature climbs over a couple of minutes towards 112 °C.
  ['overheat', 0.00001, () => ({ secs: between(200, 280) })],
  // Slow coolant leak: +1 °C a minute, topping out around 100 °C. The fixed 105 °C rule never
  // fires; only the vehicle's learned baseline notices.
  ['coolantLeak', 0.00001, () => ({ secs: between(720, 1000) })],
  // Fuel siphoned while parked.
  ['fuelTheft', 0.000008, () => ({ secs: 200 })],
  // Most stops are short; about a third run past the 15-minute long-idle threshold.
  ['idle', 0.00003, () => ({ secs: rnd() < 0.3 ? between(920, 1100) : between(40, 240) })],
  ['park', 0.0002, () => ({ secs: between(60, 300) })],
  ['wander', 0.00001, () => ({ secs: 600 })],
  // Dead zone or device fault: the vehicle keeps driving but sends nothing for a minute or so.
  ['signal', 0.000015, () => ({ secs: between(45, 90) })],
];

function maybeStartEpisode(v, dt) {
  if (v.episode) return;
  for (const [type, p, make] of EPISODES) {
    if (rnd() < p * ANOM * dt) {
      const e = make();
      v.episode = { type, t: 0, ...e };
      // Ground truth for evaluating the early-warning models (--truth file.jsonl).
      if (args.truth) fs.appendFileSync(args.truth, `${JSON.stringify({ vehicleId: v.vehicleId, type, start: Date.now(), secs: e.secs })}\n`);
      if (type === 'wander') {
        const f = fleetById(v.fleetId).geofence;
        const here = pointAt(v.route, v.km);
        v.episode.out = 0;
        v.episode.dLat = here.lat - f.lat;
        v.episode.dLng = here.lng - f.lng;
        const norm = Math.hypot(v.episode.dLat, v.episode.dLng) || 1;
        v.episode.dLat /= norm; v.episode.dLng /= norm;
        v.episode.phase = 'out';
      }
      return;
    }
  }
}

function step(v, dt) {
  maybeStartEpisode(v, dt);
  const ep = v.episode;
  const here = pointAt(v.route, v.km);
  const limit = speedLimitAt(here.lat, here.lng);
  let target = Math.min(v.cruise, limit * 0.92);
  if (v.calmUntil > Date.now()) target = Math.min(target, limit * 0.8); // driver told to slow down
  let engineOn = true;

  if (ep) {
    ep.t += dt;
    if (ep.type === 'overspeed') target = limit + ep.extra;
    if (ep.type === 'brake') target = ep.t < 1.2 ? 0 : v.cruise * 0.5;
    if (ep.type === 'idle' || ep.type === 'park' || ep.type === 'fuelTheft') target = 0;
    if (ep.type === 'fuelTheft' && v.speed < 1) engineOn = false;
    if (ep.type === 'park' && v.speed < 1) engineOn = false;
    if (ep.type === 'overheat') target = v.cruise * 0.6;
    if (ep.type !== 'wander' && ep.t > ep.secs) v.episode = null;
  }

  // Speed follows its target with realistic acceleration, except a deliberate hard stop.
  const maxAccel = 2.5 * 3.6 * dt; // km/h per step
  // A deliberate hard stop sheds about 25 km/h a second (0.7 g); normal braking about 0.2 g.
  const maxDecel = (ep?.type === 'brake' && ep.t < 1.2 ? 25 : 7) * dt;
  const diff = target - v.speed;
  v.speed += diff > 0 ? Math.min(diff, maxAccel) : Math.max(diff, -maxDecel);
  v.speed = Math.max(0, v.speed + (v.speed > 3 ? between(-0.8, 0.8) : 0));

  // Engine temperature drifts back to normal unless overheating.
  const hot = ep?.type === 'overheat';
  const leak = ep?.type === 'coolantLeak' ? Math.min(13, ep.t / 60) : 0;
  const engineTarget = hot ? 112 : 86 + v.speed * 0.08 + leak;
  v.engine += (engineTarget - v.engine) * (hot ? 0.015 : 0.02) * dt + between(-0.15, 0.15);

  v.fuel = Math.max(4, v.fuel - v.speed * dt * 0.00004 * (300 / KIND[v.kind].tank));
  if (ep?.type === 'fuelTheft' && v.speed < 1 && ep.t > 20 && ep.t < 140) v.fuel = Math.max(4, v.fuel - 0.06 * dt);
  if (v.fuel <= 5) v.fuel = between(85, 98); // refuelled

  const moveKm = (v.speed / 3600) * dt;
  let lat; let lng; let heading = here.heading;
  if (ep?.type === 'wander') {
    // Drive straight away from the depot until well outside the geofence, then come back.
    const f = fleetById(v.fleetId).geofence;
    ep.out += (ep.phase === 'out' ? 1 : -1) * moveKm;
    const kmPerDeg = 111;
    lat = here.lat + (ep.dLat * ep.out) / kmPerDeg;
    lng = here.lng + (ep.dLng * ep.out) / kmPerDeg;
    if (ep.phase === 'out' && distanceKm(lat, lng, f.lat, f.lng) > f.radiusKm + 1.5) ep.phase = 'back';
    if (ep.phase === 'back' && ep.out <= 0) v.episode = null;
    heading = (Math.atan2(ep.dLng, ep.dLat) * 180) / Math.PI + (ep.phase === 'back' ? 180 : 0);
  } else {
    v.km += v.dir * moveKm;
    if (v.route.loop) v.km = ((v.km % v.route.lengthKm) + v.route.lengthKm) % v.route.lengthKm;
    else if (v.km >= v.route.lengthKm || v.km <= 0) { v.dir *= -1; v.km = Math.min(v.route.lengthKm, Math.max(0, v.km)); }
    const p = pointAt(v.route, v.km);
    lat = p.lat + v.lane; lng = p.lng + v.lane;
    if (v.dir < 0) heading = (p.heading + 180) % 360;
    else heading = p.heading;
  }

  v.seq += 1;
  return {
    vehicleId: v.vehicleId,
    seq: v.seq,
    ts: Date.now(),
    type: 'position',
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    speedKmh: Math.round(v.speed * 10) / 10,
    fuelPct: Math.round(v.fuel * 10) / 10,
    engineC: Math.round(v.engine * 10) / 10,
    heading: Math.round(((heading % 360) + 360) % 360),
    engineOn,
  };
}

function malformed(e) {
  const kind = Math.floor(rnd() * 4);
  if (kind === 0) return { ...e, lat: 123.4 };
  if (kind === 1) return { ...e, speedKmh: -12 };
  if (kind === 2) { const { seq, ...rest } = e; return rest; }
  return { ...e, ts: 'yesterday' };
}

/* ---------------- network ---------------- */
const stats = { sent: 0, accepted: 0, duplicate: 0, late: 0, invalid: 0, rateLimited: 0, unknown: 0, retries: 0, errors: 0 };
let queue = [];
let backoffUntil = 0;

async function post(pathname, body) {
  const res = await fetch(new URL(pathname, args.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': args.key },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, retryAfter: Number(res.headers.get('retry-after')) || 1 };
}

async function register() {
  for (;;) {
    try {
      const r = await post('/api/devices/register', vehicles.map(({ vehicleId, fleetId, kind }) => ({ vehicleId, fleetId, kind })));
      if (r.status === 200) return console.log(`[sim] registered ${r.json.registered} vehicles with ${args.url}`);
      console.error(`[sim] register failed (${r.status}): ${r.json.error || ''}`);
    } catch (err) {
      console.error(`[sim] server not reachable (${err.cause?.code || err.message}), retrying in 2 s`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function flush() {
  if (!queue.length || Date.now() < backoffUntil) return;
  // Large fleets can queue more than one request's worth; send the chunks in parallel.
  while (queue.length > MAX_BATCH) sendChunk(queue.splice(0, MAX_BATCH));
  return sendChunk(queue.splice(0, MAX_BATCH));
}

async function sendChunk(batch) {
  try {
    const r = await post('/api/ingest', batch);
    if (r.status === 429 || r.status === 503) {
      // Backpressure: keep the events and wait as the server asks.
      queue = batch.concat(queue);
      backoffUntil = Date.now() + r.retryAfter * 1000;
      stats.retries++;
      return;
    }
    stats.sent += batch.length;
    for (const k of ['accepted', 'duplicate', 'late', 'invalid', 'rateLimited', 'unknown']) stats[k] += r.json[k] || 0;
    if (r.json.unknown) await register();
    for (const c of r.json.commands || []) receiveInstruction(c);
  } catch {
    queue = batch.concat(queue);
    stats.errors++;
  }
  // Cap memory if the server is gone for a long time: keep the newest events.
  if (queue.length > N * 120) queue = queue.slice(-N * 60);
}

/* ---------------- dispatcher instructions ---------------- */

const byId = new Map(vehicles.map((v) => [v.vehicleId, v]));
let acks = [];

/**
 * An instruction arrived on the driver's tablet. The driver reads it a few seconds later,
 * taps OK, and does what it says. About one in twelve never answers, so the control room
 * sees an unconfirmed instruction and has to call.
 */
function receiveInstruction({ id, vehicleId, type }) {
  const v = byId.get(vehicleId);
  if (!v || rnd() < 0.08) return;
  setTimeout(() => {
    acks.push({ id, vehicleId });
    const ep = v.episode;
    if (type === 'slowDown') {
      if (ep?.type === 'overspeed') v.episode = null;
      v.calmUntil = Date.now() + 180_000;
    } else if (type === 'returnToRoute') {
      if (ep?.type === 'wander') ep.phase = 'back';
    } else if (type === 'pullOver') {
      v.episode = { type: 'park', t: 0, secs: between(150, 240) };
    } else if (type === 'resumeTrip') {
      if (ep?.type === 'idle' || ep?.type === 'park') v.episode = null;
    }
  }, between(3000, 9000));
}

setInterval(async () => {
  if (!acks.length) return;
  const batch = acks;
  acks = [];
  try {
    await post('/api/devices/ack', batch);
  } catch {
    acks = batch.concat(acks);
  }
}, 1000);

/* ---------------- main loop ---------------- */
await register();

const tickMs = 1000 / HZ;
// Real devices are not synchronised: each vehicle reports at its own phase within the second,
// so the server sees a steady stream rather than one spike per second.
const t0 = Date.now();
for (const v of vehicles) { v.nextAt = t0 + rnd() * tickMs; v.lastAt = v.nextAt - tickMs; }
setInterval(() => {
  const now = Date.now();
  for (const v of vehicles) {
    if (now < v.nextAt) continue;
    const dt = Math.min(5, (now - v.lastAt) / 1000);
    v.lastAt = now;
    v.nextAt += tickMs;
    if (v.nextAt < now) v.nextAt = now + tickMs; // fell behind (e.g. laptop slept)
    const e = step(v, dt);
    if (v.episode?.type === 'signal') continue; // nothing gets through
    let out = rnd() < P_BAD ? malformed(e) : e;
    if (v.held) { // deliver the held-back event after this newer one: out of order
      queue.push(out, v.held);
      v.held = null;
      out = null;
    } else if (rnd() < P_LATE) {
      v.held = out;
      out = null;
    }
    if (out) queue.push(out);
    if (out && rnd() < P_DUP) queue.push(out); // the same event sent twice, as a retry after a lost ack would
  }
}, 20);

setInterval(flush, BATCH_MS);

let prev = { ...stats };
const startedAt = Date.now();
setInterval(() => {
  if (!args.quiet) {
    const d = (k) => stats[k] - prev[k];
    const episodes = vehicles.filter((v) => v.episode).map((v) => v.episode.type);
    const counts = episodes.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
    console.log(`[sim] ${N} vehicles | sent ${Math.round(d('sent') / 5)}/s accepted ${Math.round(d('accepted') / 5)}/s | dropped dup ${d('duplicate')} late ${d('late')} invalid ${d('invalid')} | queue ${queue.length} | episodes ${JSON.stringify(counts)}`);
  }
  prev = { ...stats };
  if (Number(args.duration) && Date.now() - startedAt > Number(args.duration) * 1000) process.exit(0);
}, 5000);
