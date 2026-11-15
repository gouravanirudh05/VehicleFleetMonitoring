import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config, ROOT } from './config.js';
import { connect, seedUsers } from './db.js';
import { Vehicle, Incident } from './models/index.js';
import { Metrics } from './pipeline/metrics.js';
import { Pipeline } from './pipeline/pipeline.js';
import { startWriter } from './pipeline/writer.js';
import { startRealtime } from './realtime/socket.js';
import { apiRouter } from './routes/api.js';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    const weak = [];
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) weak.push('JWT_SECRET (32+ random characters)');
    if (!process.env.DEVICE_API_KEY || process.env.DEVICE_API_KEY === 'dev-device-key') weak.push('DEVICE_API_KEY');
    if (weak.length) throw new Error(`Refusing to start in production without ${weak.join(' and ')}`);
  }
  await connect(config);
  if (await seedUsers()) console.log('[db] created demo users admin, north, airport');

  const metrics = new Metrics();
  const pipeline = new Pipeline({ config, metrics });
  pipeline.hydrate(await Vehicle.find().lean());
  pipeline.incidents.hydrate(await Incident.find({ status: { $ne: 'resolved' } }).lean());
  console.log(`[db] restored ${pipeline.registry.size} vehicles and ${pipeline.incidents.open.size} open incidents`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // CSP is off because the landing page uses an inline script and CDN-hosted Three.js.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use('/api', cors({ origin: config.corsOrigins }));

  const httpServer = http.createServer(app);
  const realtime = startRealtime({ httpServer, pipeline, metrics, config, corsOrigins: config.corsOrigins });
  const writer = startWriter({ pipeline, metrics, config });

  app.use('/api', apiRouter({ pipeline, metrics, config, realtime }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Production: the built React dashboard under /dashboard, the landing page at /.
  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use('/dashboard', express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get(/^\/dashboard(\/.*)?$/, (req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }
  app.use(express.static(config.landingDir));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  // Optional built-in fleet for single-service demos (e.g. one Render web service):
  // SIMULATE_VEHICLES=300 starts the simulator as a child process pointed at this server.
  let sim = null;
  httpServer.listen(config.port, () => {
    console.log(`[http] Fleetwake on http://localhost:${config.port}`);
    const n = Number(process.env.SIMULATE_VEHICLES);
    if (n > 0) {
      sim = spawn(process.execPath, [path.join(ROOT, 'simulator', 'index.js'),
        '--url', `http://127.0.0.1:${config.port}`, '--vehicles', String(n), '--key', config.deviceApiKey, '--quiet',
        ...(process.env.SIMULATE_ANOMALY ? ['--anomaly', process.env.SIMULATE_ANOMALY] : [])],
      { stdio: 'inherit' });
      sim.on('exit', (code) => { if (code) console.error(`[sim] built-in simulator exited with code ${code}`); });
      console.log(`[sim] built-in simulator started with ${n} vehicles`);
    }
  });

  const shutdown = async () => {
    console.log('\n[http] shutting down, flushing buffers');
    sim?.kill('SIGTERM');
    realtime.stop();
    writer.stop();
    await writer.flush(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[boot] failed:', err.message);
  if (/ECONNREFUSED|Server selection/i.test(err.message)) console.error('[boot] Is MongoDB running? Check MONGO_URI in .env');
  process.exit(1);
});
