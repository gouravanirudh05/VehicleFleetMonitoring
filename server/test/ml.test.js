import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleModel, WARMUP } from '../src/pipeline/ml.js';

// A truck driving normally: the engine moves 2% a second towards 86 + 0.08·speed (a ~50 s lag),
// plus sensor noise; 0.15% fuel per km.
function drive(model, { seconds, start = 0, engineOffset = () => 0, fuelLeak = () => 0, speed = null, fuel = { v: 80 }, seed = 7 }) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let sp = 40;
  let base = 86 + 40 * 0.08;
  const out = [];
  for (let i = 0; i < seconds; i++) {
    const t = start + i * 1000;
    sp = speed ?? Math.max(5, Math.min(60, sp + (rnd() - 0.5) * 6));
    const km = sp / 3600;
    fuel.v -= km * 0.15 + fuelLeak(i);
    base += (86 + sp * 0.08 - base) * 0.02;
    const engine = base + (rnd() - 0.5) * 1.2 + engineOffset(i);
    const r = model.observe({ ts: t, seq: t / 1000, lat: 12.9, lng: 77.6, speedKmh: sp, fuelPct: Math.round(fuel.v * 10) / 10, engineC: engine }, km);
    out.push(...r.fired.map((a) => ({ ...a, i })), ...r.cleared.map((rule) => ({ cleared: rule, i })));
  }
  return out;
}

test('normal driving for an hour raises nothing', () => {
  const m = new VehicleModel();
  const events = drive(m, { seconds: 3600 });
  assert.deepEqual(events.filter((e) => e.rule), []);
  assert.ok(m.trained);
  const d = m.describe(40);
  assert.ok(Math.abs(d.normalEngineC - 89.2) < 1, `learned baseline ${d.normalEngineC}`);
  assert.ok(Math.abs(d.fuelPerKm - 0.15) < 0.03, `learned fuel use ${d.fuelPerKm}`);
});

test('a slow coolant leak that never reaches 105 °C is flagged as unusual', () => {
  const m = new VehicleModel();
  drive(m, { seconds: 1200 });
  // +1 °C per minute up to +12 °C: peaks around 101 °C, below the fixed overheat rule.
  const events = drive(m, { seconds: 1200, start: 1_200_000, engineOffset: (i) => Math.min(12, i / 60), seed: 11 });
  const hit = events.find((e) => e.rule === 'engineAnomaly');
  assert.ok(hit, 'engine anomaly fired');
  assert.ok(hit.readings.engineC < 105, 'before the fixed rule could ever fire');
  assert.ok(!events.some((e) => e.rule === 'overheatForecast'), 'too slow to be an overheat');
});

test('a fast temperature climb is forecast before it reaches 105 °C', () => {
  const m = new VehicleModel();
  drive(m, { seconds: 600 });
  // Climbs towards 112 °C with a ~70 s time constant, like a failing fan.
  let extra = 0;
  const events = drive(m, { seconds: 300, start: 600_000, engineOffset: () => { extra += (25 - extra) * 0.015; return extra; }, seed: 3 });
  const f = events.find((e) => e.rule === 'overheatForecast');
  assert.ok(f, 'forecast fired');
  assert.ok(f.readings.engineC < 105, `warned at ${f.readings.engineC.toFixed(1)} °C`);
  assert.match(f.message, /min to 105 °C/);
  assert.ok(!events.some((e) => e.rule === 'engineAnomaly'), 'no duplicate anomaly while the forecast is open');
});

test('fuel lost while parked is flagged; refuelling is not', () => {
  const m = new VehicleModel();
  const fuel = { v: 80 };
  drive(m, { seconds: 900, fuel });
  // Parked, engine idle, 8% vanishes over two minutes.
  const parked = drive(m, { seconds: 180, start: 900_000, speed: 0, fuel, fuelLeak: (i) => (i < 120 ? 0.067 : 0), seed: 5 });
  const hit = parked.find((e) => e.rule === 'fuelDrop');
  assert.ok(hit, 'fuel drop fired');
  assert.match(hit.message, /while parked/);
  fuel.v = 95; // refuel
  const after = drive(m, { seconds: 600, start: 1_080_000, fuel, seed: 9 });
  assert.ok(!after.some((e) => e.rule === 'fuelDrop'), 'refuel and normal driving stay quiet');
});

test('nothing is judged before the baseline has warmed up', () => {
  const m = new VehicleModel();
  const events = drive(m, { seconds: WARMUP + 100, engineOffset: () => 15 });
  assert.ok(!events.some((e) => e.rule === 'engineAnomaly'));
});

test('a model restored from storage keeps what it learned', () => {
  const a = new VehicleModel();
  drive(a, { seconds: 900 });
  const b = new VehicleModel(JSON.parse(JSON.stringify(a.export())));
  assert.ok(b.trained);
  assert.equal(b.describe(40).normalEngineC, a.describe(40).normalEngineC);
});

test('an engine catching up after pulling away from a stop is not forecast to overheat', () => {
  const m = new VehicleModel();
  // Realistic lag: the engine moves 2% of the way to 86 + 0.08·speed each second.
  let engine = 89; let fuel = 80;
  const tick = (i, speed) => {
    engine += (86 + speed * 0.08 - engine) * 0.02;
    fuel -= speed / 3600 * 0.15;
    return m.observe({ ts: i * 1000, seq: i, lat: 12.9, lng: 77.6, speedKmh: speed, fuelPct: Math.round(fuel * 10) / 10, engineC: engine }, speed / 3600);
  };
  const fired = [];
  for (let i = 0; i < 4000; i++) {
    // Stop-and-go: 2 minutes at 55 km/h, 1 minute stopped, repeat.
    const speed = i % 180 < 120 ? 55 : 0;
    fired.push(...tick(i, speed).fired);
  }
  assert.deepEqual(fired.map((f) => f.rule), []);
});

test('a cold engine warming up after start-up raises nothing', () => {
  const m = new VehicleModel();
  let engine = 70; let fuel = 80;
  const fired = [];
  for (let i = 0; i < 900; i++) {
    engine += (86 + 40 * 0.08 - engine) * 0.02;
    fuel -= 40 / 3600 * 0.15;
    fired.push(...m.observe({ ts: i * 1000, seq: i, lat: 12.9, lng: 77.6, speedKmh: 40, fuelPct: Math.round(fuel * 10) / 10, engineC: engine }, 40 / 3600).fired);
  }
  assert.deepEqual(fired.map((f) => f.rule), []);
});

test('braking to a stop with a lagging engine raises nothing', () => {
  const m = new VehicleModel();
  let engine = 89; let fuel = 80; let speed = 50;
  const fired = [];
  for (let i = 0; i < 5000; i++) {
    // Drive 3 min, brake at 7 km/h per second, park 2 min with the engine off, pull away.
    const phase = i % 300;
    const target = phase < 180 ? 50 : 0;
    speed = target > speed ? Math.min(target, speed + 2.5) : Math.max(target, speed - 7);
    engine += (86 + speed * 0.08 - engine) * 0.02;
    fuel -= speed / 3600 * 0.15;
    fired.push(...m.observe({ ts: i * 1000, seq: i, lat: 12.9, lng: 77.6, speedKmh: speed, fuelPct: Math.round(fuel * 10) / 10, engineC: engine }, speed / 3600).fired);
  }
  assert.deepEqual(fired.map((f) => f.rule), []);
});

test('a thirsty vehicle (a delivery bike) learns its fuel use instead of alarming', () => {
  const m = new VehicleModel();
  let fuel = 95; let engine = 89;
  const fired = [];
  for (let i = 0; i < 2400; i++) {
    const speed = 40;
    engine += (86 + speed * 0.08 - engine) * 0.02;
    fuel -= speed / 3600 * 3.6; // 3.6% of the tank per km
    if (fuel < 10) fuel = 95;   // refuel
    fired.push(...m.observe({ ts: i * 1000, seq: i, lat: 12.9, lng: 77.6, speedKmh: speed, fuelPct: Math.round(fuel * 10) / 10, engineC: engine }, speed / 3600).fired);
  }
  assert.deepEqual(fired.map((f) => f.rule), []);
  assert.ok(Math.abs(m.describe(40).fuelPerKm - 3.6) < 0.4, `learned ${m.describe(40).fuelPerKm}`);
});

test('a vehicle that has only cruised at one speed keeps learning instead of judging', () => {
  const m = new VehicleModel();
  drive(m, { seconds: 900, speed: 45 });
  assert.equal(m.trained, false);
  assert.equal(m.describe(45).needsVariedDriving, true);
  const events = drive(m, { seconds: 300, start: 900_000, speed: 0, seed: 4 }); // first stop
  assert.ok(!events.some((e) => e.rule === 'engineAnomaly' || e.rule === 'overheatForecast'));
});
