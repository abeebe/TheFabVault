// Auth integration tests — exercise the real Express routers
// (routes/auth.ts, routes/mounts.ts) and middleware (auth.ts's
// requireAuth/requireAdmin) against a throwaway on-disk SQLite DB, over a
// real HTTP loopback server (native fetch — no new test-only dependency,
// same "no new dependency" philosophy as the in-memory rate limiter this
// suite tests).
//
// Why not the in-memory-DB + call-the-function-directly style used by
// manifestRollup.test.ts / subAssemblyImport.test.ts: db.ts caches its
// connection and JWT secret as module-level singletons (getDb()/
// getJwtSecret()), and the auth contract under test is specifically
// about how requireAuth/requireAdmin behave wired into real routes
// (header parsing, status codes, the login rate limiter keyed on
// req.ip) — that needs an actual request path, not a bare unit call.
// Per-test isolation comes from vi.resetModules() + a fresh DATA_DIR per
// fixture, so each test gets its own DB file and its own copy of every
// module-level singleton (loginAttempts map included).
//
// These are the fail-closed cases Sage verified manually in QA and Vera
// signed off on (see
// Reports/kit-fabvault-env-to-db-auth-scoping-2026-07-08.md and
// Reports/vera-fabvault-auth-migration-security-review-2026-07-08.md) —
// this file is what puts those proofs in CI instead of leaving them only
// in a report.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { LOGIN_MAX_ATTEMPTS } from '../routes/auth.js';

interface Booted {
  baseUrl: string;
  createToken: (username: string) => string;
  getJwtSecret: () => string;
  getDb: () => Database.Database;
  close: () => Promise<void>;
}

const booted: Booted[] = [];

/**
 * Boot an isolated instance of the auth-relevant surface: a throwaway
 * SQLite file in a fresh temp dir, a fresh module registry (so db.ts's
 * module-level singletons don't leak between fixtures), and a minimal
 * Express app wiring together the real authRouter, mountsRouter, and a
 * bare requireAuth-protected route standing in for "any protected
 * route" — the exact route doesn't matter, requireAuth is what's under
 * test.
 *
 * Pass `seedAdmin: null` to model the empty-`users`-table state (no
 * AUTH_USERNAME/AUTH_PASSWORD set, nothing seeded).
 */
async function bootApp(seedAdmin: { username: string; password: string } | null): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-authtest-'));
  process.env.DATA_DIR = dataDir;
  if (seedAdmin) {
    process.env.AUTH_USERNAME = seedAdmin.username;
    process.env.AUTH_PASSWORD = seedAdmin.password;
  } else {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
  }

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authMod = await import('../auth.js');
  const authRouterMod = await import('../routes/auth.js');
  const mountsRouterMod = await import('../routes/mounts.js');

  const app = express();
  app.use(express.json());
  // Deliberately no `app.set('trust proxy', …)` — matches the app's real
  // default (see the coupling note at the rate limiter in routes/auth.ts
  // and #2060). req.ip below is the real loopback socket address.
  app.use('/', authRouterMod.default);
  app.use('/', mountsRouterMod.default);
  app.get('/protected/ping', authMod.requireAuth, (_req, res) => res.json({ ok: true }));

  // Same trigger index.ts's listen callback uses in production: getDb()
  // runs migrations, resolves/persists the JWT secret, and (once) seeds
  // the admin from env.
  dbMod.getDb();

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const result: Booted = {
    baseUrl: `http://127.0.0.1:${port}`,
    createToken: authMod.createToken,
    getJwtSecret: dbMod.getJwtSecret,
    getDb: dbMod.getDb,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbMod.closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  booted.push(result);
  return result;
}

afterEach(async () => {
  while (booted.length) {
    const b = booted.pop();
    await b?.close();
  }
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD;
  delete process.env.DATA_DIR;
});

async function login(app: Booted, username: string, password: string): Promise<Response> {
  return fetch(`${app.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function loginAndGetToken(app: Booted, username: string, password: string): Promise<string> {
  const res = await login(app, username, password);
  if (res.status !== 200) throw new Error(`test setup: login failed with ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'correct-horse-battery-staple';

describe('fail-closed: empty users table', () => {
  it('POST /auth/login refuses with 503 (not configured) rather than 200/401', async () => {
    const app = await bootApp(null);
    const res = await login(app, 'anyone', 'anything');
    expect(res.status).toBe(503);
  });

  it('a well-signed token whose sub matches no row is denied — the load-bearing fail-closed case', async () => {
    const app = await bootApp(null);
    // createToken() only signs a JWT; it never checks the users table.
    // Getting a 401 here proves requireAuth's DB-backed live-user check
    // is what denies — not merely "no token was sent" (covered
    // separately below).
    const token = app.createToken('ghost-admin');
    const res = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(token) });
    expect(res.status).toBe(401);
  });

  it('requireAdmin-gated route also denies the same well-signed, no-matching-row token', async () => {
    const app = await bootApp(null);
    const token = app.createToken('ghost-admin');
    const res = await fetch(`${app.baseUrl}/admin/mounts`, { headers: bearer(token) });
    expect(res.status).toBe(401);
  });

  it('protected route denies outright with no token at all', async () => {
    const app = await bootApp(null);
    const res = await fetch(`${app.baseUrl}/protected/ping`);
    expect(res.status).toBe(401);
  });
});

describe('token validity', () => {
  it('denies when no Authorization header is sent', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });
    const res = await fetch(`${app.baseUrl}/protected/ping`);
    expect(res.status).toBe(401);
  });

  it('denies a malformed JWT', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });
    const res = await fetch(`${app.baseUrl}/protected/ping`, {
      headers: bearer('not-a-real-jwt'),
    });
    expect(res.status).toBe(401);
  });

  it('denies an expired JWT even though it is correctly signed', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });
    const expired = jwt.sign({ sub: ADMIN_USER }, app.getJwtSecret(), {
      algorithm: 'HS256',
      expiresIn: -10, // already expired at mint time
    });
    const res = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(expired) });
    expect(res.status).toBe(401);
  });

  it('denies a valid, unexpired token whose sub user has since been deleted', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });
    const token = app.createToken(ADMIN_USER);

    const before = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(token) });
    expect(before.status).toBe(200);

    app.getDb().prepare('DELETE FROM users WHERE username = ?').run(ADMIN_USER);

    const after = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(token) });
    expect(after.status).toBe(401);
  });
});

describe('login', () => {
  it('happy path: seeded admin logs in and the token works on a protected route', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });

    const loginRes = await login(app, ADMIN_USER, ADMIN_PASS);
    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as { token: string; expiresIn: number };
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.expiresIn).toBeGreaterThan(0);

    const pingRes = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(body.token) });
    expect(pingRes.status).toBe(200);
    expect(await pingRes.json()).toEqual({ ok: true });
  });

  it('wrong password returns 401 and is indistinguishable from "no such user"', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });

    const wrongPasswordRes = await login(app, ADMIN_USER, 'wrong-password');
    const noSuchUserRes = await login(app, 'not-a-real-user', 'wrong-password');

    expect(wrongPasswordRes.status).toBe(401);
    expect(noSuchUserRes.status).toBe(401);
    expect(await wrongPasswordRes.json()).toEqual(await noSuchUserRes.json());
  });
});

describe('login rate limiter', () => {
  it(`trips after ${LOGIN_MAX_ATTEMPTS} attempts from the same source IP and returns 429`, async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });

    // Every attempt up to the threshold is evaluated on credentials
    // (401 — wrong password), i.e. not yet blocked by the limiter.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await login(app, ADMIN_USER, 'wrong-password');
      expect(res.status).toBe(401);
    }

    // One more within the same window trips it.
    const limited = await login(app, ADMIN_USER, 'wrong-password');
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toMatch(/too many/i);

    // Even the *correct* password is refused while the window is tripped
    // — the limiter gates before credentials are checked at all.
    const stillLimited = await login(app, ADMIN_USER, ADMIN_PASS);
    expect(stillLimited.status).toBe(429);
  });
});

describe('GET /admin/mounts password redaction', () => {
  const SECRET_PASSWORD = 'super-secret-share-password';

  async function createSlot1(app: Booted, token: string, overrides: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`${app.baseUrl}/admin/mounts`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slot: 1,
        name: 'Test Share',
        type: 'smb',
        host: '10.0.0.5',
        remote_path: '/share',
        username: 'shareuser',
        password: SECRET_PASSWORD,
        ...overrides,
      }),
    });
  }

  it('never returns the plaintext password — only a hasPassword boolean', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });
    const token = await loginAndGetToken(app, ADMIN_USER, ADMIN_PASS);

    const createRes = await createSlot1(app, token);
    expect(createRes.status).toBe(200);
    expect(((await createRes.json()) as { success: boolean }).success).toBe(true);

    const listRes = await fetch(`${app.baseUrl}/admin/mounts`, { headers: bearer(token) });
    expect(listRes.status).toBe(200);
    const rawBody = await listRes.text();
    // Defense at the wire level, not just "the field is missing": the
    // literal secret must not appear anywhere in the response body.
    expect(rawBody).not.toContain(SECRET_PASSWORD);

    const slots = JSON.parse(rawBody) as Array<{ slot: number; config: { hasPassword: boolean; password?: string } | null }>;
    const slot1 = slots.find((s) => s.slot === 1);
    expect(slot1?.config).toBeTruthy();
    expect(slot1?.config?.hasPassword).toBe(true);
    expect(slot1?.config?.password).toBeUndefined();
  });

  it('a blank password on update preserves the previously stored password', async () => {
    const app = await bootApp({ username: ADMIN_USER, password: ADMIN_PASS });
    const token = await loginAndGetToken(app, ADMIN_USER, ADMIN_PASS);

    const createRes = await createSlot1(app, token);
    expect(createRes.status).toBe(200);

    // Update: change an unrelated field, send password: '' (what the
    // admin UI sends when the field is left blank on edit).
    const updateRes = await createSlot1(app, token, { name: 'Test Share (renamed)', password: '' });
    expect(updateRes.status).toBe(200);

    // The API never returns the real value, so the DB is the only place
    // this can be confirmed — matches the codebase's existing pattern of
    // asserting on DB state directly (see subAssemblyImport.test.ts).
    const row = app.getDb()
      .prepare('SELECT name, password FROM mount_configs WHERE slot = ?')
      .get(1) as { name: string; password: string };
    expect(row.name).toBe('Test Share (renamed)');
    expect(row.password).toBe(SECRET_PASSWORD);
  });
});
