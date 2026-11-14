/**
 * Early-warning models. Each vehicle gets its own small online model that learns from its own
 * readings, so "unusual" means unusual for that truck, not for the fleet. Three detectors:
 *
 *  overheatForecast  linear trend over the last 90 s of the heat that speed does not explain
 *                    (reading minus the learned baseline); warns when the engine will reach
 *                    105 °C within 10 min, before the fixed rule can fire. Speeding up
 *                    legitimately warms an engine, so it is not trended.
 *  engineAnomaly     learned baseline engineC ≈ a + b·load (exponentially weighted least
 *                    squares), where load is speed smoothed over the engine's ~50 s thermal
 *                    response; flags a sustained residual far outside the vehicle's own spread,
 *                    e.g. a slow coolant leak that never reaches the fixed 105 °C threshold.
 *  fuelDrop          learned fuel use per km; flags a fuel drop the distance driven doesn't
 *                    explain (siphoning while parked, a leak).
 *
 * Readings judged anomalous are not learned from, so a fault can't become the new normal.
 * Pure computation, no I/O: the pipeline feeds readings in and turns the output into incidents.
 */

const OVERHEAT_C = 105;
const HALF_LIFE = 1800;                    // samples (~30 min at 1 Hz) for the baseline to forget
const DECAY = Math.pow(0.5, 1 / HALF_LIFE);
const RESID_ALPHA = 0.01;                  // EWMA rate for the residual variance
const LEARN_Z = 2;                         // readings further out than this are not learned from
const LOAD_TAU_S = 50;                     // engine temperature follows load with about this lag
const FUEL_BOOTSTRAP = 5;                  // fuel-use samples learned unconditionally at first
const FUEL_MIN_SAMPLES = 3;                // before judging fuel use while driving
const SETTLE = 150;                        // readings ignored at start while the engine settles
const MIN_LOAD_VAR = 25;                   // (km/h)²: needs varied speeds to learn heat vs speed
export const WARMUP = 180;                 // settled samples before a baseline is trusted (~3 min)

const TREND_WINDOW_MS = 90_000;
const TREND_MIN_SPAN_MS = 20_000;
const TREND_MIN_SLOPE = 0.05;              // °C per second (3 °C/min)
const TREND_MIN_R2 = 0.7;
const FORECAST_HORIZON_MIN = 10;

const ANOMALY_Z = 4;
const ANOMALY_MIN_C = 5;                   // also at least this many °C off, so tiny variances can't trip it
const ANOMALY_HOLD_MS = 30_000;
const ANOMALY_CLEAR_Z = 2;

const FUEL_WINDOW_MS = 150_000;
const FUEL_MIN_SPAN_MS = 60_000;
const FUEL_MIN_EXCESS = 3;                 // % of tank beyond what the distance explains
const FUEL_REARM_MS = 10 * 60_000;

function linearFit(points) {
  const n = points.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0;
  const t0 = points[0].t;
  for (const p of points) {
    const x = (p.t - t0) / 1000;
    sx += x; sy += p.y; sxx += x * x; sxy += x * p.y; syy += p.y * p.y;
  }
  const dx = n * sxx - sx * sx;
  if (dx <= 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / dx;
  const dy = n * syy - sy * sy;
  const r2 = dy > 0 ? ((n * sxy - sx * sy) ** 2) / (dx * dy) : 0;
  return { slope, r2 };
}

export class VehicleModel {
  constructor(saved = null) {
    // Weighted sufficient statistics for engineC ~ a + b·speed.
    this.w = 0; this.sx = 0; this.sy = 0; this.sxx = 0; this.sxy = 0;
    this.rVar = 1; this.n = 0; this.seen = 0;
    this.fuelPerKm = null; this.fuelSamples = 0;
    if (saved) Object.assign(this, saved);
    this.temps = [];        // { t, y } for the trend
    this.fuel = [];         // { t, fuel, km } for fuel accounting
    this.odo = 0;           // km since this model started watching
    this.forecastFired = false;
    this.anomSince = null; this.anomFired = false; this.normalSince = null;
    this.fuelFiredAt = -Infinity;
    this.lastFuelLearn = null;
    this.load = null; this.lastTs = null;
  }

  export() {
    const { w, sx, sy, sxx, sxy, rVar, n, seen, fuelPerKm, fuelSamples } = this;
    return { w, sx, sy, sxx, sxy, rVar, n, seen, fuelPerKm, fuelSamples };
  }

  /**
   * Trusted to judge engine temperature: enough settled readings, at a spread of speeds wide
   * enough to tell how heat depends on speed. A vehicle that has only cruised at one speed is
   * still learning, because its first stop or pull-away would otherwise look abnormal.
   */
  get trained() {
    if (this.n < WARMUP || this.w < 1) return false;
    const m = this.sx / this.w;
    return this.sxx / this.w - m * m >= MIN_LOAD_VAR;
  }

  /** Trusted to judge fuel: past start-up settling and warm-up; fuel use is learned separately. */
  get fuelReady() { return this.seen >= SETTLE + WARMUP; }

  /** Expected engine temperature at a given speed, or null while learning. */
  expectedEngine(speed) {
    if (this.w < 1) return null;
    const mx = this.sx / this.w;
    const my = this.sy / this.w;
    const vx = this.sxx / this.w - mx * mx;
    const b = vx > 1 ? (this.sxy / this.w - mx * my) / vx : 0;
    return my + b * (speed - mx);
  }

  #learnEngine(speed, engine) {
    this.w = this.w * DECAY + 1;
    this.sx = this.sx * DECAY + speed;
    this.sy = this.sy * DECAY + engine;
    this.sxx = this.sxx * DECAY + speed * speed;
    this.sxy = this.sxy * DECAY + speed * engine;
  }

  /**
   * One accepted reading. `km` is the distance since the previous one. Returns the same shape
   * as the rules engine: { fired: [alert], cleared: [rule] }.
   */
  observe(e, km) {
    const fired = [];
    const cleared = [];
    const readings = { lat: e.lat, lng: e.lng, speedKmh: e.speedKmh, fuelPct: e.fuelPct, engineC: e.engineC };
    const fire = (rule, severity, message, value, threshold) => fired.push({ rule, severity, message, value, threshold, ts: e.ts, seq: e.seq, readings, source: 'model' });
    this.odo += km;

    /* ---- engine baseline and residual ---- */
    // Engine temperature follows load with a lag, so the baseline uses speed smoothed over the
    // engine's thermal response. With raw speed, every stop (expected drops at once, the engine
    // cools over a minute) would look like the engine running hot.
    const dt = this.lastTs == null ? 1 : Math.max(0, (e.ts - this.lastTs) / 1000);
    this.lastTs = e.ts;
    this.load = this.load == null ? e.speedKmh : this.load + (e.speedKmh - this.load) * (1 - Math.exp(-dt / LOAD_TAU_S));
    const load = this.load;

    // The baseline includes an intercept, so residuals are centred on zero by construction.
    // Scoring against zero (not a running mean) keeps a slow drift from becoming "normal".
    const expected = this.expectedEngine(load);
    const resid = expected == null ? 0 : e.engineC - expected;
    const sd = Math.sqrt(Math.max(this.rVar, 0.25));
    const z = resid / sd;
    // Learn only from readings well inside the normal band. Admitting anything closer to the
    // edge lets a slow drift widen "normal" one step at a time until a fault looks routine.
    this.seen++;
    const settled = this.seen > SETTLE;
    const learnable = settled && (!this.trained || Math.abs(z) < LEARN_Z);
    if (learnable) {
      this.#learnEngine(load, e.engineC);
      if (expected != null) this.rVar = (1 - RESID_ALPHA) * this.rVar + RESID_ALPHA * resid * resid;
      this.n++;
    }

    /* ---- overheat forecast ---- */
    // Trend the heat that speed does not explain. Nothing is forecast during warm-up: a cold
    // engine settling to its normal temperature looks just like a climb.
    this.temps.push({ t: e.ts, y: resid });
    while (this.temps.length && e.ts - this.temps[0].t > TREND_WINDOW_MS) this.temps.shift();
    const span = this.temps.length > 1 ? e.ts - this.temps[0].t : 0;
    if (this.trained && span >= TREND_MIN_SPAN_MS && this.temps.length >= 12) {
      const { slope, r2 } = linearFit(this.temps);
      // Only when already hotter than normal: an engine catching up after pulling away from a
      // stop also climbs, but towards normal, not past it.
      const hotter = resid > Math.max(4, 4 * sd);
      if (!this.forecastFired && hotter && e.engineC < OVERHEAT_C && slope > TREND_MIN_SLOPE && r2 > TREND_MIN_R2) {
        const minutes = (OVERHEAT_C - e.engineC) / slope / 60;
        if (minutes <= FORECAST_HORIZON_MIN) {
          this.forecastFired = true;
          fire('overheatForecast', minutes < 3 ? 'critical' : 'warning',
            `Engine ${Math.round(e.engineC)} °C and rising ${(slope * 60).toFixed(1)} °C/min: about ${Math.max(1, Math.round(minutes))} min to ${OVERHEAT_C} °C`,
            Math.round(minutes * 10) / 10, FORECAST_HORIZON_MIN);
        }
      } else if (this.forecastFired && (slope < 0.005 || e.engineC >= OVERHEAT_C)) {
        this.forecastFired = false;
        cleared.push('overheatForecast');
      }
    }

    /* ---- unusual engine temperature for this vehicle ---- */
    if (this.trained && expected != null) {
      const off = z > ANOMALY_Z && resid > ANOMALY_MIN_C && e.engineC < OVERHEAT_C && !this.forecastFired;
      if (off) {
        this.anomSince ??= e.ts;
        this.normalSince = null;
        if (!this.anomFired && e.ts - this.anomSince >= ANOMALY_HOLD_MS) {
          this.anomFired = true;
          fire('engineAnomaly', 'warning',
            `Engine ${Math.round(e.engineC)} °C, ${Math.round(resid)} °C hotter than this vehicle usually runs at ${Math.round(e.speedKmh)} km/h (normal ${Math.round(expected)} °C)`,
            Math.round(resid * 10) / 10, Math.round(sd * ANOMALY_Z * 10) / 10);
        }
      } else {
        this.anomSince = null;
        if (this.anomFired && z < ANOMALY_CLEAR_Z) {
          this.normalSince ??= e.ts;
          if (e.ts - this.normalSince >= ANOMALY_HOLD_MS) {
            this.anomFired = false;
            this.normalSince = null;
            cleared.push('engineAnomaly');
          }
        }
      }
    }

    /* ---- fuel the distance doesn't explain ---- */
    const last = this.fuel[this.fuel.length - 1];
    if (last && e.fuelPct > last.fuel + 2) this.fuel = [];             // refuelled: start over
    this.fuel.push({ t: e.ts, fuel: e.fuelPct, km: this.odo });
    while (this.fuel.length && e.ts - this.fuel[0].t > FUEL_WINDOW_MS) this.fuel.shift();
    const first = this.fuel[0];
    if (first && e.ts - first.t >= FUEL_MIN_SPAN_MS) {
      const used = first.fuel - e.fuelPct;
      const dist = this.odo - first.km;
      const rate = this.fuelPerKm ?? 0;
      const expectedUse = rate * dist;
      const excess = used - expectedUse;
      // While driving, judge only once this vehicle's fuel use is known; parked, any loss counts.
      const judgeable = this.fuelReady && (this.fuelSamples >= FUEL_MIN_SAMPLES || dist < 0.05);
      if (judgeable && excess > FUEL_MIN_EXCESS && e.ts - this.fuelFiredAt > FUEL_REARM_MS) {
        this.fuelFiredAt = e.ts;
        const mins = Math.max(1, Math.round((e.ts - first.t) / 60_000));
        fire('fuelDrop', 'critical',
          `Fuel fell ${used.toFixed(1)}% in ${mins} min ${e.speedKmh < 2 ? 'while parked' : `over ${dist.toFixed(1)} km`}; the distance explains about ${expectedUse.toFixed(1)}%`,
          Math.round(excess * 10) / 10, FUEL_MIN_EXCESS);
        this.fuel = [];
      } else if (dist > 0.3 && (this.fuelSamples < FUEL_BOOTSTRAP || excess < Math.max(1, 0.3 * expectedUse))
        && (!this.lastFuelLearn || e.ts - this.lastFuelLearn >= FUEL_MIN_SPAN_MS)) {
        // Normal driving: learn this vehicle's consumption per km.
        const r = Math.max(0, used) / dist;
        this.fuelPerKm = this.fuelPerKm == null ? r : this.fuelPerKm * 0.9 + r * 0.1;
        this.fuelSamples++;
        this.lastFuelLearn = e.ts;
      }
    }

    return { fired, cleared };
  }

  /** Human-readable summary for the vehicle panel. */
  describe(speed) {
    const exp = this.expectedEngine(speed ?? 0);
    return {
      trained: this.trained,
      progress: Math.min(1, this.n / WARMUP),
      needsVariedDriving: this.n >= WARMUP && !this.trained,
      normalEngineC: exp == null ? null : Math.round(exp * 10) / 10,
      engineSpreadC: Math.round(Math.sqrt(Math.max(this.rVar, 0.25)) * 10) / 10,
      fuelPerKm: this.fuelPerKm == null ? null : Math.round(this.fuelPerKm * 1000) / 1000,
      watching: { forecast: this.forecastFired, engine: this.anomFired },
    };
  }
}

/** One model per vehicle. */
export class EarlyWarning {
  constructor() { this.models = new Map(); }

  model(vehicleId) {
    let m = this.models.get(vehicleId);
    if (!m) this.models.set(vehicleId, (m = new VehicleModel()));
    return m;
  }

  observe(vehicleId, e, km) { return this.model(vehicleId).observe(e, km); }

  restore(vehicleId, saved) { if (saved) this.models.set(vehicleId, new VehicleModel(saved)); }

  stats() {
    let trained = 0;
    for (const m of this.models.values()) if (m.trained) trained++;
    return { vehicles: this.models.size, trained };
  }
}
