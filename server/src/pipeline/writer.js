import { Incident, Rollup, Vehicle } from '../models/index.js';
import { telemetry } from '../db.js';

/**
 * Drains the pipeline's buffers into MongoDB on a timer: raw events go in with one unordered
 * insertMany, latest vehicle states and per-minute rollups with one bulkWrite each. Only one
 * flush runs at a time; events keep buffering while it does, and the ingest route answers 503
 * when the buffer passes MAX_PENDING_WRITES (backpressure).
 */
export function startWriter({ pipeline, metrics, config, log = console }) {
  let running = false;
  let lastVehicleFlush = 0;
  // Latest vehicle state is served from memory; the database copy only matters after a
  // restart, so it is persisted every few seconds instead of on every flush.
  const VEHICLE_FLUSH_MS = 5000;

  async function flush(force = false) {
    if (running) return;
    running = true;
    const started = Date.now();
    const withVehicles = force || started - lastVehicleFlush >= VEHICLE_FLUSH_MS;
    if (withVehicles) lastVehicleFlush = started;
    const { telemetry: docs, vehicles, incidents, rollups } = pipeline.takeWrites({ withVehicles });
    try {
      const ops = [];
      if (docs.length) ops.push(telemetry().insertMany(docs, { ordered: false }));
      if (vehicles.length) {
        ops.push(Vehicle.bulkWrite(vehicles.map((s) => ({
          updateOne: {
            filter: { _id: s.vehicleId },
            update: {
              $set: {
                vehicleId: s.vehicleId, fleetId: s.fleetId, kind: s.kind, seq: s.seq, ts: new Date(s.ts),
                lat: s.lat, lng: s.lng, speedKmh: s.speedKmh, fuelPct: s.fuelPct, engineC: s.engineC,
                heading: s.heading, engineOn: s.engineOn, status: s.status,
                ...(s.ml ? { ml: s.ml } : {}),
              },
            },
            upsert: true,
          },
        })), { ordered: false }));
      }
      if (incidents.length) {
        ops.push(Incident.bulkWrite(incidents.map(({ id, ...inc }) => ({
          replaceOne: { filter: { _id: id }, replacement: { _id: id, ...inc }, upsert: true },
        })), { ordered: false }));
      }
      if (rollups.length) {
        // $max keeps the larger count if the process restarted mid-minute.
        ops.push(Rollup.bulkWrite(rollups.map((r) => ({
          updateOne: {
            filter: { fleetId: r.fleetId, bucket: r.bucket },
            update: { $max: { events: r.events, speedSum: r.speedSum, speedMax: r.speedMax, km: r.km, vehicles: r.vehicles } },
            upsert: true,
          },
        })), { ordered: false }));
      }
      await Promise.all(ops);
      metrics.inc('written', docs.length);
    } catch (err) {
      metrics.inc('writeErrors');
      metrics.lastWriteErrorAt = Date.now();
      log.error('[writer] flush failed:', err.message);
    } finally {
      pipeline.writesDone();
      metrics.flush = { lastMs: Date.now() - started, lastDocs: docs.length, pending: pipeline.writeBuffer.length };
      running = false;
    }
  }

  const timer = setInterval(() => flush(), config.flushMs);
  return { flush, stop: () => clearInterval(timer) };
}
