'use strict';
// Production entry point: Express (static files + health) + Socket.IO (real-time multiplayer) + optional PostgreSQL.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createStore } = require('./lib/store');
const { attach } = require('./lib/rooms');

const PORT = process.env.PORT || 3000;
const HTML = path.join(__dirname, 'public', 'index.html');

async function main() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const store = createStore(process.env);
  await store.init();

  const server = http.createServer(app);
  const io = new Server(server, {
    pingInterval: 10000, pingTimeout: 20000, maxHttpBufferSize: 1e5,
    cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined
  });
  const mgr = attach(io, {
    store, htmlPath: HTML,
    opts: { minPlayers: process.env.MIN_PLAYERS, maxRooms: process.env.MAX_ROOMS, gracePlayMs: process.env.RECONNECT_GRACE_MS, turnMs: process.env.TURN_MS /* testing only */ }
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind, rooms: mgr.rooms.size, matches: mgr.stats.matches, uptime: Math.round(process.uptime()) }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: 'index.html' }));

  server.listen(PORT, '0.0.0.0', () => console.log(`Stone & Crown online listening on port ${PORT} (storage: ${store.kind})`));
  const stop = () => { console.log('shutting down'); mgr.shutdown(); io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(err => { console.error('Failed to start:', err); process.exit(1); });
