import { insideGeofence, speedLimitAt, zoneAt } from '../../../shared/geo.js';

export const RULES = {
  overspeed: { label: 'Overspeed', holdSec: 10 },
  harshBraking: { label: 'Harsh braking', g: 0.4, instant: true },
  longIdle: { label: 'Long idle' },
  geofenceExit: { label: 'Left area' },
  overheat: { label: 'Engine overheat', tempC: 105, clearC: 100, holdSec: 30 },
  noSignal: { label: 'Not reporting' },
  // Raised by the per-vehicle early-warning models in ml.js, not by fixed thresholds.
  overheatForecast: { label: 'Overheat forecast', source: 'model' },
  engineAnomaly: { label: 'Unusual engine temperature', source: 'model' },
  fuelDrop: { label: 'Unexplained fuel loss', source: 'model', instant: true },
};

const G = 9.80665;

/**
 * Runs every rule against one accepted event. `rs` is the vehicle's mutable rule state.
 * Returns { fired, cleared }: rules that tripped on this event, and rules whose condition
 * ended (a fired episode that is now back to normal). Each rule fires once per episode.
 */
export function evaluateRules(rs, e, fleetId, { idleAlertSec }) {
  const fired = [];
  const cleared = [];
  const readings = { lat: e.lat, lng: e.lng, speedKmh: e.speedKmh, fuelPct: e.fuelPct, engineC: e.engineC };
  const fire = (rule, severity, message, value, threshold) =>
    fired.push({ rule, severity, message, value, threshold, ts: e.ts, seq: e.seq, readings });

  // Overspeed: above the zone limit continuously for holdSec.
  const limit = speedLimitAt(e.lat, e.lng);
  if (e.speedKmh > limit) {
    rs.overSince ??= e.ts;
    const held = (e.ts - rs.overSince) / 1000;
    if (!rs.overFired && held >= RULES.overspeed.holdSec) {
      rs.overFired = true;
      const zone = zoneAt(e.lat, e.lng);
      fire('overspeed', e.speedKmh > limit + 30 ? 'critical' : 'warning',
        `${Math.round(e.speedKmh)} km/h in a ${limit} km/h zone for ${Math.round(held)} s${zone ? `, ${zone.name}` : ''}`,
        Math.round(e.speedKmh * 10) / 10, limit);
    }
  } else {
    if (rs.overFired) cleared.push('overspeed');
    rs.overSince = null; rs.overFired = false;
  }

  // Harsh braking: deceleration beyond 0.4 g between consecutive readings. Instantaneous.
  if (rs.lastTs != null && e.ts > rs.lastTs && e.ts - rs.lastTs <= 3000) {
    const dt = (e.ts - rs.lastTs) / 1000;
    const decelG = ((rs.lastSpeed - e.speedKmh) / 3.6 / dt) / G;
    if (decelG > RULES.harshBraking.g) {
      fire('harshBraking', 'warning',
        `Slowed from ${Math.round(rs.lastSpeed)} to ${Math.round(e.speedKmh)} km/h in ${dt.toFixed(1)} s (${decelG.toFixed(2)} g)`,
        Math.round(decelG * 100) / 100, RULES.harshBraking.g);
    }
  }

  // Long idle: engine on, stationary for idleAlertSec.
  if (e.engineOn && e.speedKmh < 2) {
    rs.idleSince ??= e.ts;
    const idle = (e.ts - rs.idleSince) / 1000;
    if (!rs.idleFired && idle >= idleAlertSec) {
      rs.idleFired = true;
      fire('longIdle', 'info', `Engine on and stationary for ${Math.round(idle / 60)} min`, Math.round(idle), idleAlertSec);
    }
  } else {
    if (rs.idleFired) cleared.push('longIdle');
    rs.idleSince = null; rs.idleFired = false;
  }

  // Left area: fires on the transition from inside to outside the fleet's operating area.
  const inside = insideGeofence(fleetId, e.lat, e.lng);
  if (rs.inside === true && !inside) {
    rs.outFired = true;
    fire('geofenceExit', 'critical', 'Left its operating area', null, null);
  } else if (inside && rs.outFired) {
    rs.outFired = false;
    cleared.push('geofenceExit');
  }
  rs.inside = inside;

  // Engine overheat: at or above tempC for holdSec; clears below clearC (hysteresis).
  if (e.engineC >= RULES.overheat.tempC) {
    rs.hotSince ??= e.ts;
    const held = (e.ts - rs.hotSince) / 1000;
    if (!rs.hotFired && held >= RULES.overheat.holdSec) {
      rs.hotFired = true;
      fire('overheat', 'critical', `Engine at ${Math.round(e.engineC)} °C for ${Math.round(held)} s`, Math.round(e.engineC), RULES.overheat.tempC);
    }
  } else if (!rs.hotFired) {
    rs.hotSince = null;
  } else if (e.engineC < RULES.overheat.clearC) {
    cleared.push('overheat');
    rs.hotSince = null; rs.hotFired = false;
  }

  rs.lastTs = e.ts;
  rs.lastSpeed = e.speedKmh;
  return { fired, cleared };
}
