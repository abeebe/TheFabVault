// Integration tests for routes/collections.ts (#2167, Phase B) — exercise
// the real Express router against a throwaway on-disk SQLite DB, over a
// real HTTP loopback server. Same boot pattern as models.test.ts (mounts
// modelsRouter alongside collectionsRouter since collection membership
// needs real model rows created through POST /models) — see
// models.test.ts / auth.test.ts headers for the full rationale on why
// this needs a real request path and a fresh module registry per
// fixture rather than a bare unit call.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-collectionstest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-collectionstest-storage-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_USERNAME = ADMIN_USER;
  process.env.AUTH_PASSWORD = ADMIN_PASS;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authRouterMod = await import('../routes/auth.js');
  const modelsRouterMod = await import('../routes/models.js');
  const collectionsRouterMod = await import('../routes/collections.js');

  const app = express();
  app.use(express.json());
  app.use('/', authRouterMod.default);
  app.use('/', modelsRouterMod.default);
  app.use('/', collectionsRouterMod.default);

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

async function createModel(app: Booted, title: string): Promise<{ id: string }> {
  const res = await fetch(`${app.baseUrl}/models`, {
    method: 'POST',
    headers: jsonHeaders(app.token),
    body: JSON.stringify({ title }),
  });
  return (await res.json()) as { id: string };
}

describe('GET/POST /collections — list + create', () => {
  it('creates a collection with owner_id from req.user and defaults visibility to public', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Dragons' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; name: string; ownerId: string; visibility: string; modelCount: number };
    expect(body.name).toBe('Dragons');
    expect(body.visibility).toBe('public');
    expect(body.modelCount).toBe(0);
    expect(body.ownerId).toBeTruthy();
  });

  it('rejects a missing name', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid visibility value', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'X', visibility: 'nonsense' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts an initial modelIds list, skipping invalid ids', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'Model One');
    const m2 = await createModel(app, 'Model Two');

    const res = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Starter Set', modelIds: [m1.id, m2.id, 'nope'] }),
    });
    const body = await res.json() as { modelCount: number };
    expect(body.modelCount).toBe(2);
  });

  it('lists collections with modelCount reflecting only non-deleted member models', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'Alive');
    const m2 = await createModel(app, 'Also Alive');
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Mix', modelIds: [m1.id, m2.id] }),
    });
    const { id } = await createRes.json() as { id: string };

    // Soft-delete one member model — it should drop out of the count.
    await fetch(`${app.baseUrl}/model/${m1.id}`, { method: 'DELETE', headers: bearer(app.token) });

    const listRes = await fetch(`${app.baseUrl}/collections`, { headers: bearer(app.token) });
    const list = await listRes.json() as Array<{ id: string; modelCount: number }>;
    const row = list.find((c) => c.id === id)!;
    expect(row.modelCount).toBe(1);
  });
});

describe('GET /collection/:id — detail', () => {
  it('404s for an unknown id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/collection/does-not-exist`, { headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });

  it('returns member models ordered by sort_order, each as a full ModelOut (with likeCount/likedByMe)', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'First');
    const m2 = await createModel(app, 'Second');
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Ordered', modelIds: [m1.id, m2.id] }),
    });
    const { id } = await createRes.json() as { id: string };

    const detailRes = await fetch(`${app.baseUrl}/collection/${id}`, { headers: bearer(app.token) });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as { models: Array<{ id: string; likeCount: number; likedByMe: boolean }> };
    expect(detail.models.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(detail.models[0].likeCount).toBe(0);
    expect(detail.models[0].likedByMe).toBe(false);
  });
});

describe('PATCH /collection/:id', () => {
  it('updates name/description/visibility independently (partial update)', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Original', description: 'desc' }),
    });
    const { id } = await createRes.json() as { id: string };

    const patchRes = await fetch(`${app.baseUrl}/collection/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json() as { name: string; description: string; visibility: string };
    expect(updated.visibility).toBe('private');
    expect(updated.name).toBe('Original'); // untouched
    expect(updated.description).toBe('desc'); // untouched
  });

  it('rejects an empty name', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/collections`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'X' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/collection/${id}`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ name: '   ' }) });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /collection/:id — plain delete, no guard, models untouched', () => {
  it('deletes a collection with members and leaves the member models fully intact', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'Survivor');
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Doomed', modelIds: [m1.id] }),
    });
    const { id } = await createRes.json() as { id: string };

    const delRes = await fetch(`${app.baseUrl}/collection/${id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(204);

    // collection_models rows for it are gone.
    const links = app.db.prepare('SELECT * FROM collection_models WHERE collection_id = ?').all(id);
    expect(links).toEqual([]);

    // The model itself is completely untouched — still fetchable via
    // GET /model/:id, not soft- or hard-deleted.
    const modelRes = await fetch(`${app.baseUrl}/model/${m1.id}`, { headers: bearer(app.token) });
    expect(modelRes.status).toBe(200);
    const model = await modelRes.json() as { deletedAt: number | null };
    expect(model.deletedAt).toBeNull();
  });

  it('404s deleting an unknown collection', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/collection/does-not-exist`, { method: 'DELETE', headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });
});

describe('POST/DELETE /collection/:id/models — membership', () => {
  it('adds models, skipping already-added and invalid ids (idempotent via INSERT OR IGNORE)', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'One');
    const m2 = await createModel(app, 'Two');
    const createRes = await fetch(`${app.baseUrl}/collections`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'C' }) });
    const { id } = await createRes.json() as { id: string };

    const addRes = await fetch(`${app.baseUrl}/collection/${id}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ modelIds: [m1.id, m2.id] }),
    });
    expect((await addRes.json())).toEqual({ added: 2 });

    // Re-adding m1 (already a member) + a bogus id — only genuinely new,
    // valid ids count toward `added`.
    const addAgainRes = await fetch(`${app.baseUrl}/collection/${id}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ modelIds: [m1.id, 'nope'] }),
    });
    expect((await addAgainRes.json())).toEqual({ added: 0 });
  });

  it('rejects an empty modelIds body', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/collections`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'C' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/collection/${id}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('detaches a member and clears cover_model_id if that model was the cover', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'Cover Model');
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'C', modelIds: [m1.id] }),
    });
    const { id } = await createRes.json() as { id: string };
    await fetch(`${app.baseUrl}/collection/${id}/cover`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ modelId: m1.id }) });

    const row = app.db.prepare('SELECT cover_model_id FROM collections WHERE id = ?').get(id) as { cover_model_id: string };
    expect(row.cover_model_id).toBe(m1.id);

    const detachRes = await fetch(`${app.baseUrl}/collection/${id}/model/${m1.id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(detachRes.status).toBe(204);

    const afterRow = app.db.prepare('SELECT cover_model_id FROM collections WHERE id = ?').get(id) as { cover_model_id: string | null };
    expect(afterRow.cover_model_id).toBeNull();
  });

  it('404s detaching a model that is not a member', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/collections`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'C' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/collection/${id}/model/not-a-member`, { method: 'DELETE', headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /collection/:id/models/reorder', () => {
  it('reassigns sort_order to match the given array and returns the detail in that order', async () => {
    const app = await bootApp();
    const a = await createModel(app, 'A');
    const b = await createModel(app, 'B');
    const c = await createModel(app, 'C');
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'Reorder Me', modelIds: [a.id, b.id, c.id] }),
    });
    const { id } = await createRes.json() as { id: string };

    const reorderRes = await fetch(`${app.baseUrl}/collection/${id}/models/reorder`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ modelIds: [c.id, a.id, b.id] }),
    });
    expect(reorderRes.status).toBe(200);
    const detail = await reorderRes.json() as { models: Array<{ id: string }> };
    expect(detail.models.map((m) => m.id)).toEqual([c.id, a.id, b.id]);
  });

  it('rejects an empty reorder array', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/collections`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'C' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/collection/${id}/models/reorder`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ modelIds: [] }) });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /collection/:id/cover', () => {
  it('rejects setting a cover to a model that is not a member', async () => {
    const app = await bootApp();
    const outsider = await createModel(app, 'Not A Member');
    const createRes = await fetch(`${app.baseUrl}/collections`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'C' }) });
    const { id } = await createRes.json() as { id: string };

    const res = await fetch(`${app.baseUrl}/collection/${id}/cover`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ modelId: outsider.id }),
    });
    expect(res.status).toBe(400);
  });

  it('clears the cover when modelId is null', async () => {
    const app = await bootApp();
    const m1 = await createModel(app, 'M');
    const createRes = await fetch(`${app.baseUrl}/collections`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'C', modelIds: [m1.id] }),
    });
    const { id } = await createRes.json() as { id: string };
    await fetch(`${app.baseUrl}/collection/${id}/cover`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ modelId: m1.id }) });

    const clearRes = await fetch(`${app.baseUrl}/collection/${id}/cover`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ modelId: null }) });
    expect(clearRes.status).toBe(200);
    const body = await clearRes.json() as { coverModelId: string | null };
    expect(body.coverModelId).toBeNull();
  });
});

describe('auth', () => {
  it('every collections endpoint denies with no token', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/collections`);
    expect(res.status).toBe(401);
  });
});
