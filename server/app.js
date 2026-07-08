import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutes } from './routes.js';
import { setupSockets } from './sockets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer(port = 3000, host = process.env.HOST ?? '0.0.0.0') {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  // Behind nginx/Caddy/Traefik: report real client IPs (rate limiting).
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', createRoutes(io));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  setupSockets(io);

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const actual = httpServer.address().port;
      console.log(`SlackLite running at http://localhost:${actual}`);
      resolve(httpServer);
    });
  });
}
