/**
 * Plain-language health checks for the System health page. Each check is ok, warn or fail,
 * with a one-line detail and, when not ok, what to do about it.
 */
export function computeHealth({ metrics, pipeline, config, dbConnected }) {
  const recent = metrics.series.slice(-10);
  const sum = (k) => recent.reduce((s, p) => s + (p[k] || 0), 0);
  const received = sum('received');
  const dropped = sum('dropped');
  const known = pipeline.states.size;
  let offline = 0;
  for (const s of pipeline.states.values()) if (s.status === 'offline') offline++;
  const p95 = metrics.latency.p95;
  const pending = metrics.flush.pending;
  const writeErrorAgo = metrics.lastWriteErrorAt ? Date.now() - metrics.lastWriteErrorAt : Infinity;

  const checks = [];
  const add = (id, label, status, detail, action = null) => checks.push({ id, label, status, detail, action });

  add('database', 'Database', dbConnected ? 'ok' : 'fail',
    dbConnected ? 'Connected' : 'Not connected',
    dbConnected ? null : 'Check that MongoDB is running and MONGO_URI is correct.');

  if (!known) add('intake', 'Vehicle data', 'warn', 'No vehicles have registered yet', 'Start the vehicle gateway or simulator.');
  else if (!received) add('intake', 'Vehicle data', 'fail', 'Nothing received in the last 10 s', 'Check the vehicle gateway and its device key.');
  else add('intake', 'Vehicle data', 'ok', `${Math.round(received / Math.max(1, recent.length))} readings per second`);

  const dropShare = received ? dropped / received : 0;
  add('quality', 'Data quality', dropShare > 0.2 ? 'fail' : dropShare > 0.05 ? 'warn' : 'ok',
    `${(dropShare * 100).toFixed(1)}% of readings rejected or duplicate in the last 10 s`,
    dropShare > 0.05 ? 'See "Rejected readings" below for the reason.' : null);

  add('delivery', 'Delivery to screens', p95 > 3000 ? 'fail' : p95 > 1000 ? 'warn' : 'ok',
    `95% of updates on screen within ${Math.round(p95)} ms`,
    p95 > 1000 ? 'The server is under load; check CPU and the event-loop delay below.' : null);

  const bufferShare = pending / config.maxPendingWrites;
  add('storage', 'Storage', writeErrorAgo < 60_000 ? 'fail' : bufferShare > 0.5 ? 'warn' : 'ok',
    writeErrorAgo < 60_000 ? 'Writes to the database failed in the last minute' : `${pending.toLocaleString('en-US')} readings waiting to be saved`,
    writeErrorAgo < 60_000 ? 'Check database disk space and connectivity.' : bufferShare > 0.5 ? 'The database is slower than incoming data.' : null);

  const offShare = known ? offline / known : 0;
  add('coverage', 'Vehicles reporting', offShare > 0.25 ? 'fail' : offShare > 0.05 ? 'warn' : 'ok',
    `${known - offline} of ${known} vehicles reported in the last 30 s`,
    offShare > 0.05 ? 'Open the Control room and filter vehicles by "Offline".' : null);

  const ml = pipeline.ml.stats();
  const stuck = ml.vehicles > 0 && ml.trained === 0 && Date.now() - metrics.startedAt > 10 * 60_000;
  add('models', 'Early-warning models', stuck ? 'warn' : 'ok',
    ml.vehicles ? `${ml.trained} of ${ml.vehicles} vehicles have learned their normal engine and fuel behaviour` : 'Waiting for vehicle data',
    stuck ? 'Vehicles need about 3 minutes of normal driving before their model is trusted.' : null);

  const status = checks.some((c) => c.status === 'fail') ? 'down' : checks.some((c) => c.status === 'warn') ? 'degraded' : 'ok';
  return { status, checks };
}
