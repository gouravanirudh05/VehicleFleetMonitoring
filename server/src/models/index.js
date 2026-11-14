import mongoose from 'mongoose';
import { FLEET_IDS } from '../../../shared/geo.js';

const { Schema, model } = mongoose;

const userSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'dispatcher'], default: 'dispatcher' },
  // Fleets this user may watch. Admins see every fleet regardless.
  fleets: [{ type: String, enum: FLEET_IDS }],
}, { timestamps: true });

// Registry plus latest known state. The `_id` is the vehicle id, so upserts are cheap.
const vehicleSchema = new Schema({
  _id: String,
  vehicleId: { type: String, required: true },
  fleetId: { type: String, enum: FLEET_IDS, required: true, index: true },
  kind: String,
  seq: Number,
  ts: Date,
  lat: Number, lng: Number, speedKmh: Number, fuelPct: Number, engineC: Number, heading: Number,
  engineOn: Boolean,
  status: String,
  ml: Schema.Types.Mixed,   // the vehicle's learned early-warning baseline
}, { timestamps: { createdAt: true, updatedAt: true }, versionKey: false });

// One incident per vehicle and rule until a person resolves it. Repeats merge in; the timeline
// records every trigger, instruction, call, note and the resolution.
const incidentSchema = new Schema({
  vehicleId: { type: String, required: true },
  fleetId: { type: String, required: true },
  kind: String,
  driver: { id: String, name: String },
  rule: { type: String, required: true },
  source: { type: String, enum: ['rule', 'model'], default: 'rule' },
  severity: { type: String, enum: ['info', 'warning', 'critical'] },
  status: { type: String, enum: ['active', 'cleared', 'resolved'], index: true },
  ts: { type: Date, required: true },   // opened
  lastSeenAt: Date,
  clearedAt: Date,
  resolvedAt: Date,
  count: Number,
  message: String,
  value: Number,
  threshold: Number,
  readings: { lat: Number, lng: Number, speedKmh: Number, fuelPct: Number, engineC: Number },
  owner: { by: String, at: Date },
  outcome: String,
  note: String,
  commands: [{ _id: false, id: String, type: { type: String }, label: String, status: String, sentBy: String, sentAt: Date, deliveredAt: Date, confirmedAt: Date }],
  timeline: [{ _id: false, t: Date, type: { type: String }, text: String, by: String }],
}, { versionKey: false });
incidentSchema.index({ fleetId: 1, ts: -1 });
incidentSchema.index({ vehicleId: 1, ts: -1 });
incidentSchema.index({ status: 1, resolvedAt: -1 });

// Coaching sessions and maintenance checks scheduled from reports or when resolving an incident.
const followUpSchema = new Schema({
  vehicleId: { type: String, required: true },
  fleetId: { type: String, required: true },
  driver: { id: String, name: String },
  kind: { type: String, enum: ['coaching', 'maintenance'], required: true },
  reason: String,
  incidentId: String,
  due: Date,
  status: { type: String, enum: ['open', 'done'], default: 'open', index: true },
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
  doneBy: String,
  doneAt: Date,
}, { versionKey: false });
followUpSchema.index({ fleetId: 1, status: 1, due: 1 });

// Per-fleet, per-minute aggregates written by the pipeline; analytics read these instead of
// scanning raw telemetry.
const rollupSchema = new Schema({
  fleetId: { type: String, required: true },
  bucket: { type: Date, required: true },
  events: Number, speedSum: Number, speedMax: Number, km: Number, vehicles: Number,
}, { versionKey: false });
rollupSchema.index({ fleetId: 1, bucket: 1 }, { unique: true });

export const User = model('User', userSchema);
export const Vehicle = model('Vehicle', vehicleSchema);
export const Incident = model('Incident', incidentSchema);
export const FollowUp = model('FollowUp', followUpSchema);
export const Rollup = model('Rollup', rollupSchema);
