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
// req.ip currently reports the raw TCP peer address — there is no
// `app.set('trust proxy', …)` anywhere in index.ts (Express default:
// trust proxy = false). Behind NPM that collapses every real client onto
// NPM's one address, so the attempt budget is effectively shared across
// all legitimate users rather than per-attacker — coarser than ideal,
// but SAFE: with trust proxy off, the app ignores X-Forwarded-For
// entirely, so nothing can forge that header to dodge the limiter.
//
// DO NOT "fix" this by turning on trust proxy on its own. docker-
// compose.production.yml also publishes the api container's port
// directly on the host, independent of the NPM/web layer (tracked as
// backlog #2060 — unauthenticated /internal/asset-raw disclosure via
// that same exposure). While #2060 is open, a LAN-local client can
// bypass NPM and hit this Express app directly; if trust proxy trusted
// X-Forwarded-For from that path, the same client could forge a fresh
// IP on every login attempt and fully defeat this limiter — a net
// regression, not a hardening. Vera's ruling on re-review (see
// Reports/vera-fabvault-auth-migration-reverify-2026-07-08.md, "Ruling
// on the req.ip/trust-proxy question"): once #2060's direct-port
// exposure is closed (host stops publishing the raw api port; only NPM
// can reach this app), pin `app.set('trust proxy', '10.10.5.16')` — NPM's
// exact address, never a bare boolean or `1` — in the SAME change that
// closes #2060. Until then, leave trust proxy unset; that is the safer
// of the two configurations given the current compose topology, not a
// gap to close opportunistically on its own.
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
