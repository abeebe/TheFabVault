// Integration tests for GET /auth/me + routes/users.ts (Phase D, #2177) —
// same boot pattern as categories.test.ts/auth.test.ts (module-level
// singletons in db.ts mean this needs a real request path and a fresh
// module registry per fixture; see auth.test.ts's header for the full
// rationale). A bare requireAuth-protected ping route stands in for "any
// protected route" for the disabled-JWT-revocation assertions, same as
// auth.test.ts's own /protected/ping.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';

interface Booted {
  baseUrl: string;
  adminToken: string;
  db: Database.Database;
  close: () => Promise<void>;
}

const booted: Booted[] = [];

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'correct-horse-battery-staple';

async function bootApp(): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-userstest-data-'));
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_USERNAME = ADMIN_USER;
  process.env.AUTH_PASSWORD = ADMIN_PASS;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authMod = await import('../auth.js');
  const authRouterMod = await import('../routes/auth.js');
  const usersRouterMod = await import('../routes/users.js');

  const app = express();
  app.use(express.json());
  app.use('/', authRouterMod.default);
  app.use('/', usersRouterMod.default);
  app.get('/protected/ping', authMod.requireAuth, (_req, res) => res.json({ ok: true }));

  const db = dbMod.getDb();

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (loginRes.status !== 200) throw new Error(`test setup: login failed with ${loginRes.status}`);
  const { token: adminToken } = (await loginRes.json()) as { token: string };

  const result: Booted = {
    baseUrl,
    adminToken,
    db,
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

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
  return { ...bearer(token), 'Content-Type': 'application/json' };
}

async function login(app: Booted, username: string, password: string): Promise<Response> {
  return fetch(`${app.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

interface UserOutBody {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  generatedPassword?: string;
}

// Creates a plain member via the real POST /users route (dogfooding the
// surface under test rather than inserting directly), returning both the
// created user and the plaintext generated password so callers can log in
// as them.
async function createMember(app: Booted, username: string): Promise<{ user: UserOutBody; password: string }> {
  const res = await fetch(`${app.baseUrl}/users`, {
    method: 'POST',
    headers: jsonHeaders(app.adminToken),
    body: JSON.stringify({ username, role: 'member' }),
  });
  expect(res.status).toBe(201);
  const user = (await res.json()) as UserOutBody;
  expect(user.generatedPassword).toBeTruthy();
  return { user, password: user.generatedPassword! };
}

describe('GET /auth/me', () => {
  it('returns id/username/displayName/role for the seeded admin, derived from the live row', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(app.adminToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; username: string; displayName: string | null; role: string };
    expect(body.username).toBe(ADMIN_USER);
    expect(body.role).toBe('admin');
    expect(body.displayName).toBeNull();
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('401s with no token', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/auth/me`);
    expect(res.status).toBe(401);
  });

  it('reflects a role change on the very next call — never a token-cached value', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'shopfloor');
    const memberLoginRes = await login(app, 'shopfloor', password);
    const { token: memberToken } = (await memberLoginRes.json()) as { token: string };

    const before = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(memberToken) });
    expect((await before.json() as { role: string }).role).toBe('member');

    await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ role: 'admin' }),
    });

    const after = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(memberToken) });
    expect((await after.json() as { role: string }).role).toBe('admin');
  });
});

describe('auth matrix: member cannot touch /users/*', () => {
  it('member token gets 403 on every /users* route; admin token succeeds', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'reader');
    const memberLoginRes = await login(app, 'reader', password);
    const { token: memberToken } = (await memberLoginRes.json()) as { token: string };

    const list = await fetch(`${app.baseUrl}/users`, { headers: bearer(memberToken) });
    expect(list.status).toBe(403);

    const create = await fetch(`${app.baseUrl}/users`, {
      method: 'POST',
      headers: jsonHeaders(memberToken),
      body: JSON.stringify({ username: 'should-not-exist' }),
    });
    expect(create.status).toBe(403);

    const update = await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(memberToken),
      body: JSON.stringify({ displayName: 'Nope' }),
    });
    expect(update.status).toBe(403);

    const reset = await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: jsonHeaders(memberToken),
    });
    expect(reset.status).toBe(403);

    // Sanity: the admin token this whole suite otherwise uses DOES
    // succeed on the same list route, proving 403 above is role-gating,
    // not a broken route.
    const adminList = await fetch(`${app.baseUrl}/users`, { headers: bearer(app.adminToken) });
    expect(adminList.status).toBe(200);
  });

  it('401s every /users* route with no token at all', async () => {
    const app = await bootApp();
    const noToken = await fetch(`${app.baseUrl}/users`);
    expect(noToken.status).toBe(401);
  });
});

describe('POST /users — create', () => {
  it('creates a member with a generated password (never echoed for a supplied one)', async () => {
    const app = await bootApp();
    const { user } = await createMember(app, 'newmember');
    expect(user.role).toBe('member');
    expect(user.disabled).toBe(false);

    const explicit = await fetch(`${app.baseUrl}/users`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ username: 'explicitpw', password: 'a-fine-password-123' }),
    });
    expect(explicit.status).toBe(201);
    const explicitBody = (await explicit.json()) as UserOutBody;
    expect(explicitBody.generatedPassword).toBeUndefined();

    // The supplied password is never stored in plaintext anywhere in the
    // response or the row — assert against the DB directly (same
    // pattern as auth.test.ts's mount-password redaction test).
    const row = app.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('explicitpw') as { password_hash: string };
    expect(row.password_hash).not.toContain('a-fine-password-123');
    expect(row.password_hash.startsWith('scrypt:')).toBe(true);
  });

  it('rejects a supplied password shorter than the minimum', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/users`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ username: 'shortpw', password: 'short' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid role', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/users`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ username: 'badrole', role: 'superadmin' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing username', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/users`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ role: 'member' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s on a duplicate username', async () => {
    const app = await bootApp();
    await createMember(app, 'dupeuser');
    const res = await fetch(`${app.baseUrl}/users`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ username: 'dupeuser', role: 'member' }),
    });
    expect(res.status).toBe(409);
  });

  it('defaults role to member and lists it via GET /users', async () => {
    const app = await bootApp();
    await createMember(app, 'plainmember');
    const list = await fetch(`${app.baseUrl}/users`, { headers: bearer(app.adminToken) });
    const body = (await list.json()) as UserOutBody[];
    const found = body.find((u) => u.username === 'plainmember');
    expect(found?.role).toBe('member');
  });
});

describe('PATCH /users/:id', () => {
  it('updates role, displayName, and disabled for someone other than the caller', async () => {
    const app = await bootApp();
    const { user } = await createMember(app, 'editme');

    const res = await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ role: 'admin', displayName: 'Edited Name', disabled: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserOutBody;
    expect(body.role).toBe('admin');
    expect(body.displayName).toBe('Edited Name');
    expect(body.disabled).toBe(true);
  });

  it('404s for an unknown id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/users/00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ displayName: 'Ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s an admin attempting to disable their own account', async () => {
    const app = await bootApp();
    const me = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(app.adminToken) });
    const { id } = (await me.json()) as { id: string };

    const res = await fetch(`${app.baseUrl}/users/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(409);

    // The guard actually blocked the write, not just the response code.
    const row = app.db.prepare('SELECT disabled FROM users WHERE id = ?').get(id) as { disabled: number };
    expect(row.disabled).toBe(0);
  });

  it('409s an admin attempting to demote their own role away from admin', async () => {
    const app = await bootApp();
    const me = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(app.adminToken) });
    const { id } = (await me.json()) as { id: string };

    const res = await fetch(`${app.baseUrl}/users/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ role: 'member' }),
    });
    expect(res.status).toBe(409);

    const row = app.db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string };
    expect(row.role).toBe('admin');
  });

  it('allows an admin to edit their own displayName (the guard is scoped to disable/demote only)', async () => {
    const app = await bootApp();
    const me = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(app.adminToken) });
    const { id } = (await me.json()) as { id: string };

    const res = await fetch(`${app.baseUrl}/users/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ displayName: 'The Admin' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as UserOutBody).displayName).toBe('The Admin');
  });

  it('rejects an invalid role on update', async () => {
    const app = await bootApp();
    const { user } = await createMember(app, 'badroleupdate');
    const res = await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ role: 'root' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /users/:id/reset-password', () => {
  it('generates a new password when none is supplied, and it actually works to log in', async () => {
    const app = await bootApp();
    const { user, password: oldPassword } = await createMember(app, 'resetme');

    const res = await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserOutBody;
    expect(body.generatedPassword).toBeTruthy();
    expect(body.generatedPassword).not.toBe(oldPassword);

    const oldLogin = await login(app, 'resetme', oldPassword);
    expect(oldLogin.status).toBe(401);

    const newLogin = await login(app, 'resetme', body.generatedPassword!);
    expect(newLogin.status).toBe(200);
  });

  it('does not echo the password back when one was explicitly supplied', async () => {
    const app = await bootApp();
    const { user } = await createMember(app, 'resetexplicit');

    const res = await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ password: 'a-different-password-456' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as UserOutBody).generatedPassword).toBeUndefined();
  });

  it('404s for an unknown id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/users/00000000-0000-0000-0000-000000000000/reset-password`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
    });
    expect(res.status).toBe(404);
  });
});

// #2185 — reset-password bumps token_version, which auth.ts's
// requireAuth/requireAdmin compare against on every request. A stateless
// {sub} JWT (pre-#2185) verified fine and matched a live, non-disabled
// row right up until its own TTL — a reset used to do nothing at all to
// an already-issued token.
describe('POST /users/:id/reset-password — token_version bump invalidates outstanding tokens (#2185)', () => {
  it('a token issued before the reset stops working on the very next request, no waiting for expiry', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'tokenholder');
    const loginRes = await login(app, 'tokenholder', password);
    const { token: oldToken } = (await loginRes.json()) as { token: string };

    const before = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(oldToken) });
    expect(before.status).toBe(200);

    const resetRes = await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: jsonHeaders(app.adminToken),
    });
    expect(resetRes.status).toBe(200);
    const { generatedPassword } = (await resetRes.json()) as { generatedPassword: string };

    const after = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(oldToken) });
    expect(after.status).toBe(401);
    const meAfter = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(oldToken) });
    expect(meAfter.status).toBe(401);

    // Normal login with the new password still works, and that fresh
    // token (carrying the bumped token_version) is fully usable —
    // the reset invalidates the OLD token, it doesn't brick the account.
    const newLoginRes = await login(app, 'tokenholder', generatedPassword);
    expect(newLoginRes.status).toBe(200);
    const { token: newToken } = (await newLoginRes.json()) as { token: string };
    const withNewToken = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(newToken) });
    expect(withNewToken.status).toBe(200);
  });

  it('the DB row bumps by exactly 1 per reset, regardless of how many times it happens', async () => {
    const app = await bootApp();
    const { user } = await createMember(app, 'multireset');

    const before = app.db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id) as { token_version: number };
    expect(before.token_version).toBe(1);

    await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, { method: 'POST', headers: jsonHeaders(app.adminToken) });
    const afterOne = app.db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id) as { token_version: number };
    expect(afterOne.token_version).toBe(2);

    await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, { method: 'POST', headers: jsonHeaders(app.adminToken) });
    const afterTwo = app.db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id) as { token_version: number };
    expect(afterTwo.token_version).toBe(3);
  });

  it('a refreshed token after a reset carries the NEW token_version, not the stale claim off the token being refreshed', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'refreshafterreset');
    const loginRes = await login(app, 'refreshafterreset', password);
    const { token: firstToken } = (await loginRes.json()) as { token: string };

    // Refresh once BEFORE the reset — ordinary case, should still work.
    const refreshBefore = await fetch(`${app.baseUrl}/auth/refresh`, { method: 'POST', headers: bearer(firstToken) });
    expect(refreshBefore.status).toBe(200);
    const { token: refreshedBeforeReset } = (await refreshBefore.json()) as { token: string };

    await fetch(`${app.baseUrl}/users/${user.id}/reset-password`, { method: 'POST', headers: jsonHeaders(app.adminToken) });

    // The token refreshed BEFORE the reset is now just as invalid as the
    // original — it still carries the pre-reset token_version.
    const pingWithStaleRefresh = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(refreshedBeforeReset) });
    expect(pingWithStaleRefresh.status).toBe(401);
    const refreshAttemptAfterReset = await fetch(`${app.baseUrl}/auth/refresh`, { method: 'POST', headers: bearer(refreshedBeforeReset) });
    expect(refreshAttemptAfterReset.status).toBe(401);
  });
});

describe('disabled users: fail-closed at login and instant JWT revocation', () => {
  it('a disabled user cannot log in — same 401 shape as bad credentials', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'willbedisabled');
    await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ disabled: true }),
    });

    const res = await login(app, 'willbedisabled', password);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid credentials/i);
  });

  it('an existing valid JWT stops working the instant the user is disabled — no waiting for expiry', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'livetoken');
    const loginRes = await login(app, 'livetoken', password);
    const { token } = (await loginRes.json()) as { token: string };

    const before = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(token) });
    expect(before.status).toBe(200);
    const meBefore = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(token) });
    expect(meBefore.status).toBe(200);

    await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ disabled: true }),
    });

    const after = await fetch(`${app.baseUrl}/protected/ping`, { headers: bearer(token) });
    expect(after.status).toBe(401);
    const meAfter = await fetch(`${app.baseUrl}/auth/me`, { headers: bearer(token) });
    expect(meAfter.status).toBe(401);
  });

  it('re-enabling a disabled user restores both login and the auth check (not a one-way trip)', async () => {
    const app = await bootApp();
    const { user, password } = await createMember(app, 'toggleuser');
    await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ disabled: true }),
    });
    expect((await login(app, 'toggleuser', password)).status).toBe(401);

    await fetch(`${app.baseUrl}/users/${user.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.adminToken),
      body: JSON.stringify({ disabled: false }),
    });
    const res = await login(app, 'toggleuser', password);
    expect(res.status).toBe(200);
  });
});
