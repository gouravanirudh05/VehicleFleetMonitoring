import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' ? v : def;
};

export const config = {
  port: num('PORT', 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/fleetwake',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret',
  deviceApiKey: process.env.DEVICE_API_KEY || 'dev-device-key',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  broadcastMs: num('BROADCAST_MS', 250),
  flushMs: num('FLUSH_MS', 1000),
  maxPendingWrites: num('MAX_PENDING_WRITES', 100000),
  deviceRatePerSec: num('DEVICE_RATE_PER_SEC', 5),
  deviceBurst: num('DEVICE_BURST', 20),
  idleAlertSec: num('IDLE_ALERT_SEC', 900),
  telemetryTtlDays: num('TELEMETRY_TTL_DAYS', 7),
  offlineAfterMs: 30000,
  maxBatchEvents: 1000,
  slowSocketBuffer: 16,
  landingDir: path.join(ROOT, 'landing'),
  clientDist: path.join(ROOT, 'client', 'dist'),
};
