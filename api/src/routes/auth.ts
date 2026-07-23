import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { createToken, requireAuth } from '../auth.js';
import { adminExists, getUserByUsername } from '../db.js';
import { verifyPassword } from '../passwords.js';
import type { LoginRequest, LoginResponse, HealthResponse, AuthMeOut } from '../types/index.js';

const router = Router();

// ─── Login rate limiting ─────────────────────────────────────────────────────
// In-memory sliding-window limiter, keyed on IP+username (#2183 — see
// rateLimitKeyFor below). No new dependency (no express-rate-limit/Redis)
// — this is a single-process, single-admin, LAN/Tailscale-only app, so an
// in-memory map is the right scope.
//
// UPDATE (#2060 closed): index.ts now sets
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

// #2183 — was keyed on IP alone: every account behind the same source
// address (this app's whole intended use case is one household sharing
// one home network/NPM address) shared a single bucket, so one member
// repeatedly fat-fingering THEIR OWN password could exhaust the limiter
// for every other account on the same network too. Composite IP+username
// keying gives each (peer, target account) pair its own bucket — a
// typo-prone member locks out only their own account's further attempts
// from that peer, never a housemate's.
//
// Deliberately NOT username alone: dropping IP from the key would let a
// distributed attacker (many source IPs, one target username) evade
// per-source rate limiting entirely by fanning out, which is exactly the
// attack shape a login rate limiter exists to blunt. Composite keying
// keeps both properties — a shared IP no longer cross-contaminates
// between accounts, and a single IP still can't brute-force one account
// past the threshold by itself.
//
// Username is trimmed but NOT case-folded: usernames.username has no
// COLLATE NOCASE (plain UNIQUE, migration v15), so getUserByUsername's
// own lookup is case-sensitive — 'Admin' and 'admin' really are
// different accounts in this schema, and folding case here would collapse
// two genuinely distinct rate-limit targets into one bucket, diverging
// from how the rest of the app treats username identity.
function rateLimitKeyFor(ip: string, username: string | undefined): string {
  return `${ip}::${(username ?? '').trim()}`;
}

// #2183 follow-up (Vera's bounded auth review, Medium finding): the
// composite ip::username bucket above removed the OLD ip-alone ceiling
// with nothing put back in its place — per-account protection went up,
// but the aggregate-per-IP backstop that used to exist quietly went to
// zero. Reproduced: 450 requests from one IP spread across 50 distinct
// usernames (9 each, one under each composite bucket's own cap) drew
// zero 429s — a single IP could grind the entire account list at
// effectively unbounded volume as long as it never touched any one
// account's threshold twice. This second, coarser counter — keyed on IP
// ALONE, independent of the composite map — is checked IN ADDITION to
// the composite check below; either tripping denies the request. It
// restores the old per-IP backstop without reintroducing the original
// cross-account-lockout bug: a household still won't lock each other out
// under ordinary use (a handful of legitimate logins across a few
// accounts is nowhere near 80/15min), but one IP grinding through many
// accounts now hits a ceiling regardless of how the attempts are spread
// across usernames.
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes — same window as the composite limiter
export const LOGIN_IP_MAX_ATTEMPTS = 80; // within Vera's suggested 60-100 range
const loginAttemptsByIp = new Map<string, number[]>();

// Both counters are sliding-window (filter-then-push), same shape as the
// original single limiter — pulled into one generic function so the two
// maps can never drift into subtly different semantics from each other.
function checkAndConsume(map: Map<string, number[]>, key: string, windowMs: number, maxAttempts: number): boolean {
  const now = Date.now();
  const attempts = map.get(key) ?? [];
  const recent = attempts.filter((t) => now - t < windowMs);
  if (recent.length >= maxAttempts) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  map.set(key, recent);
  return true;
}

// Deliberately evaluates BOTH counters unconditionally (not short-
// circuited with `&&`) — every login attempt from an IP must count
// toward the coarse IP-alone ceiling regardless of whether it also trips
// (or is already tripped by) the composite per-account bucket. Denies if
// EITHER limit is at capacity.
function checkRateLimit(ip: string, username: string | undefined): boolean {
  const compositeOk = checkAndConsume(loginAttempts, rateLimitKeyFor(ip, username), LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS);
  const ipOk = checkAndConsume(loginAttemptsByIp, ip, LOGIN_IP_WINDOW_MS, LOGIN_IP_MAX_ATTEMPTS);
  return compositeOk && ipOk;
}

// #2184 — a fixed, valid-format scrypt hash used ONLY to give
// verifyPassword() something to derive a comparison key against on the
// unknown-username login path. Its own value is never meaningful (no
// real password will ever match it) — the point is purely CPU-time
// parity: before this, an unknown username short-circuited the `||`
// chain in the login handler before verifyPassword ever ran (~30ms,
// just the DB lookup), while a KNOWN username with a wrong password paid
// the full scrypt cost (~150ms) — an external timing probe could use
// that gap to enumerate valid usernames without ever guessing a
// password. Hardcoded (not computed via hashPassword() at module load)
// so it costs nothing at process boot and needs no crypto.randomBytes
// call whose output would be thrown away anyway.
const DUMMY_HASH_FOR_TIMING_PARITY =
  'scrypt:16384:8:1:de6931247c75a0a636fff1c818360a69:ee483ce2b51d9677caa7e3f02640b39dacaa580dbb0407f7493c5a8e3d01fee882947b09c0b45b790e927c401bc5da1f0dd83df78b372fad3c0c8f9ccfda50b7';

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
  const { username, password } = req.body as LoginRequest;

  // #2183 — checked before the presence check below so even a malformed
  // request (missing username/password) still consumes a slot in both
  // counters rather than being rate-limit-exempt. checkRateLimit gates
  // on the composite ip::username bucket AND the coarser ip-alone
  // ceiling (Vera's finding) — either tripping denies the request; see
  // checkRateLimit's own comment for why both are needed together.
  if (!checkRateLimit(ip, username)) {
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

  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }

  const user = getUserByUsername(username);
  if (!user) {
    // #2184 — unknown username. Still pays the same scrypt cost a real
    // password check would (against a fixed dummy hash whose own value
    // is never used for anything) so response timing can't be used to
    // probe which usernames exist. The derived result is intentionally
    // discarded; the 401 below fires unconditionally.
    verifyPassword(password, DUMMY_HASH_FOR_TIMING_PARITY);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Same response for "wrong password" AND "disabled user" — don't leak
  // which one it was. Fail-closed: `disabled` is checked in the same
  // condition as the credential check rather than a separate branch
  // afterward, so there is no code path that verifies the password first
  // and only then remembers to check disabled (#2177, Phase D — same
  // disabled=1 semantics requireAuth/requireAdmin enforce per-request;
  // this is just the same rule at the login gate). verifyPassword still
  // runs here regardless of `disabled` — same timing-parity reasoning as
  // the unknown-username branch above, just for free since a real hash
  // is already being compared against.
  if (!verifyPassword(password, user.password_hash) || user.disabled) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = createToken(user.username, user.token_version);
  const body: LoginResponse = { token, expiresIn: config.jwtTtl };
  res.json(body);
});

// GET /auth/me — requireAuth. Returns the caller's own identity/role from
// the live `users` row already attached by requireAuth (req.user), not
// from the JWT claims (which only ever carry `sub` — see auth.ts's
// createToken comment). This is the D2/D4 contract: every client-side
// role gate (admin-only nav, "is this mine" ownership checks, etc.) reads
// from this endpoint's response, never from decoding the token itself.
router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
  const user = req.user!; // requireAuth guarantees this is set
  const body: AuthMeOut = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  };
  res.json(body);
});

router.post('/auth/refresh', requireAuth, (req: Request, res: Response) => {
  // requireAuth has already verified the token's signature, confirmed
  // its `sub` matches a live, non-disabled users row, and (#2185)
  // confirmed its token_version matches that row's current value —
  // req.user IS that live row, already attached. No need to re-decode
  // the token here at all; mint the new one straight from req.user so
  // the refreshed token carries the SAME live token_version (never the
  // possibly-stale claim off the token being refreshed).
  const newToken = createToken(req.user!.username, req.user!.token_version);
  const body: LoginResponse = { token: newToken, expiresIn: config.jwtTtl };
  res.json(body);
});

export default router;
