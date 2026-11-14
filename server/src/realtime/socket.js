import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { computeHealth } from '../pipeline/health.js';
import { verifyToken, canSeeFleet } from '../auth.js';
import { serializeIncident } from '../pipeline/incidents.js';

const fleetRoom = (id) => `fleet:${id}`;
const vehicleRoom = (id) => `vehicle:${id}`;

/**
 * Socket.IO layer. Dashboards authenticate with their JWT, then:
 *   subscribe { fleets }   -> joins `fleet:<id>` rooms, ack carries a full snapshot
 *   watch { vehicleId }    -> joins `vehicle:<id>` for every raw event of one vehicle
 *   unwatch { vehicleId }
 * Server events:
 *   fleet:batch     { t, f, d: [[vehicleId, seq, ts, changedFields]] }  every BROADCAST_MS per room
 *   fleet:snapshot  { t, d: [...] }                                      after a slow-socket resync
 *   vehicle:events  { id, e: [[seq, ts, lat, lng, speed, fuel, engine]] }
 *   incidents       [incident]  incidents of that fleet that changed, every BROADCAST_MS
 *   metrics
 */
export function startRealtime({ httpServer, pipeline, metrics, config, corsOrigins, log = console }) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
    perMessageDeflate: { threshold: 4096 },
    pingInterval: 10000,
    pingTimeout: 8000,
  });
  const rooms = io.of('/').adapter.rooms;

  pipeline.isWatched = (vehicleId) => rooms.has(vehicleRoom(vehicleId));

  io.use((socket, next) => {
    try {
      socket.data.user = verifyToken(socket.handshake.auth?.token || '');
      socket.data.fleets = [];
      socket.data.lagging = false;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    metrics.clients = io.engine.clientsCount;
    if (user.role === 'admin') socket.join('metrics');

    socket.on('subscribe', (msg, ack) => {
      const wanted = Array.isArray(msg?.fleets) ? msg.fleets.filter((f) => canSeeFleet(user, f)) : [];
      for (const f of socket.data.fleets) if (!wanted.includes(f)) socket.leave(fleetRoom(f));
      for (const f of wanted) socket.join(fleetRoom(f));
      socket.data.fleets = wanted;
      socket.data.lagging = false;
      if (typeof ack === 'function') ack({ ok: true, fleets: wanted, t: Date.now(), d: pipeline.snapshot(wanted) });
    });

    socket.on('watch', (msg, ack) => {
      const id = String(msg?.vehicleId || '');
      const reg = pipeline.registry.get(id);
      if (!reg || !canSeeFleet(user, reg.fleetId)) return typeof ack === 'function' && ack({ ok: false, error: 'Not allowed' });
      socket.join(vehicleRoom(id));
      if (typeof ack === 'function') ack({ ok: true, lastSeq: pipeline.states.get(id)?.seq ?? null });
    });

    socket.on('unwatch', (msg) => socket.leave(vehicleRoom(String(msg?.vehicleId || ''))));

    socket.on('disconnect', () => {
      metrics.clients = io.engine.clientsCount;
    });
  });

  /**
   * Backpressure for slow clients: a socket whose outgoing buffer is backing up is taken out
   * of its fleet rooms, so batches stop queueing for it. Once its buffer drains it gets one
   * snapshot of the latest state and rejoins.
   */
  function handleSlowSockets() {
    for (const socket of io.sockets.sockets.values()) {
      const buffered = socket.conn?.writeBuffer?.length ?? 0;
      if (!socket.data.lagging && buffered > config.slowSocketBuffer) {
        socket.data.lagging = true;
        for (const f of socket.data.fleets) socket.leave(fleetRoom(f));
      } else if (socket.data.lagging && buffered === 0) {
        socket.data.lagging = false;
        for (const f of socket.data.fleets) socket.join(fleetRoom(f));
        socket.emit('fleet:snapshot', { t: Date.now(), d: pipeline.snapshot(socket.data.fleets) });
        metrics.inc('slowSocketResyncs');
      }
    }
  }

  const broadcastTimer = setInterval(() => {
    handleSlowSockets();
    const { t, fleets, vehicles } = pipeline.takeBroadcast();
    for (const { fleetId, deltas } of fleets) {
      const room = fleetRoom(fleetId);
      const listeners = rooms.get(room)?.size ?? 0;
      if (!listeners) continue;
      const payload = { t, f: fleetId, d: deltas };
      io.to(room).emit('fleet:batch', payload);
      const bytes = JSON.stringify(payload).length;
      metrics.inc('broadcastMessages', listeners);
      metrics.inc('broadcastBytes', bytes * listeners);
      metrics.countRoom(room, listeners, bytes);
    }
    // Incidents that changed this tick, grouped per fleet room.
    const byFleet = new Map();
    for (const inc of pipeline.incidents.takeChanged()) {
      let list = byFleet.get(inc.fleetId);
      if (!list) byFleet.set(inc.fleetId, (list = []));
      list.push(serializeIncident(inc));
    }
    for (const [fleetId, list] of byFleet) io.to(fleetRoom(fleetId)).emit('incidents', list);

    for (const { vehicleId, events } of vehicles) {
      const room = vehicleRoom(vehicleId);
      const payload = { id: vehicleId, e: events };
      io.to(room).emit('vehicle:events', payload);
      metrics.countRoom(room, rooms.get(room)?.size ?? 0, JSON.stringify(payload).length);
    }
  }, config.broadcastMs);

  /** Every fleet and vehicle room with its member count and traffic, for the Pipeline page. */
  function roomTable() {
    const out = [];
    for (const [room, members] of rooms) {
      if (!room.startsWith('fleet:') && !room.startsWith('vehicle:')) continue;
      const r = metrics.roomRates.get(room) || { msgs: 0, bytes: 0 };
      out.push({ room, screens: members.size, msgsPerSec: r.msgs, bytesPerSec: r.bytes });
    }
    return out.sort((a, b) => a.room.localeCompare(b.room));
  }

  const sweepTimer = setInterval(() => { pipeline.sweepOffline(); pipeline.incidents.sweep(); }, 5000);
  const metricsTimer = setInterval(() => {
    metrics.clients = io.engine.clientsCount;
    metrics.tick();
    if (rooms.get('metrics')?.size) {
      io.to('metrics').emit('metrics', metrics.snapshot({
        vehicles: pipeline.states.size, series: metrics.series.slice(-1), rooms: roomTable(),
        health: computeHealth({ metrics, pipeline, config, dbConnected: mongoose.connection.readyState === 1 }),
      }));
    }
  }, 1000);

  log.log(`[realtime] broadcasting every ${config.broadcastMs} ms`);
  return {
    io,
    stop: () => { clearInterval(broadcastTimer); clearInterval(sweepTimer); clearInterval(metricsTimer); io.close(); },
  };
}
