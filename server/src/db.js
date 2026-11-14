import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from './models/index.js';

export const TELEMETRY = 'telemetry';

export async function connect(config) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  await ensureTelemetryCollection(config);
  return mongoose.connection;
}

/**
 * Raw telemetry lives in a MongoDB time-series collection (time field `ts`, meta field
 * `meta` = { vehicleId, fleetId }) with a TTL, which keeps storage compact and range scans fast.
 */
async function ensureTelemetryCollection(config) {
  const db = mongoose.connection.db;
  const exists = await db.listCollections({ name: TELEMETRY }).hasNext();
  if (!exists) {
    await db.createCollection(TELEMETRY, {
      timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
      expireAfterSeconds: Math.round(config.telemetryTtlDays * 86400),
    });
  }
  await db.collection(TELEMETRY).createIndex({ 'meta.vehicleId': 1, ts: 1 });
}

export const telemetry = () => mongoose.connection.db.collection(TELEMETRY);

const DEMO_USERS = [
  { username: 'admin', password: 'admin123', role: 'admin', fleets: [] },
  { username: 'north', password: 'north123', role: 'dispatcher', fleets: ['north-depot'] },
  { username: 'airport', password: 'airport123', role: 'dispatcher', fleets: ['airport-shuttle'] },
];

/** Creates the demo accounts on first run only. */
export async function seedUsers() {
  if (await User.estimatedDocumentCount()) return false;
  for (const u of DEMO_USERS) {
    await User.create({ username: u.username, passwordHash: await bcrypt.hash(u.password, 10), role: u.role, fleets: u.fleets });
  }
  return true;
}
