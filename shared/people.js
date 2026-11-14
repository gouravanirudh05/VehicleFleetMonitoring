// Drivers assigned to vehicles. Deterministic from the vehicle id so the server, simulator and
// dashboard agree without a shared database. Names are generated, not real people.

const FIRST = ['Arjun', 'Ravi', 'Suresh', 'Imran', 'Prakash', 'Manjunath', 'Kiran', 'Naveen', 'Farhan', 'Vijay',
  'Ganesh', 'Rahul', 'Sandeep', 'Anil', 'Mohan', 'Deepak', 'Lokesh', 'Harish', 'Shivu', 'Abdul',
  'Kavya', 'Lakshmi', 'Divya', 'Ramesh', 'Santosh', 'Venkatesh', 'Ashok', 'Nagaraj', 'Joseph', 'Pradeep'];
const LAST = ['Gowda', 'Reddy', 'Shetty', 'Khan', 'Rao', 'Naik', 'Kumar', 'Hegde', 'Patil', 'Iyer',
  'Nair', 'Pillai', 'Sharma', 'Das', 'Fernandes', 'Murthy', 'Prasad', 'Bhat', 'Kamath', 'Singh'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function driverFor(vehicleId) {
  const h = hash(vehicleId);
  return {
    id: `DRV-${String(h % 9000 + 1000)}`,
    name: `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`,
  };
}

/** Instructions a dispatcher can send to a driver's in-cab tablet. */
export const COMMANDS = {
  slowDown: { label: 'Slow down', text: 'Reduce your speed to the limit now.' },
  returnToRoute: { label: 'Return to route', text: 'You are outside your area. Return to your assigned route.' },
  pullOver: { label: 'Pull over and switch off', text: 'Pull over safely and switch off the engine. Wait for instructions.' },
  resumeTrip: { label: 'Resume trip', text: 'You have been stopped a long time. Resume your trip or call control.' },
  callControl: { label: 'Call control room', text: 'Call the control room when it is safe to do so.' },
};

/** The instruction offered first for each kind of incident. */
export const SUGGESTED_COMMAND = {
  overspeed: 'slowDown',
  harshBraking: 'callControl',
  longIdle: 'resumeTrip',
  geofenceExit: 'returnToRoute',
  overheat: 'pullOver',
  noSignal: null,
  overheatForecast: 'pullOver',
  engineAnomaly: 'callControl',
  fuelDrop: 'callControl',
};

/** Incidents raised by the learned per-vehicle models rather than fixed thresholds. */
export const EARLY_WARNING = ['overheatForecast', 'engineAnomaly', 'fuelDrop'];

export const OUTCOMES = {
  driverCorrected: 'Driver corrected it',
  assistanceSent: 'Assistance sent',
  falseAlarm: 'False alarm',
  escalated: 'Escalated to fleet manager',
  clearedOnItsOwn: 'Cleared on its own',
  other: 'Other',
};
