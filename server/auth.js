import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserById } from './db.js';

// Use JWT_SECRET if provided; otherwise generate once and persist next to the
// database so sessions survive server restarts.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const secretPath =
    process.env.SECRET_PATH ?? path.join(__dirname, '..', '.jwt-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}

export const JWT_SECRET = loadSecret();

export function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return getUserById(payload.sub) ?? null;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: '인증이 필요합니다.' });
  req.user = user;
  next();
}

export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  const user = token ? verifyToken(token) : null;
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
}
