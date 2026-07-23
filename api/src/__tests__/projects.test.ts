// Integration tests for routes/projects.ts. Newly added file (#2188) — the
// router previously had no dedicated test coverage at all. Same boot
// pattern as models.test.ts (module-level singletons in db.ts/fileStore.ts
// mean this needs a real request path over a real HTTP loopback server,
// not a bare unit call) — see that file's header for the full rationale.
//
// Scope: GET /project/:id's deleted_at gap (#2188, "the sibling gap flagged
// during #2027") plus a minimal smoke pass over the rest of the router so
// the new file isn't a single-purpose regression test masquerading as full
// coverage.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-projectstest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-projectstest-storage-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_USERNAME = ADMIN_USER;
  process.env.AUTH_PASSWORD = ADMIN_PASS;

  // config.ts's dataDir/storageDir are read from process.env once at
  // module load (module-level const, not a per-call getter), so a fresh
  // module registry per bootApp() is required — otherwise every test in
  // this file after the first would share the first test's DB/storage
  // dir. Same convention as models.test.ts's bootApp.
  vi.resetModules();

  const dbMod = await import('../db.js');
  const authRouterMod = await import('../routes/auth.js');
  const projectsRouterMod = await import('../routes/projects.js');

  const app = express();
  app.use(express.json());
  app.use('/', authRouterMod.default);
  app.use('/', projectsRouterMod.default);

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

// Inserts an asset row directly (bypassing /upload), same convention as
// models.test.ts's insertAsset.
function insertAsset(app: Booted, filename: string, deleted = false): string {
  const id = uuidv4();
  app.db.prepare(
    `INSERT INTO assets (id, filename, mime, size, deleted_at)
     VALUES (?, ?, 'application/octet-stream', 0, ?)`
  ).run(id, filename, deleted ? Math.floor(Date.now() / 1000) : null);
  return id;
}

async function createProject(app: Booted, name = 'Test Project'): Promise<string> {
  const res = await fetch(`${app.baseUrl}/projects`, {
    method: 'POST',
    headers: jsonHeaders(app.token),
    body: JSON.stringify({ name }),
  });
  const body = await res.json() as { id: string };
  return body.id;
}

function addAssetToProject(app: Booted, projectId: string, assetId: string): void {
  app.db.prepare(
    `INSERT INTO project_assets (project_id, asset_id, sort_order, overrides_json)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_assets WHERE project_id = ?), '{}')`
  ).run(projectId, assetId, projectId);
}

function softDeleteAsset(app: Booted, assetId: string): void {
  app.db.prepare('UPDATE assets SET deleted_at = unixepoch() WHERE id = ?').run(assetId);
}

describe('GET/POST /projects — list + create', () => {
  it('creates a project and lists it back with assetCount 0', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/projects`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'R2D2 Build' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; name: string; assetCount: number };
    expect(body.name).toBe('R2D2 Build');
    expect(body.assetCount).toBe(0);

    const listRes = await fetch(`${app.baseUrl}/projects`, { headers: bearer(app.token) });
    const list = await listRes.json() as Array<{ id: string }>;
    expect(list.some((p) => p.id === body.id)).toBe(true);
  });

  it('rejects a missing name', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/projects`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /project/:id — asset list deleted_at filter (#2188)', () => {
  it('a live asset appears in the detail assets list', async () => {
    const app = await bootApp();
    const projectId = await createProject(app);
    const asset = insertAsset(app, 'live.stl');
    addAssetToProject(app, projectId, asset);

    const res = await fetch(`${app.baseUrl}/project/${projectId}`, { headers: bearer(app.token) });
    const body = await res.json() as { assets: Array<{ id: string }>; assetCount: number };
    expect(body.assets.map((a) => a.id)).toEqual([asset]);
    expect(body.assetCount).toBe(1);
  });

  // The #2188 regression itself: routes/projects.ts's GET /project/:id
  // joined project_assets -> assets for the detail asset list WITHOUT
  // `deleted_at IS NULL` (the sibling gap flagged during #2027, which
  // fixed the equivalent join in services/manifestRollup.ts). A
  // soft-deleted asset never leaves project_assets, so a trashed asset
  // kept surfacing in the project detail view — and inflating
  // assetCount, since assetCount here is derived from the same joined
  // list (assets.length), not a separate query.
  it('a soft-deleted (trashed) asset drops out of the detail assets list, and out of assetCount', async () => {
    const app = await bootApp();
    const projectId = await createProject(app);
    const live = insertAsset(app, 'live.stl');
    const trashed = insertAsset(app, 'trashed.stl');
    addAssetToProject(app, projectId, live);
    addAssetToProject(app, projectId, trashed);

    // Confirm it's present before trashing, precisely to prove the
    // subsequent disappearance is caused by the delete, not by never
    // having been added.
    const beforeRes = await fetch(`${app.baseUrl}/project/${projectId}`, { headers: bearer(app.token) });
    const before = await beforeRes.json() as { assets: Array<{ id: string }>; assetCount: number };
    expect(before.assets.map((a) => a.id).sort()).toEqual([live, trashed].sort());
    expect(before.assetCount).toBe(2);

    softDeleteAsset(app, trashed);

    const afterRes = await fetch(`${app.baseUrl}/project/${projectId}`, { headers: bearer(app.token) });
    const after = await afterRes.json() as { assets: Array<{ id: string }>; assetCount: number };
    expect(after.assets.map((a) => a.id)).toEqual([live]);
    expect(after.assets.some((a) => a.id === trashed)).toBe(false);
    expect(after.assetCount).toBe(1);

    // project_assets row itself is untouched — soft-delete on the asset
    // never removes the join row (routes/assets.ts's DELETE handler);
    // the filter is what hides it, not a cascading delete.
    const paRow = app.db.prepare(
      'SELECT 1 FROM project_assets WHERE project_id = ? AND asset_id = ?'
    ).get(projectId, trashed);
    expect(paRow).toBeTruthy();
  });

  it('404s for an unknown project id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/project/${uuidv4()}`, { headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });
});

describe('POST /project/:id/assets + DELETE /project/:id/asset/:assetId', () => {
  it('adds assets to a project and can remove one', async () => {
    const app = await bootApp();
    const projectId = await createProject(app);
    const a = insertAsset(app, 'a.stl');
    const b = insertAsset(app, 'b.stl');

    const addRes = await fetch(`${app.baseUrl}/project/${projectId}/assets`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetIds: [a, b] }),
    });
    expect(addRes.status).toBe(204);

    const detailRes = await fetch(`${app.baseUrl}/project/${projectId}`, { headers: bearer(app.token) });
    const detail = await detailRes.json() as { assets: Array<{ id: string }> };
    expect(detail.assets.map((x) => x.id).sort()).toEqual([a, b].sort());

    const removeRes = await fetch(`${app.baseUrl}/project/${projectId}/asset/${a}`, {
      method: 'DELETE', headers: bearer(app.token),
    });
    expect(removeRes.status).toBe(204);

    const afterRes = await fetch(`${app.baseUrl}/project/${projectId}`, { headers: bearer(app.token) });
    const after = await afterRes.json() as { assets: Array<{ id: string }> };
    expect(after.assets.map((x) => x.id)).toEqual([b]);
  });
});

describe('auth', () => {
  it('every projects endpoint denies with no token', async () => {
    const app = await bootApp();
    const projectId = await createProject(app);
    const noAuth = { headers: { 'Content-Type': 'application/json' } };
    const results = await Promise.all([
      fetch(`${app.baseUrl}/projects`, noAuth),
      fetch(`${app.baseUrl}/project/${projectId}`, noAuth),
    ]);
    for (const res of results) expect(res.status).toBe(401);
  });
});
