import { io } from 'socket.io-client';
import { useSyncExternalStore } from 'react';
import { API_BASE } from './api.js';

const UI_HZ = 4;              // the UI redraws at most 4 times a second
const KEEP_RESOLVED_MS = 2 * 3600_000;
const LAT_WINDOW = 400;

/**
 * Client-side live state. Socket messages mutate plain objects here as they arrive, which is
 * cheap; React is told about changes at most UI_HZ times a second, so a burst of hundreds of
 * updates costs one render. Components read the store after `useLive()` re-renders them.
 */
class LiveStore {
  socket = null;
  status = 'idle';            // idle | connecting | live | offline
  vehicles = new Map();       // id -> { id, fl, k, seq, ts, la, ln, sp, fu, en, hd, st, at }
  incidents = new Map();      // id -> incident: open ones, plus resolved ones from the last 2 h
  metrics = null;
  fleets = [];                // subscribed fleet ids
  version = 0;
  received = { batches: 0, updates: 0, stale: 0, bytes: 0 };
  rate = { batches: 0, updates: 0, bytes: 0 }; // what this screen received in the last second
  #rateBase = { batches: 0, updates: 0, bytes: 0, at: Date.now() };
  latencies = [];
  latencyP50 = 0;
  #listeners = new Set();
  #dirty = false;
  #timer = null;
  #watchers = new Map();      // vehicleId -> Set<fn>

  connect(token) {
    if (this.socket) return;
    this.status = 'connecting';
    const s = io(API_BASE || undefined, { auth: { token }, transports: ['websocket', 'polling'] });
    this.socket = s;
    s.on('connect', () => {
      this.status = 'live';
      if (this.fleets.length) this.subscribe(this.fleets);
      for (const id of this.#watchers.keys()) s.emit('watch', { vehicleId: id });
      this.touch();
    });
    s.on('disconnect', () => { this.status = 'offline'; this.touch(); });
    s.on('connect_error', () => { this.status = 'offline'; this.touch(); });
    s.on('fleet:batch', (m) => this.applyBatch(m));
    // Count bytes on the wire for the "this screen receives" readout.
    s.io.on('open', () => s.io.engine.on('data', (d) => { this.received.bytes += typeof d === 'string' ? d.length : d.byteLength || 0; }));
    s.on('fleet:snapshot', (m) => this.applySnapshot(m.d, this.fleets));
    s.on('vehicle:events', (m) => this.#watchers.get(m.id)?.forEach((fn) => fn(m.e)));
    s.on('incidents', (list) => this.upsertIncidents(list));
    s.on('metrics', (m) => { this.metrics = m; this.touch(); });
    this.#timer = setInterval(() => this.#flush(), 1000 / UI_HZ);
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
    clearInterval(this.#timer);
    this.vehicles.clear();
    this.incidents.clear();
    this.fleets = [];
    this.status = 'idle';
    this.touch();
  }

  /** Replaces the subscription; the server's ack carries a full snapshot of those fleets. */
  subscribe(fleets) {
    this.fleets = fleets;
    for (const [id, v] of this.vehicles) if (!fleets.includes(v.fl)) this.vehicles.delete(id);
    this.touch();
    if (!this.socket?.connected) return;
    this.socket.emit('subscribe', { fleets }, (res) => {
      if (res?.ok) this.applySnapshot(res.d, res.fleets);
    });
  }

  applySnapshot(rows, fleets) {
    const now = Date.now();
    for (const [id, v] of this.vehicles) if (fleets.includes(v.fl)) this.vehicles.delete(id);
    for (const [id, seq, ts, f] of rows) this.vehicles.set(id, { id, seq, ts, at: now, ...f });
    this.touch();
  }

  applyBatch({ f: fleet, d }) {
    const now = Date.now();
    this.received.batches++;
    for (let i = 0; i < d.length; i++) {
      const [id, seq, ts, fields] = d[i];
      let v = this.vehicles.get(id);
      if (!v) {
        if (!this.fleets.includes(fleet)) continue;
        v = { id, fl: fleet, seq: -1 };
        this.vehicles.set(id, v);
      }
      if (seq < v.seq) { this.received.stale++; continue; }
      Object.assign(v, fields);
      v.seq = seq; v.ts = ts; v.at = now;
      this.received.updates++;
      if (i % 10 === 0) this.latencies.push(now - ts);
    }
    if (this.latencies.length > LAT_WINDOW) this.latencies.splice(0, this.latencies.length - LAT_WINDOW);
    this.#dirty = true;
  }

  /** Joins the vehicle's room; `fn` receives every raw event tuple. Returns an unwatch function. */
  watch(vehicleId, fn) {
    let set = this.#watchers.get(vehicleId);
    if (!set) {
      this.#watchers.set(vehicleId, (set = new Set()));
    }
    set.add(fn);
    const ready = new Promise((resolve) => {
      if (!this.socket?.connected) return resolve({ ok: false });
      this.socket.emit('watch', { vehicleId }, resolve);
    });
    return {
      ready,
      stop: () => {
        set.delete(fn);
        if (!set.size) {
          this.#watchers.delete(vehicleId);
          this.socket?.emit('unwatch', { vehicleId });
        }
      },
    };
  }

  /** Adds or replaces incidents (from the socket, the API, or an action's response). */
  upsertIncidents(list) {
    const cutoff = Date.now() - KEEP_RESOLVED_MS;
    for (const i of list) this.incidents.set(i.id, i);
    for (const [id, i] of this.incidents) if (i.status === 'resolved' && i.resolvedAt < cutoff) this.incidents.delete(id);
    this.touch();
  }

  /** Unresolved incidents for the fleets this screen follows. */
  openIncidents() {
    const out = [];
    for (const i of this.incidents.values()) if (i.status !== 'resolved' && this.fleets.includes(i.fleetId)) out.push(i);
    return out;
  }

  touch() { this.#dirty = true; if (!this.#timer) this.#flush(); }

  /** Rooms this screen is in: one per subscribed fleet, one per open vehicle, plus metrics. */
  get rooms() {
    return [...this.fleets.map((f) => `fleet:${f}`), ...[...this.#watchers.keys()].map((v) => `vehicle:${v}`)];
  }

  #measure() {
    const now = Date.now();
    const dt = (now - this.#rateBase.at) / 1000;
    if (dt < 1) return;
    for (const k of ['batches', 'updates', 'bytes']) {
      this.rate[k] = Math.round((this.received[k] - this.#rateBase[k]) / dt);
      this.#rateBase[k] = this.received[k];
    }
    this.#rateBase.at = now;
    this.#dirty = true;
  }

  #flush() {
    this.#measure();
    if (!this.#dirty) return;
    this.#dirty = false;
    if (this.latencies.length) {
      const s = [...this.latencies].sort((a, b) => a - b);
      this.latencyP50 = s[Math.floor(s.length / 2)];
    }
    this.version++;
    for (const fn of this.#listeners) fn();
  }

  subscribeStore = (fn) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
}

export const live = new LiveStore();

/** Re-renders the calling component at most UI_HZ times a second while live data changes. */
export function useLive() {
  return useSyncExternalStore(live.subscribeStore, () => live.version);
}
