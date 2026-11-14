import { z } from 'zod';
import { FLEET_IDS } from '../../../shared/geo.js';

export const VEHICLE_ID = /^[A-Z0-9][A-Z0-9-]{3,19}$/;
const MAX_FUTURE_MS = 60_000;
const MAX_AGE_MS = 24 * 3600_000;

// ts may be epoch milliseconds or an ISO-8601 string; it is normalised to epoch ms.
const timestamp = z
  .union([z.number().int().positive(), z.string().datetime({ offset: true })])
  .transform((v) => (typeof v === 'number' ? v : Date.parse(v)));

export const telemetryEvent = z
  .object({
    vehicleId: z.string().regex(VEHICLE_ID, 'vehicleId must be 4-20 chars of A-Z, 0-9 and -'),
    seq: z.number().int().nonnegative(),
    ts: timestamp,
    type: z.literal('position').default('position'),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedKmh: z.number().min(0).max(300),
    fuelPct: z.number().min(0).max(100),
    engineC: z.number().min(-40).max(200),
    heading: z.number().min(0).max(360).optional(),
    engineOn: z.boolean().default(true),
  })
  .strict();

export const deviceRegistration = z.object({
  vehicleId: z.string().regex(VEHICLE_ID),
  fleetId: z.enum(FLEET_IDS),
  kind: z.enum(['truck', 'van', 'bus', 'suv', 'sedan', 'bike']),
});

/**
 * Validates one raw event. Returns { ok: true, event } or { ok: false, error }.
 * Timestamps too far in the future or older than 24 h are rejected so a bad device clock
 * cannot poison ordering.
 */
export function validateEvent(raw, now = Date.now()) {
  const r = telemetryEvent.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, error: `${issue.path.join('.') || 'event'}: ${issue.message}` };
  }
  const e = r.data;
  if (e.ts > now + MAX_FUTURE_MS) return { ok: false, error: 'ts: more than 60 s in the future' };
  if (e.ts < now - MAX_AGE_MS) return { ok: false, error: 'ts: older than 24 h' };
  return { ok: true, event: e };
}
