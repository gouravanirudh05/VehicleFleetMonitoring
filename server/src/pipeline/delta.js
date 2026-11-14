// Compact wire format for fleet broadcasts. Each vehicle state is sent with short keys, and
// after the first send only the keys whose value moved by more than `eps` are included.

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r1 = (v) => Math.round(v * 10) / 10;
const r0 = (v) => Math.round(v);

export const FIELDS = [
  // [state key, wire key, epsilon, rounding]
  ['lat', 'la', 1e-5, r5],
  ['lng', 'ln', 1e-5, r5],
  ['speedKmh', 'sp', 0.5, r1],
  ['fuelPct', 'fu', 0.5, r1],
  ['engineC', 'en', 0.5, r0],
  ['heading', 'hd', 2, r0],
  ['status', 'st', null, (v) => v],
];

/** All fields of a state, in wire form. */
export function encodeFull(s) {
  const o = {};
  for (const [k, w, , round] of FIELDS) if (s[k] != null) o[w] = round(s[k]);
  return o;
}

/**
 * The wire fields that differ between `prev` (wire form, or undefined) and state `s`.
 * Returns null when nothing moved enough to be worth sending.
 */
export function encodeDelta(prev, s) {
  if (!prev) return encodeFull(s);
  let o = null;
  for (const [k, w, eps, round] of FIELDS) {
    if (s[k] == null) continue;
    const v = round(s[k]);
    const p = prev[w];
    const moved = eps == null ? v !== p : p == null || Math.abs(v - p) >= eps;
    if (moved) (o ??= {})[w] = v;
  }
  return o;
}

/** Applies a wire delta onto a wire-form object (used by clients and by tests). */
export function applyDelta(target, delta) {
  return Object.assign(target, delta);
}
