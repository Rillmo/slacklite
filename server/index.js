import { startServer } from './app.js';
import { closeDb } from './db.js';

const server = await startServer(Number(process.env.PORT ?? 3000)).catch((err) => {
  console.error(err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Open sockets (Socket.IO) keep the server alive; force-exit after grace period.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
