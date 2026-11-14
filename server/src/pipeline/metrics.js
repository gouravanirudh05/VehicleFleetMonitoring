import { monitorEventLoopDelay } from 'node:perf_hooks';

const COUNTERS = [
  'received', 'accepted', 'invalid', 'unknown', 'rateLimited', 'duplicate', 'late', 'overloaded',
  'alerts', 'earlyWarnings', 'written', 'writeErrors', 'broadcastMessages', 'broadcastBytes', 'slowSocketResyncs',
];
const SERIES_LEN = 180;
const LAT_LEN = 4096;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Process-wide counters, per-second rates and latency percentiles. */
export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.total = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
    this.prev = { ...this.total };
    this.rate = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
    this.series = [];
    this.lat = new Float64Array(LAT_LEN); // event timestamp -> broadcast, ms
    this.latN = 0;
    this.latency = { p50: 0, p95: 0, p99: 0 };
    this.flush = { lastMs: 0, lastDocs: 0, pending: 0 };
    this.clients = 0;
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.loopP99 = 0;
    this.roomCounts = new Map(); // room -> { msgs, bytes } since the last tick
    this.roomRates = new Map();  // room -> { msgs, bytes } per second
  }

  /** Records one emit to a room: `screens` sockets each receive `bytes`. */
  countRoom(room, screens, bytes) {
    let c = this.roomCounts.get(room);
    if (!c) this.roomCounts.set(room, (c = { msgs: 0, bytes: 0 }));
    c.msgs += screens;
    c.bytes += bytes * screens;
  }

  inc(name, n = 1) { this.total[name] += n; }

  sampleLatency(ms) {
    this.lat[this.latN++ % LAT_LEN] = ms;
  }

  /** Called once a second: turns counter deltas into rates and appends a series point. */
  tick(now = Date.now()) {
    for (const k of COUNTERS) {
      this.rate[k] = this.total[k] - this.prev[k];
      this.prev[k] = this.total[k];
    }
    const n = Math.min(this.latN, LAT_LEN);
    if (n) {
      const sorted = Array.from(this.lat.subarray(0, n)).sort((a, b) => a - b);
      this.latency = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
    }
    this.latN = 0;
    this.roomRates = this.roomCounts;
    this.roomCounts = new Map();
    this.loopP99 = this.loop.percentile(99) / 1e6;
    this.loop.reset();
    const r = this.rate;
    this.series.push({
      t: now,
      received: r.received,
      accepted: r.accepted,
      dropped: r.invalid + r.unknown + r.rateLimited + r.duplicate + r.late + r.overloaded,
      bytesOut: r.broadcastBytes,
      p95: Math.round(this.latency.p95),
      clients: this.clients,
    });
    if (this.series.length > SERIES_LEN) this.series.shift();
  }

  snapshot(extra = {}) {
    const mem = process.memoryUsage();
    return {
      t: Date.now(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      total: this.total,
      rate: this.rate,
      latency: {
        p50: Math.round(this.latency.p50),
        p95: Math.round(this.latency.p95),
        p99: Math.round(this.latency.p99),
      },
      flush: this.flush,
      clients: this.clients,
      eventLoopP99Ms: Math.round(this.loopP99 * 10) / 10,
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      ...extra,
    };
  }
}
