import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { connect, seedUsers } from './db.js';
import { Vehicle, Incident } from './models/index.js';
import { Metrics } from './pipeline/metrics.js';
import { Pipeline } from './pipeline/pipeline.js';
import { startWriter } from './pipeline/writer.js';
import { startRealtime } from './realtime/socket.js';
import { apiRouter } from './routes/api.js';

async function main() {
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

  httpServer.listen(config.port, () => console.log(`[http] Fleetwake on http://localhost:${config.port}`));

  const shutdown = async () => {
    console.log('\n[http] shutting down, flushing buffers');
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
