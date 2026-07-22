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
import { v4 as uuidv4 } from 'uuid';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { hashPassword } from '../passwords.js';

interface Booted {
  baseUrl: string;
  token: string;
  db: Database.Database;
  storageDir: string;
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
    storageDir,
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

// Real login, same convention as models.test.ts / modelImport.test.ts's
// createMemberUser — kept as its own local copy per this suite's
// established one-helper-per-test-file pattern.
async function createMemberUser(app: Booted, username: string): Promise<{ token: string; userId: string }> {
  const userId = uuidv4();
  const password = 'correct-horse-battery-staple-2';
  app.db.prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'member')"
  ).run(userId, username, hashPassword(password));

  const loginRes = await fetch(`${app.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (loginRes.status !== 200) throw new Error(`test setup: member login failed with ${loginRes.status}`);
  const { token } = await loginRes.json() as { token: string };
  return { token, userId };
}

async function createModelAs(
  app: Booted, token: string, opts: { title: string; visibility?: 'public' | 'private' },
): Promise<{ id: string; ownerId: string; visibility: string }> {
  const res = await fetch(`${app.baseUrl}/models`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ title: opts.title, visibility: opts.visibility }),
  });
  return (await res.json()) as { id: string; ownerId: string; visibility: string };
}

// Gives a model a REAL resolvable coverThumbUrl end-to-end: inserts an
// asset row with thumb_status='done', writes an actual stub file at the
// same thumbFilePath() thumbExists() checks (storageDir/thumbs/<id>.jpg
// — see services/fileStore.ts), attaches it to the model as role=image,
// and sets it as that model's cover_asset_id. Needed for the cover-thumb
// visibility regression test below — without a real file on disk,
// resolveModelCoverThumb's thumbExists() gate always returns null
// regardless of the visibility fix being tested.
async function giveModelACoverThumb(app: Booted, token: string, modelId: string): Promise<string> {
  const assetId = uuidv4();
  app.db.prepare(
    "INSERT INTO assets (id, filename, mime, size, thumb_status) VALUES (?, 'cover.png', 'image/png', 10, 'done')"
  ).run(assetId);
  const thumbsDir = path.join(app.storageDir, 'thumbs');
  fs.mkdirSync(thumbsDir, { recursive: true });
  fs.writeFileSync(path.join(thumbsDir, `${assetId}.jpg`), 'stub-thumb-bytes');

  await fetch(`${app.baseUrl}/model/${modelId}/files`, {
    method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ assetIds: [assetId], role: 'image' }),
  });
  await fetch(`${app.baseUrl}/model/${modelId}/cover`, {
    method: 'PATCH', headers: jsonHeaders(token), body: JSON.stringify({ assetId }),
  });
  return assetId;
}

async function createCollectionAs(
  app: Booted, token: string, opts: { name: string; visibility?: 'public' | 'private'; modelIds?: string[] },
): Promise<{ id: string; ownerId: string; visibility: string }> {
  const res = await fetch(`${app.baseUrl}/collections`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ name: opts.name, visibility: opts.visibility, modelIds: opts.modelIds }),
  });
  return (await res.json()) as { id: string; ownerId: string; visibility: string };
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

// ─── Visibility / ownership authz matrix (#2179, Phase D3) ────────────────────
//
// Same two-rule split as routes/models.ts's matrix (see that file's test
// suite header): READ (visibility) governs list/detail; WRITE
// (ownership) governs everything that mutates a collection or its
// membership. The bootApp() seeded user (app.token) is always admin.
describe('Visibility / ownership authz matrix (#2179)', () => {
  it('GET /collections list — member sees public + own private, never another member\'s private; admin sees everything', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const aPublic = await createCollectionAs(app, memberA.token, { name: 'A Public', visibility: 'public' });
    const aPrivate = await createCollectionAs(app, memberA.token, { name: 'A Private', visibility: 'private' });

    const asB = await fetch(`${app.baseUrl}/collections`, { headers: bearer(memberB.token) });
    const bIds = (await asB.json() as Array<{ id: string }>).map((c) => c.id);
    expect(bIds).toContain(aPublic.id);
    expect(bIds).not.toContain(aPrivate.id);

    const asA = await fetch(`${app.baseUrl}/collections`, { headers: bearer(memberA.token) });
    const aIds = (await asA.json() as Array<{ id: string }>).map((c) => c.id);
    expect(aIds).toContain(aPublic.id);
    expect(aIds).toContain(aPrivate.id);

    const asAdmin = await fetch(`${app.baseUrl}/collections`, { headers: bearer(app.token) });
    const adminIds = (await asAdmin.json() as Array<{ id: string }>).map((c) => c.id);
    expect(adminIds).toContain(aPublic.id);
    expect(adminIds).toContain(aPrivate.id);
  });

  it('GET /collection/:id detail — 404s a private collection for a non-owner, 200s a public one, 200s private for owner/admin', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const priv = await createCollectionAs(app, memberA.token, { name: 'Secret Collection', visibility: 'private' });
    const pub = await createCollectionAs(app, memberA.token, { name: 'Open Collection', visibility: 'public' });

    const privByB = await fetch(`${app.baseUrl}/collection/${priv.id}`, { headers: bearer(memberB.token) });
    expect(privByB.status).toBe(404);

    const pubByB = await fetch(`${app.baseUrl}/collection/${pub.id}`, { headers: bearer(memberB.token) });
    expect(pubByB.status).toBe(200);

    const privByOwner = await fetch(`${app.baseUrl}/collection/${priv.id}`, { headers: bearer(memberA.token) });
    expect(privByOwner.status).toBe(200);

    const privByAdmin = await fetch(`${app.baseUrl}/collection/${priv.id}`, { headers: bearer(app.token) });
    expect(privByAdmin.status).toBe(200);
  });

  it('private-model-in-a-public-collection: a non-owner viewing GET /collection/:id sees only the visible member models, and modelCount reflects that filtered count (not the true total) — the stated decision', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const publicModel = await createModelAs(app, memberA.token, { title: 'Visible Part', visibility: 'public' });
    const privateModel = await createModelAs(app, memberA.token, { title: 'Secret Part', visibility: 'private' });
    const collection = await createCollectionAs(app, memberA.token, {
      name: 'Mixed Collection', visibility: 'public', modelIds: [publicModel.id, privateModel.id],
    });

    const asB = await fetch(`${app.baseUrl}/collection/${collection.id}`, { headers: bearer(memberB.token) });
    expect(asB.status).toBe(200);
    const bBody = await asB.json() as { modelCount: number; models: Array<{ id: string; title: string }> };
    expect(bBody.models.map((m) => m.id)).toEqual([publicModel.id]);
    expect(bBody.models.map((m) => m.title)).not.toContain('Secret Part');
    expect(bBody.modelCount).toBe(1);

    // Owner and admin see the true total, including the private member.
    const asOwner = await fetch(`${app.baseUrl}/collection/${collection.id}`, { headers: bearer(memberA.token) });
    const ownerBody = await asOwner.json() as { modelCount: number; models: Array<{ id: string }> };
    expect(ownerBody.models.map((m) => m.id).sort()).toEqual([privateModel.id, publicModel.id].sort());
    expect(ownerBody.modelCount).toBe(2);

    const asAdmin = await fetch(`${app.baseUrl}/collection/${collection.id}`, { headers: bearer(app.token) });
    const adminBody = await asAdmin.json() as { modelCount: number };
    expect(adminBody.modelCount).toBe(2);
  });

  it('GET /collections list — modelCount for the same mixed collection is consistent with the detail view per viewer (1 for a non-owner, 2 for owner/admin)', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const publicModel = await createModelAs(app, memberA.token, { title: 'Visible Part', visibility: 'public' });
    const privateModel = await createModelAs(app, memberA.token, { title: 'Secret Part', visibility: 'private' });
    const collection = await createCollectionAs(app, memberA.token, {
      name: 'Mixed Collection', visibility: 'public', modelIds: [publicModel.id, privateModel.id],
    });

    const listAsB = await fetch(`${app.baseUrl}/collections`, { headers: bearer(memberB.token) });
    const bRow = (await listAsB.json() as Array<{ id: string; modelCount: number }>).find((c) => c.id === collection.id)!;
    expect(bRow.modelCount).toBe(1);

    const listAsOwner = await fetch(`${app.baseUrl}/collections`, { headers: bearer(memberA.token) });
    const ownerRow = (await listAsOwner.json() as Array<{ id: string; modelCount: number }>).find((c) => c.id === collection.id)!;
    expect(ownerRow.modelCount).toBe(2);
  });

  it('PATCH /collection/:id — a non-owner member 404s editing even a PUBLIC collection; owner and admin succeed', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const collection = await createCollectionAs(app, memberA.token, { name: 'Open', visibility: 'public' });

    const byB = await fetch(`${app.baseUrl}/collection/${collection.id}`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(byB.status).toBe(404);

    const byOwner = await fetch(`${app.baseUrl}/collection/${collection.id}`, {
      method: 'PATCH', headers: jsonHeaders(memberA.token), body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(byOwner.status).toBe(200);

    const byAdmin = await fetch(`${app.baseUrl}/collection/${collection.id}`, {
      method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'Admin Renamed' }),
    });
    expect(byAdmin.status).toBe(200);
  });

  it('DELETE /collection/:id — a non-owner member 404s, owner succeeds, admin succeeds on another member\'s collection', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const ownColl = await createCollectionAs(app, memberA.token, { name: 'Mine', visibility: 'public' });

    const byB = await fetch(`${app.baseUrl}/collection/${ownColl.id}`, { method: 'DELETE', headers: bearer(memberB.token) });
    expect(byB.status).toBe(404);

    const byOwner = await fetch(`${app.baseUrl}/collection/${ownColl.id}`, { method: 'DELETE', headers: bearer(memberA.token) });
    expect(byOwner.status).toBe(204);

    const adminTarget = await createCollectionAs(app, memberA.token, { name: 'Admin Target', visibility: 'private' });
    const byAdmin = await fetch(`${app.baseUrl}/collection/${adminTarget.id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(byAdmin.status).toBe(204);
  });

  it('POST /collection/:id/models (add member) and DELETE .../model/:modelId (remove member) — 404 for a non-owner on a PUBLIC collection', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const collection = await createCollectionAs(app, memberA.token, { name: 'Open', visibility: 'public' });
    const model = await createModel(app, 'Some Model');

    const addByB = await fetch(`${app.baseUrl}/collection/${collection.id}/models`, {
      method: 'POST', headers: jsonHeaders(memberB.token), body: JSON.stringify({ modelIds: [model.id] }),
    });
    expect(addByB.status).toBe(404);

    // Owner adds it for real, then B tries to remove it.
    await fetch(`${app.baseUrl}/collection/${collection.id}/models`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ modelIds: [model.id] }),
    });
    const removeByB = await fetch(`${app.baseUrl}/collection/${collection.id}/model/${model.id}`, {
      method: 'DELETE', headers: bearer(memberB.token),
    });
    expect(removeByB.status).toBe(404);

    const removeByOwner = await fetch(`${app.baseUrl}/collection/${collection.id}/model/${model.id}`, {
      method: 'DELETE', headers: bearer(memberA.token),
    });
    expect(removeByOwner.status).toBe(204);
  });

  it('PATCH /collection/:id/models/reorder and PATCH .../cover — 404 for a non-owner on a PUBLIC collection', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const model = await createModel(app, 'M');
    const collection = await createCollectionAs(app, memberA.token, { name: 'Open', visibility: 'public', modelIds: [model.id] });

    const reorderByB = await fetch(`${app.baseUrl}/collection/${collection.id}/models/reorder`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ modelIds: [model.id] }),
    });
    expect(reorderByB.status).toBe(404);

    const coverByB = await fetch(`${app.baseUrl}/collection/${collection.id}/cover`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ modelId: model.id }),
    });
    expect(coverByB.status).toBe(404);

    const reorderByOwner = await fetch(`${app.baseUrl}/collection/${collection.id}/models/reorder`, {
      method: 'PATCH', headers: jsonHeaders(memberA.token), body: JSON.stringify({ modelIds: [model.id] }),
    });
    expect(reorderByOwner.status).toBe(200);
  });

  it('single-admin UX does not regress: admin bypasses both the visibility fragment and the ownership check on every collection operation', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const priv = await createCollectionAs(app, memberA.token, { name: 'Admin Sees All', visibility: 'private' });

    const listRes = await fetch(`${app.baseUrl}/collections`, { headers: bearer(app.token) });
    const ids = (await listRes.json() as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(priv.id);

    const detailRes = await fetch(`${app.baseUrl}/collection/${priv.id}`, { headers: bearer(app.token) });
    expect(detailRes.status).toBe(200);

    const patchRes = await fetch(`${app.baseUrl}/collection/${priv.id}`, {
      method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'Admin Edited' }),
    });
    expect(patchRes.status).toBe(200);
  });

  // ─── Remy round #2179: cover-thumb visibility leak + membership-add gate ─────
  //
  // Real finding: the `models[]` array on a collection's own detail/list
  // response was already visibility-filtered, but `coverThumbUrl` was
  // resolved with NO viewer check at all — a private model set as a
  // public collection's cover leaked its thumbnail to every viewer even
  // though that same model correctly never showed up in `models[]`.
  // Fixed by threading VisibilityContext into resolveCollectionCoverThumb
  // (both the explicit cover_model_id branch and the membership-scan
  // fallback) — see routes/collections.ts's comment on that function.

  it('a PRIVATE model set as a PUBLIC collection\'s cover: coverThumbUrl is null for a non-owner, but resolves to the real thumb for owner/admin', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const privCoverModel = await createModelAs(app, memberA.token, { title: 'Secret Cover Source', visibility: 'private' });
    const coverAssetId = await giveModelACoverThumb(app, memberA.token, privCoverModel.id);
    const expectedThumbUrl = `/thumb/${coverAssetId}.jpg`;

    // A can add their OWN private model to their OWN public collection
    // (visibleModelExists passes via the owner branch) and set it as
    // that collection's cover (same reasoning).
    const collection = await createCollectionAs(app, memberA.token, {
      name: 'Public Collection, Private Cover Source', visibility: 'public', modelIds: [privCoverModel.id],
    });
    const coverSetRes = await fetch(`${app.baseUrl}/collection/${collection.id}/cover`, {
      method: 'PATCH', headers: jsonHeaders(memberA.token), body: JSON.stringify({ modelId: privCoverModel.id }),
    });
    expect(coverSetRes.status).toBe(200);

    // Non-owner: the cover source model is invisible to B — no thumb leak,
    // and no fallback candidate exists either (it's the only member).
    const detailAsB = await fetch(`${app.baseUrl}/collection/${collection.id}`, { headers: bearer(memberB.token) });
    const bodyB = await detailAsB.json() as { coverThumbUrl: string | null; models: unknown[] };
    expect(bodyB.coverThumbUrl).toBeNull();
    expect(bodyB.models).toEqual([]); // already-covered behavior, re-asserted for context

    const listAsB = await fetch(`${app.baseUrl}/collections`, { headers: bearer(memberB.token) });
    const listRowB = (await listAsB.json() as Array<{ id: string; coverThumbUrl: string | null }>).find((c) => c.id === collection.id)!;
    expect(listRowB.coverThumbUrl).toBeNull();

    // Owner sees the real thumb, both in detail and list.
    const detailAsOwner = await fetch(`${app.baseUrl}/collection/${collection.id}`, { headers: bearer(memberA.token) });
    const bodyOwner = await detailAsOwner.json() as { coverThumbUrl: string | null };
    expect(bodyOwner.coverThumbUrl).toBe(expectedThumbUrl);

    const listAsOwner = await fetch(`${app.baseUrl}/collections`, { headers: bearer(memberA.token) });
    const listRowOwner = (await listAsOwner.json() as Array<{ id: string; coverThumbUrl: string | null }>).find((c) => c.id === collection.id)!;
    expect(listRowOwner.coverThumbUrl).toBe(expectedThumbUrl);

    // Admin sees the real thumb too.
    const detailAsAdmin = await fetch(`${app.baseUrl}/collection/${collection.id}`, { headers: bearer(app.token) });
    const bodyAdmin = await detailAsAdmin.json() as { coverThumbUrl: string | null };
    expect(bodyAdmin.coverThumbUrl).toBe(expectedThumbUrl);
  });

  it('POST /collection/:id/models silently excludes a model the caller cannot see — no collection_models row is ever created for it (existence-hiding on a bulk endpoint: same contract this endpoint already had for a bogus id, extended to invisible-to-me ids)', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const aPrivateModel = await createModelAs(app, memberA.token, { title: 'A\'s Secret', visibility: 'private' });
    const bCollection = await createCollectionAs(app, memberB.token, { name: 'B\'s Collection', visibility: 'public' });

    // B tries to blind-attach A's private model (guessing its UUID) to
    // B's own collection — must not succeed.
    const addRes = await fetch(`${app.baseUrl}/collection/${bCollection.id}/models`, {
      method: 'POST', headers: jsonHeaders(memberB.token), body: JSON.stringify({ modelIds: [aPrivateModel.id] }),
    });
    expect(addRes.status).toBe(200);
    expect(await addRes.json()).toEqual({ added: 0 });

    const row = app.db.prepare('SELECT 1 FROM collection_models WHERE collection_id = ? AND model_id = ?')
      .get(bCollection.id, aPrivateModel.id);
    expect(row).toBeUndefined();

    // A public model IS attachable by a non-owner — proves the rejection
    // above was visibility-specific, not a general breakage.
    const bPublicModel = await createModelAs(app, memberA.token, { title: 'A\'s Public', visibility: 'public' });
    const addPublicRes = await fetch(`${app.baseUrl}/collection/${bCollection.id}/models`, {
      method: 'POST', headers: jsonHeaders(memberB.token), body: JSON.stringify({ modelIds: [bPublicModel.id] }),
    });
    expect(await addPublicRes.json()).toEqual({ added: 1 });
  });

  it('PATCH /collection/:id/cover rejects setting the cover to a member model the caller cannot see, even though it genuinely IS a member', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    // A owns a private model. B owns a public collection. Only ADMIN can
    // bridge them (admin bypasses both the collection-ownership gate on
    // POST .../models AND the model-visibility gate baked into
    // visibleModelExists) — this is the only way A's private model ends
    // up a genuine member of B's collection without A or B being able to
    // see across the boundary themselves. That's exactly the shape this
    // fix targets: membership existing is not the same as visibility.
    const privateModel = await createModelAs(app, memberA.token, { title: 'A\'s Private Model', visibility: 'private' });
    const collection = await createCollectionAs(app, memberB.token, { name: 'B\'s Collection', visibility: 'public' });
    const adminAddRes = await fetch(`${app.baseUrl}/collection/${collection.id}/models`, {
      method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ modelIds: [privateModel.id] }),
    });
    expect(await adminAddRes.json()).toEqual({ added: 1 });

    // Confirm it's a genuine member before testing the cover rejection —
    // otherwise a 400 here would be ambiguous (not-a-member vs
    // member-but-invisible).
    const memberRow = app.db.prepare('SELECT 1 FROM collection_models WHERE collection_id = ? AND model_id = ?')
      .get(collection.id, privateModel.id);
    expect(memberRow).toBeTruthy();

    // B owns the collection (passes the write/ownership gate) but cannot
    // SEE A's private model — the cover-set must still be rejected.
    const coverByB = await fetch(`${app.baseUrl}/collection/${collection.id}/cover`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ modelId: privateModel.id }),
    });
    expect(coverByB.status).toBe(400);
    const collRow = app.db.prepare('SELECT cover_model_id FROM collections WHERE id = ?').get(collection.id) as { cover_model_id: string | null };
    expect(collRow.cover_model_id).toBeNull();

    // Admin, who can see everything, succeeds at the exact same call.
    const coverByAdmin = await fetch(`${app.baseUrl}/collection/${collection.id}/cover`, {
      method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ modelId: privateModel.id }),
    });
    expect(coverByAdmin.status).toBe(200);

    // A (the model's own owner) can see it too, even without owning the
    // collection — but A doesn't own the COLLECTION, so this correctly
    // 404s on the write/ownership gate first, not the visibility gate.
    const coverByModelOwner = await fetch(`${app.baseUrl}/collection/${collection.id}/cover`, {
      method: 'PATCH', headers: jsonHeaders(memberA.token), body: JSON.stringify({ modelId: privateModel.id }),
    });
    expect(coverByModelOwner.status).toBe(404);
  });
});
