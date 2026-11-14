import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../src/pipeline/rules.js';

const cfg = { idleAlertSec: 60 };
// 12.95, 77.55 is outside every speed zone, so the 60 km/h default applies.
const base = { lat: 12.95, lng: 77.55, speedKmh: 40, fuelPct: 60, engineC: 88, engineOn: true };
const evalAt = (rs, seq, ts, extra) => evaluateRules(rs, { ...base, seq, ts, ...extra }, 'north-depot', cfg);
const run = (rs, seq, ts, extra) => evalAt(rs, seq, ts, extra).fired;

test('overspeed fires once after 10 s above the limit and re-arms', () => {
  const rs = {};
  let fired = [];
  for (let i = 0; i <= 12; i++) fired.push(...run(rs, i, i * 1000, { speedKmh: 75 }));
  assert.equal(fired.filter((a) => a.rule === 'overspeed').length, 1);
  assert.equal(fired[0].threshold, 60);
  run(rs, 13, 13000, { speedKmh: 50 });
  fired = [];
  for (let i = 14; i <= 26; i++) fired.push(...run(rs, i, i * 1000, { speedKmh: 75 }));
  assert.equal(fired.filter((a) => a.rule === 'overspeed').length, 1);
});

test('short overspeed does not fire', () => {
  const rs = {};
  const fired = [];
  for (let i = 0; i < 8; i++) fired.push(...run(rs, i, i * 1000, { speedKmh: 75 }));
  assert.equal(fired.length, 0);
});

test('CBD zone uses its 40 km/h limit', () => {
  const rs = {};
  const fired = [];
  for (let i = 0; i <= 10; i++) fired.push(...run(rs, i, i * 1000, { lat: 12.9756, lng: 77.605, speedKmh: 50 }));
  assert.equal(fired[0]?.rule, 'overspeed');
  assert.equal(fired[0].threshold, 40);
});

test('harsh braking beyond 0.4 g', () => {
  const rs = {};
  run(rs, 1, 0, { speedKmh: 50 });
  const fired = run(rs, 2, 1000, { speedKmh: 30 }); // 20 km/h in 1 s = 0.57 g
  assert.equal(fired[0]?.rule, 'harshBraking');
  assert.equal(run(rs, 3, 2000, { speedKmh: 25 }).length, 0); // 0.14 g
});

test('long idle after the configured time', () => {
  const rs = {};
  const fired = [];
  for (let i = 0; i <= 61; i++) fired.push(...run(rs, i, i * 1000, { speedKmh: 0 }));
  assert.deepEqual(fired.map((a) => a.rule), ['longIdle']);
});

test('geofence exit fires on leaving, not when first seen outside', () => {
  const outside = { lat: 13.3, lng: 77.9 };
  assert.equal(run({}, 1, 0, outside).length, 0);
  const rs = {};
  run(rs, 1, 0, {});
  assert.equal(run(rs, 2, 1000, outside)[0]?.rule, 'geofenceExit');
  assert.equal(run(rs, 3, 2000, outside).length, 0);
});

test('engine overheat after 30 s at 105 °C', () => {
  const rs = {};
  const fired = [];
  for (let i = 0; i <= 31; i++) fired.push(...run(rs, i, i * 1000, { engineC: 108 }));
  assert.deepEqual(fired.map((a) => a.rule), ['overheat']);
});

test('rules report when a fired condition ends', () => {
  const rs = {};
  for (let i = 0; i <= 11; i++) run(rs, i, i * 1000, { speedKmh: 75 });
  assert.deepEqual(evalAt(rs, 12, 12000, { speedKmh: 50 }).cleared, ['overspeed']);
  assert.deepEqual(evalAt(rs, 13, 13000, { speedKmh: 50 }).cleared, []);

  const hot = {};
  for (let i = 0; i <= 31; i++) run(hot, i, i * 1000, { engineC: 108 });
  assert.deepEqual(evalAt(hot, 32, 32000, { engineC: 103 }).cleared, [], 'still above the 100 °C clear point');
  assert.deepEqual(evalAt(hot, 33, 33000, { engineC: 95 }).cleared, ['overheat']);
});
