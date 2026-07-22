// Integration tests for routes/categories.ts (#2164) — exercise the real
// Express router against a throwaway on-disk SQLite DB, over a real HTTP
// loopback server. Same boot pattern as models.test.ts/auth.test.ts
// (module-level singletons in db.ts mean this needs a real request path
// and a fresh module registry per fixture) — see auth.test.ts's header
// for the full rationale.
//
// The seeded admin user is currently the ONLY role the schema allows
// (auth.ts's requireAdmin comment), so requireAuth vs requireAdmin can't
// yet be told apart by a real member-vs-admin token — that split becomes
// meaningfully testable once Phase D's multi-role pass lands. What IS
// tested here: every route (read and write) 401s with no token at all,
// and the write routes behave correctly for the admin token that exists
// today.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

interface Booted {
  baseUrl: string;
  token: string;
  db: Database.Database;
  close: () => Promise<void>;
}

const booted: Booted[] = [];

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'correct-horse-battery-staple';

async function bootApp(): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-categoriestest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-categoriestest-storage-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_USERNAME = ADMIN_USER;
  process.env.AUTH_PASSWORD = ADMIN_PASS;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authRouterMod = await import('../routes/auth.js');
  const categoriesRouterMod = await import('../routes/categories.js');

  const app = express();
  app.use(express.json());
  app.use('/', authRouterMod.default);
  app.use('/', categoriesRouterMod.default);

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
  const { token } = (await loginRes.json()) as { token: string };

  const result: Booted = {
    baseUrl,
    token,
    db,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbMod.closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(storageDir, { recursive: true, force: true });
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
  delete process.env.STORAGE_DIR;
});

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
  return { ...bearer(token), 'Content-Type': 'application/json' };
}

describe('GET /categories', () => {
  it('returns the 8 seeded categories, ordered by sort_order then name', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; name: string; parentId: string | null; sortOrder: number }>;
    expect(body).toHaveLength(8);
    expect(body[0].name).toBe('Functional'); // sort_order 0, first seeded
    expect(body.every((c) => c.parentId === null)).toBe(true);
    // sort_order strictly ascending across the seeded set
    for (let i = 1; i < body.length; i++) {
      expect(body[i].sortOrder).toBeGreaterThan(body[i - 1].sortOrder);
    }
  });

  it('401s with no token', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/categories`);
    expect(res.status).toBe(401);
  });
});

describe('POST /categories', () => {
  it('creates a top-level category, defaulting sortOrder to append at the end', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Garden' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; name: string; parentId: string | null; sortOrder: number };
    expect(body.name).toBe('Garden');
    expect(body.parentId).toBeNull();
    expect(body.sortOrder).toBe(8); // 8 seeded categories occupy 0-7
  });

  it('creates a child category under an existing parent', async () => {
    const app = await bootApp();
    const listRes = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    const [parent] = await listRes.json() as Array<{ id: string }>;

    const res = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Sub Thing', parentId: parent.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { parentId: string };
    expect(body.parentId).toBe(parent.id);
  });

  it('rejects a missing name', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('400s for a nonexistent parentId', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Orphan', parentId: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('401s with no token', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Garden' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /category/:id', () => {
  it('renames a category', async () => {
    const app = await bootApp();
    const listRes = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    const [cat] = await listRes.json() as Array<{ id: string }>;

    const res = await fetch(`${app.baseUrl}/category/${cat.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { name: string }).name).toBe('Renamed');
  });

  it('rejects a category being made its own parent', async () => {
    const app = await bootApp();
    const listRes = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    const [cat] = await listRes.json() as Array<{ id: string }>;

    const res = await fetch(`${app.baseUrl}/category/${cat.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ parentId: cat.id }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects moving a category into its own descendant (cycle guard)', async () => {
    const app = await bootApp();
    const listRes = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    const [parent] = await listRes.json() as Array<{ id: string }>;

    const childRes = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Child', parentId: parent.id }),
    });
    const child = await childRes.json() as { id: string };

    // Try to move parent under its own child -- must be rejected.
    const res = await fetch(`${app.baseUrl}/category/${parent.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ parentId: child.id }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/category/does-not-exist`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /category/:id', () => {
  it('deletes a leaf category', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Temp' }),
    });
    const { id } = await createRes.json() as { id: string };

    const delRes = await fetch(`${app.baseUrl}/category/${id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(200);

    const row = app.db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('blocks deleting a category that has children', async () => {
    const app = await bootApp();
    const listRes = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    const [parent] = await listRes.json() as Array<{ id: string }>;
    await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Child', parentId: parent.id }),
    });

    const delRes = await fetch(`${app.baseUrl}/category/${parent.id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(400);

    const row = app.db.prepare('SELECT id FROM categories WHERE id = ?').get(parent.id);
    expect(row).toBeTruthy(); // still there -- delete was blocked, not silently applied
  });

  it('nulls out models.category_id via the FK when a referenced category is deleted (no children)', async () => {
    const app = await bootApp();
    const createCatRes = await fetch(`${app.baseUrl}/categories`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Doomed' }),
    });
    const { id: catId } = await createCatRes.json() as { id: string };

    // Insert a model referencing this category directly -- models.ts is
    // a separate router not registered in this fixture, so we go
    // straight to the DB the same way models.test.ts's insertAsset does.
    const modelId = 'model-1';
    app.db.prepare(
      `INSERT INTO models (id, title, category_id, owner_id, visibility)
       VALUES (?, 'Categorized Thing', ?, (SELECT id FROM users LIMIT 1), 'public')`
    ).run(modelId, catId);

    const delRes = await fetch(`${app.baseUrl}/category/${catId}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(200);

    const modelRow = app.db.prepare('SELECT category_id FROM models WHERE id = ?').get(modelId) as { category_id: string | null };
    expect(modelRow.category_id).toBeNull();
  });

  it('404s for an unknown id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/category/does-not-exist`, { method: 'DELETE', headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });

  it('401s with no token', async () => {
    const app = await bootApp();
    const listRes = await fetch(`${app.baseUrl}/categories`, { headers: bearer(app.token) });
    const [cat] = await listRes.json() as Array<{ id: string }>;
    const res = await fetch(`${app.baseUrl}/category/${cat.id}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
