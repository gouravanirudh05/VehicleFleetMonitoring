import { Types } from 'mongoose';
import { RULES } from './rules.js';
import { COMMANDS, OUTCOMES, driverFor } from '../../../shared/people.js';

const TIMELINE_MAX = 60;
const ESCALATE_AFTER = 3;                 // repeats before a warning becomes critical
const AUTO_RESOLVE_MS = 10 * 60_000;      // cleared, non-critical, nobody took it: close it
const COMMAND_TTL_MS = 2 * 60_000;        // undelivered instructions expire
const CONFIRM_WAIT_MS = 60_000;           // delivered but no reply: prompt a call

const CLEARED_TEXT = {
  overspeed: 'Back under the speed limit',
  harshBraking: 'Single event, nothing ongoing',
  longIdle: 'Vehicle is moving again',
  geofenceExit: 'Back inside its operating area',
  overheat: 'Engine temperature back to normal',
  noSignal: 'Vehicle is reporting again',
  overheatForecast: 'Temperature stopped climbing',
  engineAnomaly: 'Engine back within its normal range',
  fuelDrop: 'Single event, nothing ongoing',
};

export class IncidentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Turns rule hits into incidents a person can work. One unresolved incident per vehicle and
 * rule: repeats merge into it (and escalate), the condition ending marks it "cleared", and a
 * person resolves it with an outcome. Driver instructions queue here until the vehicle's next
 * upload collects them, and the driver's confirmation comes back the same way.
 * No I/O: the writer persists `takeDirty()`, the realtime layer broadcasts `takeChanged()`.
 */
export class Incidents {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.open = new Map();      // `${vehicleId}|${rule}` -> unresolved incident
    this.byId = new Map();      // id -> incident (unresolved, or resolved but not yet persisted)
    this.changed = new Set();   // ids to broadcast
    this.dirty = new Set();     // ids to persist
    this.queued = new Map();    // vehicleId -> [command id] waiting for delivery
    this.commands = new Map();  // command id -> { incident, cmd }
  }

  /* ---------------- helpers ---------------- */

  #touch(inc) { this.changed.add(inc.id); this.dirty.add(inc.id); }

  #log(inc, type, text, by = null) {
    inc.timeline.push({ t: this.now(), type, text, by });
    if (inc.timeline.length > TIMELINE_MAX) inc.timeline.splice(1, inc.timeline.length - TIMELINE_MAX);
  }

  #get(id) {
    const inc = this.byId.get(String(id));
    if (!inc) throw new IncidentError(404, 'Incident not found or already closed');
    return inc;
  }

  #own(inc, user) {
    if (!inc.owner) {
      inc.owner = { by: user, at: this.now() };
      this.#log(inc, 'acknowledged', `${user} took ownership`, user);
    }
  }

  /* ---------------- from the rules ---------------- */

  fire({ vehicleId, fleetId, kind }, alert) {
    const key = `${vehicleId}|${alert.rule}`;
    let inc = this.open.get(key);
    if (inc) {
      inc.count++;
      inc.lastSeenAt = alert.ts;
      inc.message = alert.message;
      if (alert.value != null && (inc.value == null || alert.value > inc.value)) inc.value = alert.value;
      if (inc.status === 'cleared') {
        inc.status = 'active';
        inc.clearedAt = null;
        this.#log(inc, 'retriggered', `Happened again: ${alert.message}`);
      } else {
        this.#log(inc, 'retriggered', alert.message);
      }
      if (inc.count >= ESCALATE_AFTER && inc.severity !== 'critical') {
        inc.severity = 'critical';
        this.#log(inc, 'escalated', `Raised to critical after ${inc.count} occurrences`);
      }
    } else {
      inc = {
        id: new Types.ObjectId().toString(),
        vehicleId, fleetId, kind, driver: driverFor(vehicleId),
        rule: alert.rule, source: RULES[alert.rule]?.source || 'rule', severity: alert.severity, status: 'active',
        ts: alert.ts, lastSeenAt: alert.ts, clearedAt: null, resolvedAt: null,
        count: 1, message: alert.message, value: alert.value, threshold: alert.threshold, readings: alert.readings,
        owner: null, outcome: null, note: '', commands: [], timeline: [],
      };
      this.#log(inc, 'opened', alert.message);
      this.open.set(key, inc);
      this.byId.set(inc.id, inc);
    }
    if (RULES[alert.rule]?.instant) this.clear(vehicleId, alert.rule, alert.ts);
    this.#touch(inc);
    return inc;
  }

  clear(vehicleId, rule, ts = this.now()) {
    const inc = this.open.get(`${vehicleId}|${rule}`);
    if (!inc || inc.status !== 'active') return null;
    inc.status = 'cleared';
    inc.clearedAt = ts;
    this.#log(inc, 'cleared', CLEARED_TEXT[rule] || 'Condition ended');
    this.#touch(inc);
    return inc;
  }

  /** Housekeeping, every few seconds: auto-close quiet incidents, expire stale instructions. */
  sweep() {
    const now = this.now();
    for (const inc of [...this.open.values()]) {
      if (inc.status === 'cleared' && !inc.owner && inc.severity !== 'critical' && now - inc.clearedAt > AUTO_RESOLVE_MS) {
        this.#resolve(inc, null, 'clearedOnItsOwn', '');
      }
    }
    for (const [id, { incident, cmd }] of this.commands) {
      if (cmd.status === 'queued' && now - cmd.sentAt > COMMAND_TTL_MS) {
        cmd.status = 'expired';
        this.#log(incident, 'expired', `"${cmd.label}" was not delivered: the vehicle did not report`);
        this.#unqueue(incident.vehicleId, id);
        this.commands.delete(id);
        this.#touch(incident);
      } else if (cmd.status === 'delivered' && now - cmd.deliveredAt > CONFIRM_WAIT_MS) {
        cmd.status = 'unconfirmed';
        this.#log(incident, 'unconfirmed', `No reply to "${cmd.label}" after ${Math.round(CONFIRM_WAIT_MS / 1000)} s. Try calling ${incident.driver.name}.`);
        this.#touch(incident);
      } else if (!['queued', 'delivered', 'unconfirmed'].includes(cmd.status)) {
        this.commands.delete(id);
      }
    }
  }

  /* ---------------- dispatcher actions ---------------- */

  acknowledge(id, user) {
    const inc = this.#get(id);
    if (inc.owner) throw new IncidentError(409, `Already owned by ${inc.owner.by}`);
    this.#own(inc, user);
    this.#touch(inc);
    return inc;
  }

  addNote(id, user, text) {
    const inc = this.#get(id);
    this.#log(inc, 'note', text, user);
    this.#touch(inc);
    return inc;
  }

  logCall(id, user, result) {
    const inc = this.#get(id);
    this.#own(inc, user);
    this.#log(inc, 'call', result === 'reached' ? `Called ${inc.driver.name}: reached` : `Called ${inc.driver.name}: no answer`, user);
    this.#touch(inc);
    return inc;
  }

  sendCommand(id, user, type) {
    const inc = this.#get(id);
    const def = COMMANDS[type];
    if (!def) throw new IncidentError(400, 'Unknown instruction');
    if (inc.commands.some((c) => c.type === type && (c.status === 'queued' || c.status === 'delivered'))) {
      throw new IncidentError(409, `"${def.label}" is already on its way`);
    }
    this.#own(inc, user);
    const cmd = { id: new Types.ObjectId().toString(), type, label: def.label, status: 'queued', sentBy: user, sentAt: this.now(), deliveredAt: null, confirmedAt: null };
    inc.commands.push(cmd);
    this.commands.set(cmd.id, { incident: inc, cmd });
    let q = this.queued.get(inc.vehicleId);
    if (!q) this.queued.set(inc.vehicleId, (q = []));
    q.push(cmd.id);
    this.#log(inc, 'command', `Sent "${def.label}" to ${inc.driver.name}`, user);
    this.#touch(inc);
    return inc;
  }

  resolve(id, user, outcome, note = '') {
    const inc = this.#get(id);
    if (!OUTCOMES[outcome]) throw new IncidentError(400, 'Pick an outcome');
    this.#resolve(inc, user, outcome, note);
    return inc;
  }

  #resolve(inc, user, outcome, note) {
    if (user) this.#own(inc, user);
    inc.status = 'resolved';
    inc.resolvedAt = this.now();
    inc.outcome = outcome;
    inc.note = note;
    this.#log(inc, 'resolved', `${OUTCOMES[outcome]}${note ? `: ${note}` : ''}`, user);
    this.open.delete(`${inc.vehicleId}|${inc.rule}`);
    for (const c of inc.commands) if (c.status === 'queued') { c.status = 'cancelled'; this.#unqueue(inc.vehicleId, c.id); }
    this.#touch(inc);
  }

  /* ---------------- the vehicle side ---------------- */

  /** Instructions waiting for these vehicles; marks them delivered. Called per ingest request. */
  takeCommandsFor(vehicleIds) {
    const out = [];
    for (const vehicleId of vehicleIds) {
      const q = this.queued.get(vehicleId);
      if (!q?.length) continue;
      for (const id of q) {
        const entry = this.commands.get(id);
        if (!entry) continue;
        const { incident, cmd } = entry;
        cmd.status = 'delivered';
        cmd.deliveredAt = this.now();
        this.#log(incident, 'delivered', `"${cmd.label}" shown on the driver's tablet`);
        this.#touch(incident);
        out.push({ id, vehicleId, type: cmd.type, text: COMMANDS[cmd.type].text });
      }
      this.queued.delete(vehicleId);
    }
    return out;
  }

  /** The driver tapped "OK" on the instruction. Returns false for unknown or stale ids. */
  confirmCommand(id, vehicleId) {
    const entry = this.commands.get(String(id));
    if (!entry || entry.incident.vehicleId !== vehicleId || !['delivered', 'unconfirmed'].includes(entry.cmd.status)) return false;
    const { incident, cmd } = entry;
    cmd.status = 'confirmed';
    cmd.confirmedAt = this.now();
    this.#log(incident, 'confirmed', `${incident.driver.name} confirmed "${cmd.label}" after ${Math.round((cmd.confirmedAt - cmd.sentAt) / 1000)} s`);
    this.commands.delete(String(id));
    this.#touch(incident);
    return true;
  }

  #unqueue(vehicleId, id) {
    const q = this.queued.get(vehicleId);
    if (!q) return;
    const i = q.indexOf(id);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) this.queued.delete(vehicleId);
  }

  /* ---------------- persistence and broadcast ---------------- */

  unresolved() { return [...this.open.values()]; }

  takeChanged() {
    const out = [];
    for (const id of this.changed) { const inc = this.byId.get(id); if (inc) out.push(inc); }
    this.changed.clear();
    return out;
  }

  /** Incidents to write. Resolved ones leave memory once handed over. */
  takeDirty() {
    const out = [];
    for (const id of this.dirty) {
      const inc = this.byId.get(id);
      if (!inc) continue;
      out.push(structuredClone(inc));
      if (inc.status === 'resolved' && !this.changed.has(id)) this.byId.delete(id);
    }
    this.dirty.clear();
    return out;
  }

  hydrate(docs) {
    for (const d of docs) {
      const inc = { ...d, id: String(d._id ?? d.id) };
      delete inc._id;
      for (const k of ['ts', 'lastSeenAt', 'clearedAt', 'resolvedAt']) if (inc[k]) inc[k] = new Date(inc[k]).valueOf();
      if (inc.owner?.at) inc.owner.at = new Date(inc.owner.at).valueOf();
      this.byId.set(inc.id, inc);
      this.open.set(`${inc.vehicleId}|${inc.rule}`, inc);
    }
  }
}

/** Wire/API shape. Timestamps are epoch ms. */
export function serializeIncident(inc) {
  const ms = (v) => (v == null ? null : new Date(v).valueOf());
  return {
    id: String(inc.id ?? inc._id), vehicleId: inc.vehicleId, fleetId: inc.fleetId, kind: inc.kind, driver: inc.driver,
    rule: inc.rule, source: inc.source || 'rule', severity: inc.severity, status: inc.status,
    ts: ms(inc.ts), lastSeenAt: ms(inc.lastSeenAt), clearedAt: ms(inc.clearedAt), resolvedAt: ms(inc.resolvedAt),
    count: inc.count, message: inc.message, value: inc.value, threshold: inc.threshold, readings: inc.readings,
    owner: inc.owner ? { by: inc.owner.by, at: ms(inc.owner.at) } : null,
    outcome: inc.outcome, note: inc.note,
    commands: (inc.commands || []).map((c) => ({ ...c, sentAt: ms(c.sentAt), deliveredAt: ms(c.deliveredAt), confirmedAt: ms(c.confirmedAt) })),
    timeline: (inc.timeline || []).map((e) => ({ ...e, t: ms(e.t) })),
  };
}
