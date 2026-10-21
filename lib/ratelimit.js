/**
 * Limiteur de requêtes entrantes par IP, par famille de routes.
 *
 * Un seul seuil global ne suffit pas : /api/aircraft est appelé toutes les
 * 5 s (normal), alors que /api/flight/:hex/schedule DÉPENSE un quota payé
 * en requêtes gratuites limitées. Un visiteur seul ne doit pas pouvoir
 * vider le quota de tout le monde.
 */
export function createRateLimit({ windowMs, max, message = 'Trop de requêtes, ralentis.' }) {
  const buckets = new Map();

  // ménage périodique : on n'accumule pas les IPs de passage
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (b.reset < now) buckets.delete(ip);
  }, Math.min(windowMs, 10 * 60_000));
  sweeper.unref();

  const limiter = (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(ip, b); }
    b.count++;
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: message, retryAfter: Math.ceil((b.reset - now) / 1000) });
    }
    next();
  };
  limiter.stats = () => ({ windowMs, max, trackedIps: buckets.size });
  return limiter;
}
