import { COMMANDS, EARLY_WARNING, OUTCOMES, SUGGESTED_COMMAND, driverFor } from '../../../shared/people.js';

export const FLEET_COLORS = { 'north-depot': '#EE8640', 'airport-shuttle': '#2A211B', 'city-logistics': '#5D6C7B' };

export const STATUS_LABEL = { moving: 'Moving', idle: 'Idle', stopped: 'Engine off', offline: 'Offline' };

export const RULE_LABEL = {
  overspeed: 'Overspeed', harshBraking: 'Harsh braking', longIdle: 'Long idle',
  geofenceExit: 'Left area', overheat: 'Engine overheat', noSignal: 'Not reporting',
  overheatForecast: 'Overheat forecast', engineAnomaly: 'Unusual engine temperature', fuelDrop: 'Unexplained fuel loss',
};

export const isEarlyWarning = (rule) => EARLY_WARNING.includes(rule);

export const STATUS_TEXT = { active: 'Happening now', cleared: 'Stopped, needs review', resolved: 'Resolved' };

// Instruction and outcome wording is shared with the server so the two can never disagree.
export const COMMAND_LABEL = Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.label]));
export const OUTCOME_LABEL = OUTCOMES;
export const SUGGESTED = SUGGESTED_COMMAND;
export { driverFor };

export function duration(sec) {
  if (sec == null) return '–';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const n0 = (v) => (v == null || Number.isNaN(v) ? '–' : nf0.format(v));
export const n1 = (v) => (v == null || Number.isNaN(v) ? '–' : nf1.format(v));

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const clock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function bytes(n) {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
