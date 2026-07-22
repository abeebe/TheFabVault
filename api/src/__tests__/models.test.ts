// Integration tests for routes/models.ts (#2155) — exercise the real
// Express router against a throwaway on-disk SQLite DB + storage dir,
// over a real HTTP loopback server. Same boot pattern as auth.test.ts
// (module-level singletons in db.ts/fileStore.ts mean this needs a real
// request path and a fresh module registry per fixture, not a bare unit
// call) — see that file's header for the full rationale.
//
// Fixture assets are inserted directly into the DB (bypassing the
// multipart /upload flow) for setup speed; the one place a real file on
// disk matters (zip download, dedup-by-hash) writes bytes directly via
// fs, exactly what saveUploadedFile itself would have done.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-modelstest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-modelstest-storage-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_USERNAME = ADMIN_USER;
  process.env.AUTH_PASSWORD = ADMIN_PASS;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authRouterMod = await import('../routes/auth.js');
  const modelsRouterMod = await import('../routes/models.js');

  const app = express();
  app.use(express.json());
  app.use('/', authRouterMod.default);
  app.use('/', modelsRouterMod.default);
  // Bare protected route not needed here — models router itself is the
  // surface under test.

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

// Inserts an asset row directly (bypassing /upload) and, if content is
// given, writes real bytes to disk at the same path assetFilePath()
// would use, so download/hash-dedup tests see a real file.
function insertAsset(
  app: Booted,
  opts: { filename: string; thumbStatus?: 'none' | 'pending' | 'done' | 'failed'; folderId?: string | null; content?: string },
): { id: string; hash: string | null } {
  const id = uuidv4();
  const hash = opts.content ? crypto.createHash('sha256').update(opts.content).digest('hex') : null;
  app.db.prepare(
    `INSERT INTO assets (id, filename, mime, size, folder_id, thumb_status, file_hash)
     VALUES (?, ?, 'application/octet-stream', ?, ?, ?, ?)`
  ).run(id, opts.filename, opts.content?.length ?? 0, opts.folderId ?? null, opts.thumbStatus ?? 'none', hash);

  if (opts.content !== undefined) {
    const dir = path.join(app.storageDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, opts.filename), opts.content);
  }
  return { id, hash };
}

function insertFolder(app: Booted, name = 'Test Folder'): string {
  const id = uuidv4();
  app.db.prepare('INSERT INTO folders (id, name) VALUES (?, ?)').run(id, name);
  return id;
}

describe('GET/POST /models — list + create', () => {
  it('creates a model with owner_id from req.user and defaults visibility to public', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Articulated Dragon' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; title: string; ownerId: string; visibility: string; fileCount: number };
    expect(body.title).toBe('Articulated Dragon');
    expect(body.visibility).toBe('public');
    expect(body.fileCount).toBe(0);

    const row = app.db.prepare('SELECT owner_id FROM users u JOIN models m ON m.owner_id = u.id WHERE m.id = ?')
      .get(body.id) as { owner_id: string } | undefined;
    expect(row?.owner_id).toBeTruthy();
  });

  it('rejects a missing title', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid visibility value', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X', visibility: 'super-public' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a valid https sourceUrl', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X', sourceUrl: 'https://www.thingiverse.com/thing:123' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { sourceUrl: string };
    expect(body.sourceUrl).toBe('https://www.thingiverse.com/thing:123');
  });

  it('rejects a javascript: sourceUrl (stored XSS guard)', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X', sourceUrl: 'javascript:alert(1)' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a case-variant / whitespace-padded javascript: sourceUrl', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X', sourceUrl: '  JaVaScRiPt:alert(1)' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts an empty-string sourceUrl (treated as none)', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X', sourceUrl: '' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { sourceUrl: string | null };
    expect(body.sourceUrl).toBeNull();
  });

  it('lists models filtered by q, and respects owner=me', async () => {
    const app = await bootApp();
    await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Skull Planter' }) });
    await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Pumpkin Bucket' }) });

    const searchRes = await fetch(`${app.baseUrl}/models?q=skull`, { headers: bearer(app.token) });
    const searchBody = await searchRes.json() as { items: Array<{ title: string }>; total: number };
    expect(searchBody.total).toBe(1);
    expect(searchBody.items[0].title).toBe('Skull Planter');

    const meRes = await fetch(`${app.baseUrl}/models?owner=me`, { headers: bearer(app.token) });
    const meBody = await meRes.json() as { total: number };
    expect(meBody.total).toBe(2);
  });

  it('does not list a soft-deleted model', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Temp' }) });
    const { id } = await createRes.json() as { id: string };

    await fetch(`${app.baseUrl}/model/${id}`, { method: 'DELETE', headers: bearer(app.token) });

    const listRes = await fetch(`${app.baseUrl}/models`, { headers: bearer(app.token) });
    const listBody = await listRes.json() as { total: number };
    expect(listBody.total).toBe(0);
  });
});

describe('PATCH /model/:id', () => {
  it('updates fields and bumps updated_at', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Original' }) });
    const created = await createRes.json() as { id: string; updatedAt: number };

    const patchRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Renamed', tags: ['dragon', 'articulated'] }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json() as { title: string; tags: string[] };
    expect(updated.title).toBe('Renamed');
    expect(updated.tags).toEqual(['dragon', 'articulated']);
  });

  it('404s for an unknown id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/model/${uuidv4()}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a javascript: sourceUrl on update', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Original' }) });
    const created = await createRes.json() as { id: string };

    const patchRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ sourceUrl: 'javascript:alert(document.cookie)' }),
    });
    expect(patchRes.status).toBe(400);

    const row = app.db.prepare('SELECT source_url FROM models WHERE id = ?').get(created.id) as { source_url: string | null };
    expect(row.source_url).toBeNull();
  });

  it('accepts a valid http sourceUrl on update and null clears it', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Original' }) });
    const created = await createRes.json() as { id: string };

    const patchRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ sourceUrl: 'http://example.com/model/42' }),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json() as { sourceUrl: string }).sourceUrl).toBe('http://example.com/model/42');

    const clearRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ sourceUrl: null }),
    });
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json() as { sourceUrl: string | null }).sourceUrl).toBeNull();
  });
});

describe('DELETE /model/:id — soft vs permanent, deletion semantics', () => {
  it('soft delete sets deleted_at but the model row and its links survive', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Soft Me' }) });
    const { id } = await createRes.json() as { id: string };
    const { id: assetId } = insertAsset(app, { filename: 'part.stl' });
    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [assetId] }) });

    const delRes = await fetch(`${app.baseUrl}/model/${id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(200);

    const row = app.db.prepare('SELECT deleted_at FROM models WHERE id = ?').get(id) as { deleted_at: number | null };
    expect(row.deleted_at).not.toBeNull();

    const linkCount = (app.db.prepare('SELECT COUNT(*) as c FROM model_files WHERE model_id = ?').get(id) as { c: number }).c;
    expect(linkCount).toBe(1);

    const assetRow = app.db.prepare('SELECT deleted_at FROM assets WHERE id = ?').get(assetId) as { deleted_at: number | null };
    expect(assetRow.deleted_at).toBeNull();
  });

  it('permanent delete removes the model + model_files + print_profiles rows, but NEVER the asset row', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Hard Delete Me' }) });
    const { id } = await createRes.json() as { id: string };
    const { id: assetId } = insertAsset(app, { filename: 'part.stl' });
    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [assetId] }) });
    await fetch(`${app.baseUrl}/model/${id}/profiles`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ name: 'PLA 0.2mm' }) });

    const delRes = await fetch(`${app.baseUrl}/model/${id}?permanent=true`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(200);

    const modelRow = app.db.prepare('SELECT id FROM models WHERE id = ?').get(id);
    expect(modelRow).toBeUndefined();

    const linkCount = (app.db.prepare('SELECT COUNT(*) as c FROM model_files WHERE model_id = ?').get(id) as { c: number }).c;
    expect(linkCount).toBe(0);

    const profileCount = (app.db.prepare('SELECT COUNT(*) as c FROM print_profiles WHERE model_id = ?').get(id) as { c: number }).c;
    expect(profileCount).toBe(0);

    // The asset itself must still exist, untouched — this is the
    // load-bearing assertion for the whole ticket's deletion contract.
    const assetRow = app.db.prepare('SELECT id, deleted_at FROM assets WHERE id = ?').get(assetId) as { id: string; deleted_at: number | null } | undefined;
    expect(assetRow?.id).toBe(assetId);
    expect(assetRow?.deleted_at).toBeNull();
  });
});

describe('POST /models/from-folder', () => {
  it('is purely additive — creates a model + links, leaves the folder and assets untouched', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Dragon Prints');
    const stl = insertAsset(app, { filename: 'body.stl', folderId, thumbStatus: 'pending' });
    const img = insertAsset(app, { filename: 'cover.png', folderId, thumbStatus: 'done' });
    const doc = insertAsset(app, { filename: 'readme.txt', folderId });

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      id: string; title: string; sourceFolderId: string; coverAssetId: string;
      files: Array<{ assetId: string; role: string }>;
    };
    expect(body.title).toBe('Dragon Prints'); // falls back to folder name
    expect(body.sourceFolderId).toBe(folderId);
    expect(body.coverAssetId).toBe(img.id); // first image wins over "first done thumb"

    const roles = new Map(body.files.map((f) => [f.assetId, f.role]));
    expect(roles.get(stl.id)).toBe('part');
    expect(roles.get(img.id)).toBe('image');
    expect(roles.get(doc.id)).toBe('doc');

    // Folder untouched.
    const folderRow = app.db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
    expect(folderRow).toBeTruthy();
    // Assets untouched — still assigned to the same folder, not deleted,
    // not re-parented anywhere.
    for (const a of [stl, img, doc]) {
      const row = app.db.prepare('SELECT folder_id, deleted_at FROM assets WHERE id = ?').get(a.id) as
        { folder_id: string; deleted_at: number | null };
      expect(row.folder_id).toBe(folderId);
      expect(row.deleted_at).toBeNull();
    }
  });

  it('honors an explicit title override instead of the folder name', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'raw_export_42');
    insertAsset(app, { filename: 'a.stl', folderId });

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId, title: 'Nice Model Name' }),
    });
    const body = await res.json() as { title: string };
    expect(body.title).toBe('Nice Model Name');
  });

  it('400s for a folder with no assets', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Empty');
    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown folder', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: uuidv4() }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /model/:id/files — attach existing + upload with dedup', () => {
  it('attaches existing asset ids via JSON body', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const a1 = insertAsset(app, { filename: 'a.stl' });
    const a2 = insertAsset(app, { filename: 'b.stl' });

    const res = await fetch(`${app.baseUrl}/model/${id}/files`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetIds: [a1.id, a2.id] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { attached: number; model: { files: unknown[] } };
    expect(body.attached).toBe(2);
    expect(body.model.files).toHaveLength(2);
  });

  it('silently skips asset ids that do not exist or are trashed', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const real = insertAsset(app, { filename: 'a.stl' });

    const res = await fetch(`${app.baseUrl}/model/${id}/files`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetIds: [real.id, uuidv4()] }),
    });
    const body = await res.json() as { attached: number };
    expect(body.attached).toBe(1);
  });

  it('uploads new bytes via multipart and links a fresh asset', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };

    const form = new FormData();
    form.append('files', new Blob(['fresh bytes'], { type: 'model/stl' }), 'fresh.stl');
    form.append('role', 'part');

    const res = await fetch(`${app.baseUrl}/model/${id}/files`, {
      method: 'POST',
      headers: bearer(app.token),
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { attached: number; model: { files: Array<{ role: string; asset: { filename: string } }> } };
    expect(body.attached).toBe(1);
    expect(body.model.files[0].role).toBe('part');
    expect(body.model.files[0].asset.filename).toBe('fresh.stl');

    const assetCount = (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c;
    expect(assetCount).toBe(1);
  });

  it('dedups an uploaded file whose hash already exists in the vault — links, does not duplicate', async () => {
    const app = await bootApp();
    const existing = insertAsset(app, { filename: 'already-here.stl', content: 'same bytes' });
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };

    const form = new FormData();
    form.append('files', new Blob(['same bytes'], { type: 'model/stl' }), 'duplicate-name.stl');

    const res = await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: bearer(app.token), body: form });
    const body = await res.json() as { model: { files: Array<{ assetId: string }> } };
    expect(body.model.files).toHaveLength(1);
    expect(body.model.files[0].assetId).toBe(existing.id);

    const assetCount = (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c;
    expect(assetCount).toBe(1); // no second asset row created
  });

  it('rejects an invalid role', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/model/${id}/files`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetIds: [uuidv4()], role: 'thumbnail' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /model/:id/file/:assetId — detach never deletes the asset', () => {
  it('removes the link, leaves the asset row intact, and clears cover if it was the cover', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const asset = insertAsset(app, { filename: 'cover.png' });
    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [asset.id], role: 'image' }) });
    await fetch(`${app.baseUrl}/model/${id}/cover`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ assetId: asset.id }) });

    const delRes = await fetch(`${app.baseUrl}/model/${id}/file/${asset.id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(204);

    const assetRow = app.db.prepare('SELECT id FROM assets WHERE id = ?').get(asset.id);
    expect(assetRow).toBeTruthy();

    const modelRow = app.db.prepare('SELECT cover_asset_id FROM models WHERE id = ?').get(id) as { cover_asset_id: string | null };
    expect(modelRow.cover_asset_id).toBeNull();
  });

  it('404s when the file is not attached to the model', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/model/${id}/file/${uuidv4()}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /model/:id/files/reorder', () => {
  it('reassigns sort_order to match the given order', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const a = insertAsset(app, { filename: 'a.stl' });
    const b = insertAsset(app, { filename: 'b.stl' });
    const c = insertAsset(app, { filename: 'c.stl' });
    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [a.id, b.id, c.id] }) });

    const res = await fetch(`${app.baseUrl}/model/${id}/files/reorder`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetIds: [c.id, a.id, b.id] }),
    });
    expect(res.status).toBe(200);

    const rows = app.db.prepare('SELECT asset_id, sort_order FROM model_files WHERE model_id = ? ORDER BY sort_order ASC').all(id) as
      Array<{ asset_id: string; sort_order: number }>;
    expect(rows.map((r) => r.asset_id)).toEqual([c.id, a.id, b.id]);
  });
});

describe('PATCH /model/:id/cover', () => {
  it('requires the cover asset to be attached to the model', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const unattached = insertAsset(app, { filename: 'x.png' });

    const res = await fetch(`${app.baseUrl}/model/${id}/cover`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetId: unattached.id }),
    });
    expect(res.status).toBe(400);
  });

  it('clears the cover when assetId is null', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const asset = insertAsset(app, { filename: 'x.png' });
    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [asset.id] }) });
    await fetch(`${app.baseUrl}/model/${id}/cover`, { method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ assetId: asset.id }) });

    const res = await fetch(`${app.baseUrl}/model/${id}/cover`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ assetId: null }),
    });
    expect(res.status).toBe(200);
    const row = app.db.prepare('SELECT cover_asset_id FROM models WHERE id = ?').get(id) as { cover_asset_id: string | null };
    expect(row.cover_asset_id).toBeNull();
  });
});

describe('GET /model/:id/download — zip of role=part only', () => {
  it('includes only part-role files, not images or docs', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Zippable' }) });
    const { id } = await createRes.json() as { id: string };
    const part = insertAsset(app, { filename: 'part.stl', content: 'stl-bytes' });
    const image = insertAsset(app, { filename: 'cover.png', content: 'png-bytes' });

    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [part.id], role: 'part' }) });
    await fetch(`${app.baseUrl}/model/${id}/files`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ assetIds: [image.id], role: 'image' }) });

    const res = await fetch(`${app.baseUrl}/model/${id}/download`, { headers: bearer(app.token) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // Cheap content check without a zip-reading dependency: the archive
    // (stored/deflated at level 5) still contains the literal filename
    // string in its central directory for a file this small.
    expect(buf.toString('latin1')).toContain('part.stl');
  });
});

describe('print_profiles CRUD', () => {
  it('creates, updates, lists, and deletes a profile scoped to its model', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };

    const createProfileRes = await fetch(`${app.baseUrl}/model/${id}/profiles`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: 'PLA 0.2mm', printer: 'Prusa MK4', infill: 15 }),
    });
    expect(createProfileRes.status).toBe(201);
    const profile = await createProfileRes.json() as { id: string; name: string; infill: number; supports: boolean };
    expect(profile.name).toBe('PLA 0.2mm');
    expect(profile.infill).toBe(15);
    expect(profile.supports).toBe(false);

    const listRes = await fetch(`${app.baseUrl}/model/${id}/profiles`, { headers: bearer(app.token) });
    const list = await listRes.json() as Array<{ id: string }>;
    expect(list).toHaveLength(1);

    const patchRes = await fetch(`${app.baseUrl}/profile/${profile.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ supports: true, notes: 'needs supports on the tail' }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json() as { supports: boolean; notes: string; name: string };
    expect(updated.supports).toBe(true);
    expect(updated.notes).toBe('needs supports on the tail');
    expect(updated.name).toBe('PLA 0.2mm'); // untouched fields preserved

    const delRes = await fetch(`${app.baseUrl}/profile/${profile.id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(delRes.status).toBe(204);

    const afterDeleteRes = await fetch(`${app.baseUrl}/model/${id}/profiles`, { headers: bearer(app.token) });
    expect(await afterDeleteRes.json()).toEqual([]);
  });

  it('rejects a missing name on create', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'M' }) });
    const { id } = await createRes.json() as { id: string };
    const res = await fetch(`${app.baseUrl}/model/${id}/profiles`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('auth', () => {
  it('every models endpoint denies with no token', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models`);
    expect(res.status).toBe(401);
  });
});

// ─── Likes (migration v16, #2167) ──────────────────────────────────────────────

describe('PUT/DELETE /model/:id/like — idempotency + count/likedByMe threading', () => {
  it('a fresh model has likeCount 0 and likedByMe false everywhere it appears', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Unliked' }) });
    const created = await createRes.json() as { id: string; likeCount: number; likedByMe: boolean };
    expect(created.likeCount).toBe(0);
    expect(created.likedByMe).toBe(false);

    const detailRes = await fetch(`${app.baseUrl}/model/${created.id}`, { headers: bearer(app.token) });
    const detail = await detailRes.json() as { likeCount: number; likedByMe: boolean };
    expect(detail.likeCount).toBe(0);
    expect(detail.likedByMe).toBe(false);

    const listRes = await fetch(`${app.baseUrl}/models`, { headers: bearer(app.token) });
    const list = await listRes.json() as { items: Array<{ id: string; likeCount: number; likedByMe: boolean }> };
    const row = list.items.find((m) => m.id === created.id)!;
    expect(row.likeCount).toBe(0);
    expect(row.likedByMe).toBe(false);
  });

  it('PUT like sets likedByMe true and increments likeCount; repeated PUTs are idempotent (no double count)', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Liked Thing' }) });
    const { id } = await createRes.json() as { id: string };

    const like1 = await fetch(`${app.baseUrl}/model/${id}/like`, { method: 'PUT', headers: bearer(app.token) });
    expect(like1.status).toBe(200);
    const body1 = await like1.json() as { likeCount: number; likedByMe: boolean };
    expect(body1.likeCount).toBe(1);
    expect(body1.likedByMe).toBe(true);

    // Second PUT — idempotent, count stays at 1, not 2.
    const like2 = await fetch(`${app.baseUrl}/model/${id}/like`, { method: 'PUT', headers: bearer(app.token) });
    const body2 = await like2.json() as { likeCount: number; likedByMe: boolean };
    expect(body2.likeCount).toBe(1);
    expect(body2.likedByMe).toBe(true);

    const row = app.db.prepare('SELECT COUNT(*) AS c FROM model_likes WHERE model_id = ?').get(id) as { c: number };
    expect(row.c).toBe(1);
  });

  it('DELETE unlike clears likedByMe and decrements likeCount; repeated DELETEs are idempotent (no error, no negative count)', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Thing' }) });
    const { id } = await createRes.json() as { id: string };
    await fetch(`${app.baseUrl}/model/${id}/like`, { method: 'PUT', headers: bearer(app.token) });

    const unlike1 = await fetch(`${app.baseUrl}/model/${id}/like`, { method: 'DELETE', headers: bearer(app.token) });
    expect(unlike1.status).toBe(200);
    const body1 = await unlike1.json() as { likeCount: number; likedByMe: boolean };
    expect(body1.likeCount).toBe(0);
    expect(body1.likedByMe).toBe(false);

    // Second DELETE on an already-unliked model — no error, stays at 0.
    const unlike2 = await fetch(`${app.baseUrl}/model/${id}/like`, { method: 'DELETE', headers: bearer(app.token) });
    expect(unlike2.status).toBe(200);
    const body2 = await unlike2.json() as { likeCount: number; likedByMe: boolean };
    expect(body2.likeCount).toBe(0);
  });

  it('404s liking/unliking a model that does not exist', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/model/does-not-exist/like`, { method: 'PUT', headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });

  it('404s liking a soft-deleted model', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Gone' }) });
    const { id } = await createRes.json() as { id: string };
    await fetch(`${app.baseUrl}/model/${id}`, { method: 'DELETE', headers: bearer(app.token) });
    const res = await fetch(`${app.baseUrl}/model/${id}/like`, { method: 'PUT', headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });

  it('denies like/unlike with no token', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/model/anything/like`, { method: 'PUT' });
    expect(res.status).toBe(401);
  });

  it('sort=likes orders by like count descending, ties broken by created_at descending', async () => {
    const app = await bootApp();
    const mkModel = async (title: string) => {
      const r = await fetch(`${app.baseUrl}/models`, { method: 'POST', headers: jsonHeaders(app.token), body: JSON.stringify({ title }) });
      return (await r.json()) as { id: string };
    };
    const a = await mkModel('A - zero likes');
    const b = await mkModel('B - two likes');
    const c = await mkModel('C - one like');

    await fetch(`${app.baseUrl}/model/${b.id}/like`, { method: 'PUT', headers: bearer(app.token) });
    await fetch(`${app.baseUrl}/model/${c.id}/like`, { method: 'PUT', headers: bearer(app.token) });
    // A second liker on B, so B has 2 and C has 1 — insert a second user
    // directly (no signup route exists yet, Phase D) to prove the count
    // is a real COUNT(*), not just a boolean liked-by-current-user flag.
    const secondUserId = uuidv4();
    app.db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (?, 'second', 'hash', 'member')",
    ).run(secondUserId);
    app.db.prepare('INSERT INTO model_likes (model_id, user_id) VALUES (?, ?)').run(b.id, secondUserId);

    const res = await fetch(`${app.baseUrl}/models?sort=likes`, { headers: bearer(app.token) });
    const { items } = await res.json() as { items: Array<{ id: string; likeCount: number }> };
    const ids = items.map((m) => m.id);
    // B (2 likes) first, C (1 like) second, A (0 likes) last.
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(c.id));
    expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(a.id));
    expect(items.find((m) => m.id === b.id)!.likeCount).toBe(2);
    expect(items.find((m) => m.id === c.id)!.likeCount).toBe(1);
    expect(items.find((m) => m.id === a.id)!.likeCount).toBe(0);
  });
});
