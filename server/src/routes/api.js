import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ROOT } from '../config.js';
import { FLEETS, ZONES, DEFAULT_LIMIT_KMH } from '../../../shared/geo.js';
import { COMMANDS, OUTCOMES, SUGGESTED_COMMAND, driverFor } from '../../../shared/people.js';
import { requireUser, requireDevice, signToken, canSeeFleet, allowedFleets } from '../auth.js';
import { User, Vehicle, Incident, FollowUp, Rollup } from '../models/index.js';
import { telemetry } from '../db.js';
import { deviceRegistration } from '../pipeline/schema.js';
import { RULES } from '../pipeline/rules.js';
import { IncidentError, serializeIncident } from '../pipeline/incidents.js';
import { computeHealth } from '../pipeline/health.js';

const HISTORY_MAX_MINUTES = 120;
const HISTORY_MAX_POINTS = 20000;

const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Dispatchers only' }));

export function apiRouter({ pipeline, metrics, config }) {
  const r = express.Router();
  const incidents = pipeline.incidents;

  /* ---------------- vehicle gateway ---------------- */

  // One limiter per client IP for device endpoints. Per-device limits apply inside the pipeline.
  const deviceLimiter = rateLimit({ windowMs: 1000, limit: 50, standardHeaders: 'draft-7', legacyHeaders: false });

  r.post('/devices/register', requireDevice, express.json({ limit: '1mb' }), async (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    const parsed = z.array(deviceRegistration).max(10000).safeParse(list);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration' });
    for (const d of parsed.data) pipeline.register(d);
    await Vehicle.bulkWrite(parsed.data.map((d) => ({
      updateOne: { filter: { _id: d.vehicleId }, update: { $set: d }, upsert: true },
    })), { ordered: false });
    res.json({ registered: parsed.data.length });
  });

  /**
   * Readings in, instructions out: the response carries any dispatcher instructions queued for
   * the vehicles in this batch, so the downlink needs no extra connection.
   */
  r.post('/ingest', deviceLimiter, requireDevice, express.json({ limit: '2mb' }), (req, res) => {
    if (pipeline.overloaded()) {
      metrics.inc('overloaded', Array.isArray(req.body) ? req.body.length : 1);
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Ingest buffer full, retry shortly' });
    }
    const events = Array.isArray(req.body) ? req.body : [req.body];
    if (events.length > config.maxBatchEvents) {
      return res.status(413).json({ error: `At most ${config.maxBatchEvents} events per request` });
    }
    const result = pipeline.ingest(events);
    const ids = new Set();
    for (const e of events) if (typeof e?.vehicleId === 'string') ids.add(e.vehicleId);
    result.commands = incidents.takeCommandsFor(ids);
    res.status(result.accepted || !events.length ? 202 : 422).json(result);
  });

  const ackBody = z.array(z.object({ id: z.string().max(40), vehicleId: z.string().max(24) })).max(1000);
  r.post('/devices/ack', deviceLimiter, requireDevice, express.json(), (req, res) => {
    const p = ackBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Expected [{ id, vehicleId }]' });
    let confirmed = 0;
    for (const { id, vehicleId } of p.data) if (incidents.confirmCommand(id, vehicleId)) confirmed++;
    res.json({ confirmed });
  });

  /* ---------------- auth ---------------- */

  const loginLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) });

  r.post('/auth/login', loginLimiter, express.json(), async (req, res) => {
    const p = loginBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Enter a username and password' });
    const user = await User.findOne({ username: p.data.username.toLowerCase() });
    if (!user || !(await bcrypt.compare(p.data.password, user.passwordHash))) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  r.get('/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

  /* ---------------- reference data ---------------- */

  r.get('/fleets', requireUser, (req, res) => {
    res.json({
      fleets: FLEETS.filter((f) => canSeeFleet(req.user, f.id)),
      zones: ZONES,
      defaultLimitKmh: DEFAULT_LIMIT_KMH,
      rules: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.label])),
      commands: Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.label])),
      suggested: SUGGESTED_COMMAND,
      outcomes: OUTCOMES,
    });
  });

  /* ---------------- vehicles ---------------- */

  const vehicleFor = (req, res) => {
    const reg = pipeline.registry.get(req.params.id);
    if (!reg || !canSeeFleet(req.user, reg.fleetId)) { res.status(404).json({ error: 'Vehicle not found' }); return null; }
    return reg;
  };

  r.get('/vehicles', requireUser, (req, res) => {
    res.json({ t: Date.now(), d: pipeline.snapshot(allowedFleets(req.user, req.query.fleet)) });
  });

  r.get('/vehicles/:id', requireUser, async (req, res) => {
    const reg = vehicleFor(req, res);
    if (!reg) return;
    const [recent, followUps] = await Promise.all([
      Incident.find({ vehicleId: reg.vehicleId, status: 'resolved' }).sort({ resolvedAt: -1 }).limit(10).lean(),
      FollowUp.find({ vehicleId: reg.vehicleId, status: 'open' }).sort({ due: 1 }).lean(),
    ]);
    res.json({
      vehicle: { ...reg, driver: driverFor(reg.vehicleId), ...(pipeline.states.get(reg.vehicleId) || {}) },
      model: pipeline.ml.models.get(reg.vehicleId)?.describe(pipeline.states.get(reg.vehicleId)?.speedKmh) ?? null,
      open: incidents.unresolved().filter((i) => i.vehicleId === reg.vehicleId).map(serializeIncident),
      resolved: recent.map(serializeIncident),
      followUps: followUps.map(serializeFollowUp),
    });
  });

  /**
   * Raw history for one vehicle, oldest first, as [seq, ts, lat, lng, speed, fuel, engine].
   * Accepted-but-unflushed events are merged in and everything is deduped by seq, so a client
   * that joined the vehicle room before calling this can join both lists without gaps.
   */
  r.get('/vehicles/:id/history', requireUser, async (req, res) => {
    const reg = vehicleFor(req, res);
    if (!reg) return;
    const minutes = Math.min(HISTORY_MAX_MINUTES, Math.max(1, Number(req.query.minutes) || 15));
    const since = Date.now() - minutes * 60_000;
    const docs = await telemetry()
      .find({ 'meta.vehicleId': reg.vehicleId, ts: { $gte: new Date(since) } },
        { projection: { _id: 0, seq: 1, ts: 1, lat: 1, lng: 1, speedKmh: 1, fuelPct: 1, engineC: 1 } })
      .sort({ ts: 1 })
      .limit(HISTORY_MAX_POINTS)
      .toArray();
    const bySeq = new Map();
    for (const d of docs) bySeq.set(d.seq, [d.seq, d.ts.valueOf(), d.lat, d.lng, d.speedKmh, d.fuelPct, d.engineC]);
    const fromDb = bySeq.size;
    for (const p of pipeline.unflushedFor(reg.vehicleId, since)) bySeq.set(p[0], p);
    const points = [...bySeq.values()].sort((a, b) => a[0] - b[0]);
    res.json({ vehicleId: reg.vehicleId, minutes, fromDb, fromBuffer: points.length - fromDb, lastSeq: points.at(-1)?.[0] ?? null, points });
  });

  /* ---------------- incidents ---------------- */

  r.get('/incidents', requireUser, async (req, res) => {
    const fleets = allowedFleets(req.user, req.query.fleet);
    const vehicle = req.query.vehicle ? String(req.query.vehicle) : null;
    const keep = (i) => fleets.includes(i.fleetId) && (!vehicle || i.vehicleId === vehicle);
    if (req.query.status === 'resolved') {
      const limit = Math.min(200, Number(req.query.limit) || 50);
      const q = { status: 'resolved', fleetId: { $in: fleets } };
      if (vehicle) q.vehicleId = vehicle;
      const docs = await Incident.find(q).sort({ resolvedAt: -1 }).limit(limit).lean();
      return res.json({ incidents: docs.map(serializeIncident) });
    }
    res.json({ incidents: incidents.unresolved().filter(keep).map(serializeIncident) });
  });

  r.get('/incidents/:id', requireUser, async (req, res) => {
    let inc = incidents.byId.get(req.params.id);
    if (!inc && mongoose.isValidObjectId(req.params.id)) inc = await Incident.findById(req.params.id).lean();
    if (!inc || !canSeeFleet(req.user, inc.fleetId)) return res.status(404).json({ error: 'Incident not found' });
    res.json({ incident: serializeIncident(inc) });
  });

  /** Runs one dispatcher action on a live incident after the fleet access check. */
  const act = (handler) => [requireUser, express.json(), async (req, res) => {
    const inc = incidents.byId.get(req.params.id);
    if (!inc || !canSeeFleet(req.user, inc.fleetId)) return res.status(404).json({ error: 'Incident not found or already closed' });
    try {
      const out = await handler(req, inc);
      res.json({ incident: serializeIncident(out || inc) });
    } catch (err) {
      if (err instanceof IncidentError) return res.status(err.status).json({ error: err.message });
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0]?.message || 'Invalid request' });
      throw err;
    }
  }];

  r.post('/incidents/:id/ack', ...act((req) => incidents.acknowledge(req.params.id, req.user.username)));

  r.post('/incidents/:id/note', ...act((req) => {
    const { text } = z.object({ text: z.string().trim().min(1, 'Write a note').max(500) }).parse(req.body);
    return incidents.addNote(req.params.id, req.user.username, text);
  }));

  r.post('/incidents/:id/call', ...act((req) => {
    const { result } = z.object({ result: z.enum(['reached', 'noAnswer'], { message: 'Say whether you reached the driver' }) }).parse(req.body);
    return incidents.logCall(req.params.id, req.user.username, result);
  }));

  r.post('/incidents/:id/command', ...act((req) => {
    const { type } = z.object({ type: z.enum(Object.keys(COMMANDS), { message: 'Unknown instruction' }) }).parse(req.body);
    return incidents.sendCommand(req.params.id, req.user.username, type);
  }));

  r.post('/incidents/:id/resolve', ...act(async (req, inc) => {
    const body = z.object({
      outcome: z.enum(Object.keys(OUTCOMES), { message: 'Pick an outcome' }),
      note: z.string().trim().max(500).optional().default(''),
      followUp: z.enum(['coaching', 'maintenance']).nullable().optional(),
    }).parse(req.body);
    const out = incidents.resolve(req.params.id, req.user.username, body.outcome, body.note);
    if (body.followUp) {
      await createFollowUp({
        vehicleId: inc.vehicleId, fleetId: inc.fleetId, kind: body.followUp, incidentId: inc.id,
        reason: `${RULES[inc.rule]?.label || inc.rule}: ${inc.message}`, dueInDays: body.followUp === 'maintenance' ? 2 : 7, by: req.user.username,
      }).catch(() => {}); // already scheduled is fine here
    }
    return out;
  }));

  /* ---------------- follow-ups ---------------- */

  async function createFollowUp({ vehicleId, fleetId, kind, reason, incidentId, dueInDays, by }) {
    const existing = await FollowUp.findOne({ vehicleId, kind, status: 'open' }).lean();
    if (existing) throw new IncidentError(409, `${kind === 'coaching' ? 'Coaching' : 'A maintenance check'} is already scheduled for ${vehicleId}`);
    return FollowUp.create({
      vehicleId, fleetId, kind, reason, incidentId, driver: driverFor(vehicleId),
      due: new Date(Date.now() + dueInDays * 86400_000), createdBy: by,
    });
  }

  r.get('/followups', requireUser, async (req, res) => {
    const fleets = allowedFleets(req.user, req.query.fleet);
    const status = req.query.status === 'done' ? 'done' : 'open';
    const docs = await FollowUp.find({ fleetId: { $in: fleets }, status }).sort(status === 'open' ? { due: 1 } : { doneAt: -1 }).limit(200).lean();
    res.json({ followUps: docs.map(serializeFollowUp) });
  });

  r.post('/followups', requireUser, express.json(), async (req, res) => {
    const p = z.object({
      vehicleId: z.string().max(24), kind: z.enum(['coaching', 'maintenance']),
      reason: z.string().trim().max(300).optional().default(''), dueInDays: z.number().int().min(0).max(60).default(7),
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message || 'Invalid follow-up' });
    const reg = pipeline.registry.get(p.data.vehicleId);
    if (!reg || !canSeeFleet(req.user, reg.fleetId)) return res.status(404).json({ error: 'Vehicle not found' });
    try {
      const doc = await createFollowUp({ ...p.data, fleetId: reg.fleetId, by: req.user.username });
      res.status(201).json({ followUp: serializeFollowUp(doc) });
    } catch (err) {
      if (err instanceof IncidentError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

  r.post('/followups/:id/done', requireUser, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Follow-up not found' });
    const doc = await FollowUp.findById(req.params.id);
    if (!doc || !canSeeFleet(req.user, doc.fleetId)) return res.status(404).json({ error: 'Follow-up not found' });
    if (doc.status !== 'done') { doc.status = 'done'; doc.doneBy = req.user.username; doc.doneAt = new Date(); await doc.save(); }
    res.json({ followUp: serializeFollowUp(doc) });
  });

  /* ---------------- reports ---------------- */

  r.get('/analytics', requireUser, async (req, res) => {
    const fleets = allowedFleets(req.user, req.query.fleet);
    const hours = [1, 6, 24].includes(Number(req.query.hours)) ? Number(req.query.hours) : 1;
    const binMin = hours === 1 ? 1 : hours === 6 ? 5 : 15;
    const since = new Date(Date.now() - hours * 3600_000);
    const bucketExpr = { $dateTrunc: { date: '$bucket', unit: 'minute', binSize: binMin } };
    const incMatch = { fleetId: { $in: fleets }, ts: { $gte: since } };
    const rollupMatch = { fleetId: { $in: fleets }, bucket: { $gte: since } };
    const median = (field) => ({ $percentile: { input: field, p: [0.5], method: 'approximate' } });

    const [perFleet, incSeries, byRule, byFleet, topVehicles, points, response, outcomes] = await Promise.all([
      Rollup.aggregate([
        { $match: rollupMatch },
        { $group: { _id: '$fleetId', events: { $sum: '$events' }, km: { $sum: '$km' }, speedSum: { $sum: '$speedSum' }, speedMax: { $max: '$speedMax' }, vehicles: { $max: '$vehicles' } } },
      ]),
      Incident.aggregate([
        { $match: incMatch },
        { $group: { _id: { $dateTrunc: { date: '$ts', unit: 'minute', binSize: binMin } }, n: { $sum: 1 }, critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
      ]),
      Incident.aggregate([{ $match: incMatch }, { $group: { _id: '$rule', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      Incident.aggregate([
        { $match: incMatch },
        { $group: { _id: '$fleetId', n: { $sum: 1 }, critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } } } },
      ]),
      Incident.aggregate([
        { $match: incMatch },
        { $group: {
          _id: '$vehicleId', n: { $sum: 1 }, fleetId: { $first: '$fleetId' }, driver: { $first: '$driver' },
          rules: { $addToSet: '$rule' }, last: { $max: '$ts' }, critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
        } },
        { $sort: { critical: -1, n: -1 } },
        { $limit: 12 },
      ]),
      Incident.find(incMatch, { _id: 0, rule: 1, severity: 1, 'readings.lat': 1, 'readings.lng': 1 }).sort({ ts: -1 }).limit(5000).lean(),
      Incident.aggregate([
        { $match: { ...incMatch, 'owner.by': { $ne: null } } },
        { $project: {
          ackSec: { $divide: [{ $subtract: ['$owner.at', '$ts'] }, 1000] },
          resolveSec: { $cond: [{ $and: [{ $eq: ['$status', 'resolved'] }, { $ne: ['$outcome', 'clearedOnItsOwn'] }] }, { $divide: [{ $subtract: ['$resolvedAt', '$ts'] }, 1000] }, null] },
        } },
        { $group: { _id: null, ack: median('$ackSec'), resolve: median('$resolveSec'), handled: { $sum: 1 } } },
      ]),
      Incident.aggregate([{ $match: { ...incMatch, status: 'resolved' } }, { $group: { _id: '$outcome', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    ]);

    const openFollowUps = await FollowUp.find({ vehicleId: { $in: topVehicles.map((v) => v._id) }, status: 'open' }, { vehicleId: 1, kind: 1, due: 1 }).lean();
    const fuByVehicle = new Map();
    for (const f of openFollowUps) {
      if (!fuByVehicle.has(f.vehicleId)) fuByVehicle.set(f.vehicleId, []);
      fuByVehicle.get(f.vehicleId).push({ kind: f.kind, due: f.due.valueOf() });
    }
    const incByFleet = new Map(byFleet.map((a) => [a._id, a]));
    const resp = response[0];
    const open = incidents.unresolved().filter((i) => fleets.includes(i.fleetId));

    res.json({
      hours, binMin, fleets,
      open: { total: open.length, critical: open.filter((i) => i.severity === 'critical').length, unowned: open.filter((i) => !i.owner).length },
      response: { ackSec: resp?.ack?.[0] ?? null, resolveSec: resp?.resolve?.[0] ?? null, handled: resp?.handled || 0 },
      outcomes: outcomes.map((o) => ({ outcome: o._id, label: OUTCOMES[o._id] || o._id, n: o.n })),
      incidentsOverTime: incSeries.map((a) => ({ t: a._id.valueOf(), n: a.n, critical: a.critical })),
      byRule: byRule.map((b) => ({ rule: b._id, label: RULES[b._id]?.label || b._id, n: b.n })),
      perFleet: perFleet.map((f) => ({
        fleetId: f._id, events: f.events, km: f.km || 0, vehicles: f.vehicles, avgSpeed: f.events ? f.speedSum / f.events : 0, maxSpeed: f.speedMax,
        incidents: incByFleet.get(f._id)?.n || 0, critical: incByFleet.get(f._id)?.critical || 0,
      })),
      topVehicles: topVehicles.map((v) => ({
        vehicleId: v._id, fleetId: v.fleetId, driver: v.driver, incidents: v.n, critical: v.critical, rules: v.rules,
        last: v.last.valueOf(), followUps: fuByVehicle.get(v._id) || [],
      })),
      points: points.filter((a) => a.readings?.lat != null).map((a) => [a.readings.lng, a.readings.lat, a.rule, a.severity]),
    });
  });

  /* ---------------- system health (dispatchers) ---------------- */

  r.get('/system', requireUser, requireAdmin, (req, res) => {
    res.json(metrics.snapshot({
      vehicles: pipeline.states.size,
      series: metrics.series,
      health: computeHealth({ metrics, pipeline, config, dbConnected: mongoose.connection.readyState === 1 }),
      config: { broadcastMs: config.broadcastMs, flushMs: config.flushMs, deviceRatePerSec: config.deviceRatePerSec, deviceBurst: config.deviceBurst, maxPendingWrites: config.maxPendingWrites },
    }));
  });

  r.get('/stress-results', requireUser, requireAdmin, async (req, res) => {
    try {
      res.json(JSON.parse(await fs.readFile(path.join(ROOT, 'stress-results.json'), 'utf8')));
    } catch {
      res.status(404).json({ error: 'No load test has been run yet' });
    }
  });

  // Kept for the load-test script, which reads raw counters.
  r.get('/metrics', requireUser, requireAdmin, (req, res) => res.json(metrics.snapshot({ vehicles: pipeline.states.size })));

  r.get('/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1, uptimeSec: Math.round(process.uptime()) }));

  return r;
}

function publicUser(u) {
  return { username: u.username, role: u.role, fleets: u.role === 'admin' ? FLEETS.map((f) => f.id) : u.fleets };
}

function serializeFollowUp(f) {
  const ms = (v) => (v == null ? null : new Date(v).valueOf());
  return {
    id: String(f._id), vehicleId: f.vehicleId, fleetId: f.fleetId, driver: f.driver, kind: f.kind, reason: f.reason,
    incidentId: f.incidentId || null, due: ms(f.due), status: f.status, createdBy: f.createdBy, createdAt: ms(f.createdAt),
    doneBy: f.doneBy || null, doneAt: ms(f.doneAt),
  };
}
