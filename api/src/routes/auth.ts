import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { createToken, requireAuth } from '../auth.js';
import { adminExists, getJwtSecret, getUserByUsername } from '../db.js';
import { verifyPassword } from '../passwords.js';
import type { LoginRequest, LoginResponse, HealthResponse } from '../types/index.js';

const router = Router();

// ─── Login rate limiting ─────────────────────────────────────────────────────
// In-memory sliding-window limiter, per source IP. No new dependency
// (no express-rate-limit/Redis) — this is a single-process, single-admin,
// LAN/Tailscale-only app, so an in-memory map is the right scope.
//
// UPDATE (#2060 closed, this commit): index.ts now sets
// `app.set('trust proxy', '10.10.5.16')` — NPM's exact address. req.ip
// below now reflects X-Forwarded-For for traffic that genuinely arrived
// via NPM (per-client granularity instead of every legitimate user
// collapsing onto NPM's one address, which was the old coarseness this
// comment used to warn about), while traffic from anywhere else still
// resolves to the raw TCP peer address, exactly as before.
//
// Why pinning the *exact* address is safe even though docker-
// compose.production.yml still publishes the api container's port
// directly on the host (independent of the NPM/web layer — that
// broader exposure is a separate, still-open matter; see
// Reports/kit-thefabvault-trust-proxy-2060-assessment-2026-07-08.md):
// Express's trust-proxy resolution (proxy-addr) walks the address chain
// starting at the immediate socket peer and only continues into
// X-Forwarded-For while each hop it has walked so far is itself
// trusted. A client that bypasses NPM and hits this Express app
// directly has a socket peer address that is never '10.10.5.16', so
// that walk stops at the very first hop — X-Forwarded-For is never
// consulted for that request, and req.ip is that client's own real
// address. There's no way to forge a fresh IP on every login attempt
// through this path. A bare `true`/`1` (trust every hop) would NOT have
// this property — that is what actually would have "fully defeat[ed]
// this limiter," not trust-proxy in general — which is why the exact-
// string form is load-bearing, not cosmetic. Do not loosen this to a
// boolean, a wildcard, or a CIDR broader than NPM's single address.
//
// The other half of #2060 — the unauthenticated raw-file disclosure —
// is closed independently in this same commit by requireLoopback
// (internalAccess.ts) gating GET /internal/asset-raw/:id/:filename in
// index.ts; that fix does not depend on trust-proxy at all (it reads
// req.socket.remoteAddress directly, deliberately not req.ip).
//
// LOGIN_WINDOW_MS/LOGIN_MAX_ATTEMPTS are exported so the test suite
// (__tests__/auth.test.ts) asserts against the real threshold instead of
// a hardcoded duplicate that could silently drift from this file.
export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, number[]>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) ?? [];
  const recent = attempts.filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  return true;
}

// authRequired is always true — auth is unconditionally enforced by
// requireAuth/requireAdmin now (see auth.ts). It stays a field on the
// response (rather than being dropped) purely for frontend API-shape
// compatibility (web/src/hooks/useAuth.ts); there is no longer a
// legitimate state where it should report false. Even "no admin seeded
// yet" is "auth required but currently unsatisfiable," not "auth off."
router.get('/health', (_req: Request, res: Response) => {
  const body: HealthResponse = { ok: true, authRequired: true };
  res.json(body);
});

router.post('/auth/login', (req: Request, res: Response) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    return;
  }

  // adminExists() fails closed (false on DB error), so a DB hiccup here
  // denies the login attempt rather than letting it fall through to a
  // comparison that might behave unexpectedly.
  if (!adminExists()) {
    res.status(503).json({ error: 'Authentication not configured' });
    return;
  }

  const { username, password } = req.body as LoginRequest;
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }

  // Same response for "no such user" and "wrong password" — don't leak
  // which one was wrong.
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = createToken(user.username);
  const body: LoginResponse = { token, expiresIn: config.jwtTtl };
  res.json(body);
});

router.post('/auth/refresh', requireAuth, (req: Request, res: Response) => {
  // requireAuth has already verified the token's signature and that its
  // `sub` matches a live users row — re-verify here only to recover the
  // payload (sub) needed to mint the new token, not as a second security
  // gate.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as { sub: string };
    const newToken = createToken(payload.sub);
    const body: LoginResponse = { token: newToken, expiresIn: config.jwtTtl };
    res.json(body);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

export default router;
