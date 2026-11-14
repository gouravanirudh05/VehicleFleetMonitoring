#!/usr/bin/env node
// Load test: starts the simulator at a chosen fleet size, opens many dashboard sockets that
// subscribe to every fleet, and measures what they receive. Prints a markdown table and
// writes stress-results.json at the repo root.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SIM_URL || 'http://localhost:4000' },
    clients: { type: 'string', default: '50' },
    vehicles: { type: 'string', default: '2000' },
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '10' },
    user: { type: 'string', default: 'admin' },
    password: { type: 'string', default: 'admin123' },
    'no-sim': { type: 'boolean', default: false },
    'sim-batch-ms': { type: 'string', default: '250' },
  },
});
const C = Number(args.clients);
const V = Number(args.vehicles);
const DURATION = Number(args.duration);
const WARMUP = Number(args.warmup);

const login = await fetch(new URL('/api/auth/login', args.url), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: args.user, password: args.password }),
});
if (!login.ok) { console.error('login failed', login.status, await login.text()); process.exit(1); }
const { token, user } = await login.json();

let sim = null;
if (!args['no-sim']) {
  sim = spawn(process.execPath, [path.join(here, 'index.js'), '--vehicles', String(V), '--batch-ms', args['sim-batch-ms'], '--quiet', '--url', args.url], { stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`[stress] simulator started with ${V} vehicles`);
}

const latencies = [];
let messages = 0; let deltas = 0; let bytes = 0; let connected = 0; let snapshots = 0;
let measuring = false;
const sockets = [];

for (let i = 0; i < C; i++) {
  const s = io(args.url, { auth: { token }, transports: ['websocket'], reconnection: true });
  s.on('connect', () => {
    connected++;
    s.emit('subscribe', { fleets: user.fleets }, () => {});
  });
  s.on('disconnect', () => { connected--; });
  s.on('fleet:snapshot', () => { snapshots++; });
  s.on('fleet:batch', (msg) => {
    if (!measuring) return;
    const now = Date.now();
    messages++;
    deltas += msg.d.length;
    bytes += JSON.stringify(msg).length;
    // Sample a few per message: event timestamp (device clock) to arrival at this client.
    for (let k = 0; k < msg.d.length; k += 25) latencies.push(now - msg.d[k][2]);
  });
  sockets.push(s);
}

const metricsAt = async () => {
  const r = await fetch(new URL('/api/metrics', args.url), { headers: { authorization: `Bearer ${token}` } });
  return r.json();
};

console.log(`[stress] ${C} dashboard clients connecting, warming up ${WARMUP} s`);
await new Promise((r) => setTimeout(r, WARMUP * 1000));
const before = await metricsAt();
measuring = true;
const t0 = Date.now();
console.log(`[stress] measuring for ${DURATION} s with ${connected} clients connected`);
const peaks = { eventLoopP99Ms: 0, rssMb: 0, p95: 0 };
const poll = setInterval(async () => {
  const m = await metricsAt();
  peaks.eventLoopP99Ms = Math.max(peaks.eventLoopP99Ms, m.eventLoopP99Ms);
  peaks.rssMb = Math.max(peaks.rssMb, m.rssMb);
  peaks.p95 = Math.max(peaks.p95, m.latency.p95);
}, 2000);
await new Promise((r) => setTimeout(r, DURATION * 1000));
measuring = false;
clearInterval(poll);
const secs = (Date.now() - t0) / 1000;
const after = await metricsAt();

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const diff = (k) => after.total[k] - before.total[k];
const result = {
  date: new Date().toISOString(),
  vehicles: V,
  clients: C,
  simBatchMs: Number(args['sim-batch-ms']),
  connectedAtEnd: connected,
  seconds: Math.round(secs),
  ingestedPerSec: Math.round(diff('received') / secs),
  acceptedPerSec: Math.round(diff('accepted') / secs),
  acceptedTotal: diff('accepted'),
  duplicatesDropped: diff('duplicate'),
  lateDropped: diff('late'),
  invalid: diff('invalid'),
  rateLimited: diff('rateLimited'),
  overloaded: diff('overloaded'),
  written: diff('written'),
  writeErrors: diff('writeErrors'),
  alerts: diff('alerts'),
  slowSocketResyncs: diff('slowSocketResyncs'),
  messagesPerClientPerSec: Math.round((messages / C / secs) * 10) / 10,
  vehicleUpdatesPerSecAllClients: Math.round(deltas / secs),
  kbPerClientPerSec: Math.round((bytes / C / secs / 1024) * 10) / 10,
  latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), samples: latencies.length },
  server: { eventLoopP99MsPeak: peaks.eventLoopP99Ms, rssMbPeak: peaks.rssMb, flushMsLast: after.flush.lastMs },
};

console.log(`
| Measure | Result |
| --- | --- |
| Simulated vehicles at 1 Hz | ${V.toLocaleString('en-US')} |
| Dashboard sockets connected | ${result.connectedAtEnd} of ${C} |
| Events ingested / accepted per second | ${result.ingestedPerSec.toLocaleString('en-US')} / ${result.acceptedPerSec.toLocaleString('en-US')} |
| Events written to MongoDB | ${result.written.toLocaleString('en-US')} (${result.writeErrors} write errors) |
| Duplicates / late events dropped | ${result.duplicatesDropped} / ${result.lateDropped} |
| Event to dashboard latency p50 / p95 / p99 | ${result.latencyMs.p50} / ${result.latencyMs.p95} / ${result.latencyMs.p99} ms |
| Batches per client per second | ${result.messagesPerClientPerSec} |
| Payload per client | ${result.kbPerClientPerSec} KB/s |
| Server event loop p99 (peak) | ${result.server.eventLoopP99MsPeak} ms |
| Server memory (peak RSS) | ${result.server.rssMbPeak} MB |
| Alerts raised | ${result.alerts} |
`);

const out = path.join(here, '..', 'stress-results.json');
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`[stress] wrote ${out}`);
for (const s of sockets) s.close();
if (sim) sim.kill('SIGINT');
process.exit(0);
