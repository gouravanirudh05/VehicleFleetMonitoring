import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { Metrics } from '../src/pipeline/metrics.js';

const config = { deviceRatePerSec: 5, deviceBurst: 20, idleAlertSec: 900, maxPendingWrites: 1000, offlineAfterMs: 30000 };

function setup(now = 1_800_000_000_000) {
  const clock = { now };
  const p = new Pipeline({ config, metrics: new Metrics(), now: () => clock.now });
  p.register({ vehicleId: 'KA01-AB-4471', fleetId: 'north-depot', kind: 'truck' });
  return { p, clock };
}
const ev = (seq, ts, extra = {}) => ({ vehicleId: 'KA01-AB-4471', seq, ts, lat: 12.95, lng: 77.55, speedKmh: 40, fuelPct: 60, engineC: 88, ...extra });

test('accepts valid events and drops duplicates and late events by seq', () => {
  const { p, clock } = setup();
  const t = clock.now;
  const r = p.ingest([ev(10, t), ev(11, t + 1000), ev(11, t + 1000), ev(9, t - 1000), ev(12, t + 2000)]);
  assert.equal(r.accepted, 3);
  assert.equal(r.duplicate, 1);
  assert.equal(r.late, 1);
  assert.equal(p.states.get('KA01-AB-4471').seq, 12);
  assert.equal(p.writeBuffer.length, 3);
});

test('rejects malformed events and unknown devices', () => {
  const { p, clock } = setup();
  const r = p.ingest([
    ev(1, clock.now, { lat: 200 }),
    { vehicleId: 'KA01-AB-4471', seq: 2 },
    ev(3, clock.now, { vehicleId: 'ZZ99-ZZ-0000' }),
    ev(4, clock.now + 10 * 60_000),
    ev(5, clock.now, { extra: true }),
  ]);
  assert.equal(r.accepted, 0);
  assert.equal(r.invalid, 4);
  assert.equal(r.unknown, 1);
  assert.ok(r.errors.length > 0);
});

test('accepts ISO timestamps', () => {
  const { p, clock } = setup();
  const r = p.ingest([ev(1, new Date(clock.now).toISOString())]);
  assert.equal(r.accepted, 1);
  assert.equal(p.states.get('KA01-AB-4471').ts, clock.now);
});

test('per-device token bucket limits bursts', () => {
  const { p, clock } = setup();
  const batch = Array.from({ length: 30 }, (_, i) => ev(i + 1, clock.now));
  const r = p.ingest(batch);
  assert.equal(r.accepted, 20);
  assert.equal(r.rateLimited, 10);
});

test('broadcast sends full state first, then only fields that moved', () => {
  const { p, clock } = setup();
  p.ingest([ev(1, clock.now)]);
  const first = p.takeBroadcast();
  assert.equal(first.fleets.length, 1);
  const [, seq, , fields] = first.fleets[0].deltas[0];
  assert.equal(seq, 1);
  assert.deepEqual(Object.keys(fields).sort(), ['en', 'fu', 'la', 'ln', 'sp', 'st']);

  clock.now += 1000;
  p.ingest([ev(2, clock.now, { speedKmh: 45 })]);
  const second = p.takeBroadcast();
  assert.deepEqual(second.fleets[0].deltas[0][3], { sp: 45 });

  assert.equal(p.takeBroadcast().fleets.length, 0, 'nothing pending after drain');
});

test('watched vehicles get every event, not a coalesced one', () => {
  const { p, clock } = setup();
  p.isWatched = () => true;
  p.ingest([ev(1, clock.now), ev(2, clock.now + 100), ev(3, clock.now + 200)]);
  const { vehicles, fleets } = p.takeBroadcast();
  assert.equal(vehicles[0].events.length, 3);
  assert.equal(fleets[0].deltas.length, 1);
});

test('unflushed events are visible to history until written', () => {
  const { p, clock } = setup();
  p.ingest([ev(1, clock.now), ev(2, clock.now + 1000)]);
  assert.equal(p.unflushedFor('KA01-AB-4471', 0).length, 2);
  const w = p.takeWrites();
  assert.equal(w.telemetry.length, 2);
  assert.equal(p.unflushedFor('KA01-AB-4471', 0).length, 2, 'in-flight still visible');
  p.writesDone();
  assert.equal(p.unflushedFor('KA01-AB-4471', 0).length, 0);
});

test('vehicles that stop reporting go offline', () => {
  const { p, clock } = setup();
  p.ingest([ev(1, clock.now)]);
  p.takeBroadcast();
  clock.now += 31_000;
  p.sweepOffline();
  assert.equal(p.states.get('KA01-AB-4471').status, 'offline');
  assert.deepEqual(p.takeBroadcast().fleets[0].deltas[0][3], { st: 'offline' });
});

test('rollups add up distance driven and ignore GPS jumps', () => {
  const { p, clock } = setup();
  const t = clock.now;
  // about 111 m north per second, then a 50 km jump that must not count
  p.ingest([ev(1, t), ev(2, t + 1000, { lat: 12.951 }), ev(3, t + 2000, { lat: 12.952 }), ev(4, t + 3000, { lat: 13.4 })]);
  const { rollups } = p.takeWrites();
  const km = rollups.reduce((s, r) => s + r.km, 0);
  assert.ok(km > 0.2 && km < 0.25, `expected ~0.22 km, got ${km}`);
});
