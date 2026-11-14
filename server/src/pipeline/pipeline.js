import { validateEvent } from './schema.js';
import { TokenBuckets } from './tokenBucket.js';
import { evaluateRules } from './rules.js';
import { encodeDelta, encodeFull } from './delta.js';
import { distanceKm } from '../../../shared/geo.js';
import { Incidents } from './incidents.js';
import { EarlyWarning } from './ml.js';

const MINUTE = 60_000;

export const statusOf = (s) => (!s.engineOn ? 'stopped' : s.speedKmh < 2 ? 'idle' : 'moving');

/** Event tuple shared by history responses and vehicle-room broadcasts. */
export const toTuple = (e) => [e.seq, e.ts, e.lat, e.lng, e.speedKmh, e.fuelPct, e.engineC];

/**
 * The in-memory heart of the server. It validates and dedupes incoming events, keeps the
 * latest state per vehicle, runs anomaly rules, and accumulates three outputs that are
 * drained on timers: database writes, fleet-room deltas and vehicle-room event lists.
 * It does no I/O itself, so it can be unit-tested without MongoDB or sockets.
 */
export class Pipeline {
  constructor({ config, metrics, now = () => Date.now() }) {
    this.config = config;
    this.metrics = metrics;
    this.now = now;
    this.registry = new Map();      // vehicleId -> { vehicleId, fleetId, kind }
    this.states = new Map();        // vehicleId -> latest state
    this.ruleState = new Map();     // vehicleId -> rule memory
    this.limiter = new TokenBuckets({ ratePerSec: config.deviceRatePerSec, burst: config.deviceBurst });

    this.writeBuffer = [];          // telemetry docs not yet handed to the writer
    this.inflight = [];             // telemetry docs currently being written
    this.dirty = new Set();         // vehicleIds whose latest state must be persisted
    this.rollups = new Map();       // `${fleetId}|${minute}` -> per-minute aggregate

    this.pendingFleet = new Map();  // fleetId -> Set<vehicleId> changed since last broadcast
    this.pendingVehicle = new Map();// vehicleId -> tuples since last broadcast (watched vehicles only)
    this.lastSent = new Map();      // vehicleId -> last broadcast wire state

    this.incidents = new Incidents({ now });
    this.ml = new EarlyWarning();
    this.isWatched = () => false;   // set by the realtime layer
  }

  /* ---------------- registry ---------------- */

  register({ vehicleId, fleetId, kind }) {
    this.registry.set(vehicleId, { vehicleId, fleetId, kind });
  }

  /** Restores registry and latest state (including lastSeq for dedupe) after a restart. */
  hydrate(vehicleDocs) {
    for (const d of vehicleDocs) {
      this.register(d);
      this.ml.restore(d.vehicleId, d.ml);
      if (d.seq != null) {
        this.states.set(d.vehicleId, {
          vehicleId: d.vehicleId, fleetId: d.fleetId, kind: d.kind, seq: d.seq, ts: d.ts?.valueOf?.() ?? d.ts,
          lat: d.lat, lng: d.lng, speedKmh: d.speedKmh, fuelPct: d.fuelPct, engineC: d.engineC,
          heading: d.heading, engineOn: d.engineOn, status: 'offline', recvAt: 0,
        });
      }
    }
  }

  overloaded() {
    return this.writeBuffer.length + this.inflight.length >= this.config.maxPendingWrites;
  }

  /* ---------------- ingest ---------------- */

  /**
   * Processes a batch of raw events. Returns counts by outcome plus up to five error samples.
   * Duplicates (same seq as the last accepted) and late events (lower seq) are dropped so
   * replays from a flaky link never double-count.
   */
  ingest(rawEvents) {
    const now = this.now();
    const res = { accepted: 0, invalid: 0, unknown: 0, rateLimited: 0, duplicate: 0, late: 0, errors: [] };
    const m = this.metrics;
    m.inc('received', rawEvents.length);

    for (const raw of rawEvents) {
      const v = validateEvent(raw, now);
      if (!v.ok) {
        res.invalid++;
        if (res.errors.length < 5) res.errors.push(v.error);
        continue;
      }
      const e = v.event;
      const reg = this.registry.get(e.vehicleId);
      if (!reg) {
        res.unknown++;
        if (res.errors.length < 5) res.errors.push(`${e.vehicleId}: unknown device`);
        continue;
      }
      if (!this.limiter.take(e.vehicleId, now)) { res.rateLimited++; continue; }

      const prev = this.states.get(e.vehicleId);
      if (prev && e.seq <= prev.seq) {
        if (e.seq === prev.seq) res.duplicate++; else res.late++;
        continue;
      }
      this.accept(e, reg, now);
      res.accepted++;
    }

    m.inc('accepted', res.accepted); m.inc('invalid', res.invalid); m.inc('unknown', res.unknown);
    m.inc('rateLimited', res.rateLimited); m.inc('duplicate', res.duplicate); m.inc('late', res.late);
    return res;
  }

  accept(e, reg, now) {
    const { vehicleId } = e;
    const { fleetId, kind } = reg;
    const prev = this.states.get(vehicleId);
    // Distance since the previous reading, for "incidents per 100 km". Gaps and GPS jumps are ignored.
    let km = 0;
    if (prev && prev.lat != null && e.ts - prev.ts <= 10_000) {
      km = distanceKm(prev.lat, prev.lng, e.lat, e.lng);
      if (km > 0.5) km = 0;
    }
    const s = {
      vehicleId, fleetId, kind, seq: e.seq, ts: e.ts, lat: e.lat, lng: e.lng, speedKmh: e.speedKmh,
      fuelPct: e.fuelPct, engineC: e.engineC, heading: e.heading, engineOn: e.engineOn, recvAt: now,
    };
    s.status = statusOf(s);
    this.states.set(vehicleId, s);
    this.dirty.add(vehicleId);

    this.writeBuffer.push({
      ts: new Date(e.ts), meta: { vehicleId, fleetId }, seq: e.seq, lat: e.lat, lng: e.lng,
      speedKmh: e.speedKmh, fuelPct: e.fuelPct, engineC: e.engineC, heading: e.heading, engineOn: e.engineOn,
    });

    let set = this.pendingFleet.get(fleetId);
    if (!set) this.pendingFleet.set(fleetId, (set = new Set()));
    set.add(vehicleId);

    if (this.isWatched(vehicleId)) {
      let list = this.pendingVehicle.get(vehicleId);
      if (!list) this.pendingVehicle.set(vehicleId, (list = []));
      list.push(toTuple(e));
    }

    this.rollup(fleetId, vehicleId, e, km);

    let rs = this.ruleState.get(vehicleId);
    if (!rs) this.ruleState.set(vehicleId, (rs = {}));
    const { fired, cleared } = evaluateRules(rs, e, fleetId, this.config);
    for (const a of fired) {
      this.incidents.fire(reg, a);
      this.metrics.inc('alerts');
    }
    for (const rule of cleared) this.incidents.clear(vehicleId, rule, e.ts);

    const early = this.ml.observe(vehicleId, e, km);
    for (const a of early.fired) {
      this.incidents.fire(reg, a);
      this.metrics.inc('alerts');
      this.metrics.inc('earlyWarnings');
    }
    for (const rule of early.cleared) this.incidents.clear(vehicleId, rule, e.ts);
    if (prev?.status === 'offline') this.incidents.clear(vehicleId, 'noSignal', e.ts);
  }

  rollup(fleetId, vehicleId, e, km = 0) {
    const minute = Math.floor(e.ts / MINUTE) * MINUTE;
    const key = `${fleetId}|${minute}`;
    let r = this.rollups.get(key);
    if (!r) this.rollups.set(key, (r = { fleetId, bucket: minute, events: 0, speedSum: 0, speedMax: 0, km: 0, vehicles: new Set(), dirty: true }));
    r.events++;
    r.speedSum += e.speedKmh;
    r.km += km;
    if (e.speedKmh > r.speedMax) r.speedMax = e.speedKmh;
    r.vehicles.add(vehicleId);
    r.dirty = true;
  }

  /* ---------------- outputs ---------------- */

  /** Marks vehicles that stopped reporting as offline so dashboards grey them out. */
  /**
   * Marks vehicles that stopped reporting as offline. One that went silent while driving gets
   * a "Not reporting" incident: a dead zone, a device fault, or something worse.
   */
  sweepOffline() {
    const now = this.now();
    const cutoff = now - this.config.offlineAfterMs;
    for (const s of this.states.values()) {
      if (s.status !== 'offline' && s.recvAt < cutoff) {
        if (s.engineOn && s.speedKmh > 5 && s.recvAt > 0) {
          const reg = this.registry.get(s.vehicleId);
          if (reg) {
            this.incidents.fire(reg, {
              rule: 'noSignal', severity: 'warning', ts: now, seq: s.seq, value: Math.round((now - s.recvAt) / 1000), threshold: null,
              message: `No data for ${Math.round((now - s.recvAt) / 1000)} s; last seen at ${Math.round(s.speedKmh)} km/h`,
              readings: { lat: s.lat, lng: s.lng, speedKmh: s.speedKmh, fuelPct: s.fuelPct, engineC: s.engineC },
            });
            this.metrics.inc('alerts');
          }
        }
        s.status = 'offline';
        this.dirty.add(s.vehicleId);
        let set = this.pendingFleet.get(s.fleetId);
        if (!set) this.pendingFleet.set(s.fleetId, (set = new Set()));
        set.add(s.vehicleId);
      }
    }
  }

  /**
   * Drains what changed since the last call. Fleet rooms get one delta per changed vehicle
   * (latest state only, coalesced over the window); watched vehicles get every event.
   */
  takeBroadcast() {
    const now = this.now();
    const fleets = [];
    for (const [fleetId, ids] of this.pendingFleet) {
      const deltas = [];
      for (const id of ids) {
        const s = this.states.get(id);
        const prev = this.lastSent.get(id);
        const d = encodeDelta(prev, s);
        if (!d) continue;
        this.lastSent.set(id, prev ? Object.assign(prev, d) : { ...d });
        deltas.push([id, s.seq, s.ts, d]);
        if (s.status !== 'offline') this.metrics.sampleLatency(now - s.ts);
      }
      if (deltas.length) fleets.push({ fleetId, deltas });
    }
    this.pendingFleet.clear();
    const vehicles = [];
    for (const [vehicleId, events] of this.pendingVehicle) vehicles.push({ vehicleId, events });
    this.pendingVehicle.clear();
    return { t: now, fleets, vehicles };
  }

  /** Full current state of the given fleets, for new subscribers and resyncs. */
  snapshot(fleetIds) {
    const want = new Set(fleetIds);
    const out = [];
    for (const s of this.states.values()) {
      if (want.has(s.fleetId)) out.push([s.vehicleId, s.seq, s.ts, { ...encodeFull(s), fl: s.fleetId, k: s.kind }]);
    }
    return out;
  }

  /** Hands buffered writes to the writer. Call `writesDone()` once they are persisted. */
  takeWrites({ withVehicles = true } = {}) {
    const telemetry = this.writeBuffer;
    this.writeBuffer = [];
    this.inflight = telemetry;
    const vehicles = [];
    if (withVehicles) {
      for (const id of this.dirty) {
        const s = this.states.get(id);
        if (s) vehicles.push({ ...s, ml: this.ml.models.get(id)?.export() });
      }
      this.dirty.clear();
    }
    const incidents = this.incidents.takeDirty();
    const rollups = [];
    const cutoff = this.now() - 3 * MINUTE;
    for (const [key, r] of this.rollups) {
      if (r.dirty) {
        rollups.push({ fleetId: r.fleetId, bucket: new Date(r.bucket), events: r.events, speedSum: r.speedSum, speedMax: r.speedMax, km: r.km, vehicles: r.vehicles.size });
        r.dirty = false;
      }
      if (r.bucket < cutoff) this.rollups.delete(key);
    }
    return { telemetry, vehicles, incidents, rollups };
  }

  writesDone() {
    this.inflight = [];
  }

  /**
   * Events for one vehicle that are accepted but not yet in MongoDB. The history endpoint
   * adds these to the database result so a dashboard that subscribes, then loads history,
   * sees no gap between the last flushed point and the first live one.
   */
  unflushedFor(vehicleId, sinceMs) {
    const out = [];
    for (const list of [this.inflight, this.writeBuffer]) {
      for (const d of list) {
        if (d.meta.vehicleId === vehicleId && d.ts.valueOf() >= sinceMs) {
          out.push([d.seq, d.ts.valueOf(), d.lat, d.lng, d.speedKmh, d.fuelPct, d.engineC]);
        }
      }
    }
    return out;
  }
}
