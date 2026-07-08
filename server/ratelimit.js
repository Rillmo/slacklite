// Minimal in-memory per-IP rate limiter (no external dependency).
// Good enough for a single-process self-hosted instance.

export function rateLimit({ windowMs = 15 * 60_000, max = 20 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res
        .status(429)
        .json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    next();
  };
}
