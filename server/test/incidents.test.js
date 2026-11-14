import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Incidents } from '../src/pipeline/incidents.js';

const reg = { vehicleId: 'KA01-AB-4471', fleetId: 'north-depot', kind: 'truck' };
const alert = (rule, extra = {}) => ({ rule, severity: 'warning', message: 'm', value: 70, threshold: 60, ts: 1, seq: 1, readings: {}, ...extra });

function setup() {
  const clock = { now: 1_800_000_000_000 };
  return { inc: new Incidents({ now: () => clock.now }), clock };
}

test('repeats merge into one incident and escalate after three', () => {
  const { inc } = setup();
  const a = inc.fire(reg, alert('overspeed'));
  inc.clear(reg.vehicleId, 'overspeed');
  assert.equal(a.status, 'cleared');
  const b = inc.fire(reg, alert('overspeed', { value: 85 }));
  assert.equal(b, a);
  assert.equal(a.status, 'active', 'retrigger reopens');
  inc.fire(reg, alert('overspeed'));
  assert.equal(a.count, 3);
  assert.equal(a.severity, 'critical');
  assert.equal(a.value, 85, 'keeps the peak value');
  assert.equal(inc.unresolved().length, 1);
});

test('harsh braking is a single event and arrives already cleared', () => {
  const { inc } = setup();
  assert.equal(inc.fire(reg, alert('harshBraking')).status, 'cleared');
});

test('instruction round trip: queued, delivered on upload, confirmed by the driver', () => {
  const { inc } = setup();
  const i = inc.fire(reg, alert('overspeed'));
  inc.sendCommand(i.id, 'admin', 'slowDown');
  assert.equal(i.owner.by, 'admin', 'sending an instruction takes ownership');
  assert.throws(() => inc.sendCommand(i.id, 'admin', 'slowDown'), /already on its way/);
  assert.deepEqual(inc.takeCommandsFor(['OTHER-1']), []);
  const [cmd] = inc.takeCommandsFor([reg.vehicleId]);
  assert.equal(cmd.type, 'slowDown');
  assert.equal(i.commands[0].status, 'delivered');
  assert.equal(inc.takeCommandsFor([reg.vehicleId]).length, 0, 'delivered once');
  assert.equal(inc.confirmCommand(cmd.id, 'WRONG-ID'), false);
  assert.equal(inc.confirmCommand(cmd.id, reg.vehicleId), true);
  assert.equal(i.commands[0].status, 'confirmed');
  assert.ok(i.timeline.some((e) => e.type === 'confirmed'));
});

test('undelivered instructions expire and unanswered ones prompt a call', () => {
  const { inc, clock } = setup();
  const i = inc.fire(reg, alert('overspeed'));
  inc.sendCommand(i.id, 'admin', 'slowDown');
  clock.now += 3 * 60_000;
  inc.sweep();
  assert.equal(i.commands[0].status, 'expired');

  inc.sendCommand(i.id, 'admin', 'callControl');
  inc.takeCommandsFor([reg.vehicleId]);
  clock.now += 61_000;
  inc.sweep();
  assert.equal(i.commands[1].status, 'unconfirmed');
  assert.match(i.timeline.at(-1).text, /Try calling/);
});

test('resolving needs an outcome, closes the incident and frees the slot', () => {
  const { inc } = setup();
  const i = inc.fire(reg, alert('overheat'));
  assert.throws(() => inc.resolve(i.id, 'admin', 'nope'), /outcome/);
  inc.resolve(i.id, 'admin', 'driverCorrected', 'Driver pulled over');
  assert.equal(i.status, 'resolved');
  assert.equal(inc.unresolved().length, 0);
  assert.notEqual(inc.fire(reg, alert('overheat')).id, i.id, 'a new problem opens a new incident');
});

test('quiet non-critical incidents close themselves; critical ones wait for a person', () => {
  const { inc, clock } = setup();
  const warn = inc.fire(reg, alert('overspeed'));
  const crit = inc.fire({ ...reg, vehicleId: 'KA01-XX-0001' }, alert('geofenceExit', { severity: 'critical' }));
  inc.clear(reg.vehicleId, 'overspeed');
  inc.clear('KA01-XX-0001', 'geofenceExit');
  clock.now += 11 * 60_000;
  inc.sweep();
  assert.equal(warn.status, 'resolved');
  assert.equal(warn.outcome, 'clearedOnItsOwn');
  assert.equal(crit.status, 'cleared');
});

test('acknowledging twice is refused', () => {
  const { inc } = setup();
  const i = inc.fire(reg, alert('overspeed'));
  inc.acknowledge(i.id, 'admin');
  assert.throws(() => inc.acknowledge(i.id, 'north'), /Already owned by admin/);
});
