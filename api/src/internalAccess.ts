import { Request, Response, NextFunction } from 'express';

/**
 * Loopback guard for routes that are meant to be reachable only by a
 * process running inside this same container (currently just the
 * Puppeteer thumbnail renderer — see services/thumbGen.ts, which builds
 * its fetch URL as `http://localhost:${serverPort}/...`).
 *
 * Deliberately keyed on `req.socket.remoteAddress` — the raw TCP peer
 * address — and NOT `req.ip`. `req.ip` is derived from
 * X-Forwarded-For whenever Express's `trust proxy` setting matches the
 * connecting peer (see index.ts, which now pins `trust proxy` to NPM's
 * address per #2060's coupled acceptance criterion). This route's
 * security must not depend on that setting: the renderer never goes
 * through NPM, and this guard needs to keep working unchanged even if
 * the trust-proxy config is ever touched again. Using the raw socket
 * address means the loopback check is self-contained and independent of
 * proxy trust configuration.
 *
 * Filed as backlog #2060 (Vera, HIGH — unauthenticated raw-file
 * disclosure): docker-compose.production.yml publishes the api
 * container's port directly on the host, so without this guard,
 * `/internal/asset-raw/:id/:filename` served any real CAD/fabrication
 * file to anyone on the LAN who had (or guessed) an asset UUID, with no
 * token at all.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  // Normalize IPv4-mapped IPv6 form (what Node reports for an IPv4
  // connection on a dual-stack socket), e.g. "::ffff:127.0.0.1".
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (normalized === '::1') return true;
  // Entire 127.0.0.0/8 is loopback for IPv4, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Express middleware: 403s any request whose raw TCP peer is not
 * loopback. A 403 (rather than a 404 "hide that the route exists") is
 * deliberate — this path is a fixed, already-documented route (see the
 * backlog ticket and this file), not a per-resource secret, so there is
 * no meaningful existence-disclosure to protect by returning 404
 * instead. A 403 also gives an unambiguous signal in access logs/
 * monitoring — a burst of 403s here means someone is probing the
 * internal route directly — where a 404 would blend into ordinary
 * not-found traffic.
 */
export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
