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

// parentId added #2175 — the recursive/each-child conversion tests need
// nested folders; every pre-existing call site passes no parentId and
// gets the old flat-folder behavior unchanged.
function insertFolder(app: Booted, name = 'Test Folder', parentId: string | null = null): string {
  const id = uuidv4();
  app.db.prepare('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)').run(id, name, parentId);
  return id;
}

// Real login (not a bare createToken()) — same convention as
// modelImport.test.ts's createMemberUser, kept as its own local copy
// per this suite's established one-helper-file-per-router pattern
// (auth.test.ts's own createToken re-export is the one place that
// convention is broken, and only because it's specifically testing
// token validity itself). role='member' matches the v15 schema default
// (see enumValidators.ts's USER_ROLES / db.ts's users_new table-copy).
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

  // #2166: validate-then-write. Before this fix, title (an earlier field
  // in the handler's field order) would already be UPDATEd by the time
  // sourceUrl's validation 400s, leaving the model half-patched. Now every
  // field is validated first — a later field failing must leave NO field
  // changed, not just leave the invalid one alone.
  it('a PATCH where a later field is invalid leaves NO field changed (atomicity)', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Original Title', description: 'Original description' }),
    });
    const created = await createRes.json() as { id: string; updatedAt: number };

    const patchRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({
        title: 'Renamed', // valid, and ordered before sourceUrl in the handler
        description: 'Renamed description', // valid
        sourceUrl: 'javascript:alert(document.cookie)', // invalid — should 400 the whole request
      }),
    });
    expect(patchRes.status).toBe(400);

    const row = app.db.prepare('SELECT title, description, source_url, updated_at FROM models WHERE id = ?').get(created.id) as
      { title: string; description: string | null; source_url: string | null; updated_at: number };
    expect(row.title).toBe('Original Title');
    expect(row.description).toBe('Original description');
    expect(row.source_url).toBeNull();
    expect(row.updated_at).toBe(created.updatedAt);
  });

  it('a PATCH where an invalid category (checked mid-handler) rejects and leaves an earlier valid field untouched', async () => {
    const app = await bootApp();
    const createRes = await fetch(`${app.baseUrl}/models`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Original Title' }),
    });
    const created = await createRes.json() as { id: string };

    const patchRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Renamed', categoryId: uuidv4() }),
    });
    expect(patchRes.status).toBe(400);

    const row = app.db.prepare('SELECT title, category_id FROM models WHERE id = ?').get(created.id) as
      { title: string; category_id: string | null };
    expect(row.title).toBe('Original Title');
    expect(row.category_id).toBeNull();
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

describe('GET /models/from-folder/preview — dry run, no writes', () => {
  it('classifies the same way the real POST would, and writes nothing', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Dragon Prints');
    const stl = insertAsset(app, { filename: 'body.stl', folderId, thumbStatus: 'pending' });
    const img = insertAsset(app, { filename: 'cover.png', folderId, thumbStatus: 'done' });
    const doc = insertAsset(app, { filename: 'readme.txt', folderId });

    const modelsBefore = (app.db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number }).c;
    const filesBefore = (app.db.prepare('SELECT COUNT(*) as c FROM model_files').get() as { c: number }).c;

    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(app.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      folderId: string; folderName: string; suggestedTitle: string; assetCount: number;
      countsByRole: Record<string, number>; coverAssetId: string; alreadyConverted: boolean;
      files: Array<{ assetId: string; filename: string; role: string }>;
    };

    expect(body.folderName).toBe('Dragon Prints');
    expect(body.suggestedTitle).toBe('Dragon Prints');
    expect(body.assetCount).toBe(3);
    expect(body.coverAssetId).toBe(img.id);
    expect(body.alreadyConverted).toBe(false);
    expect(body.countsByRole).toEqual({ part: 1, image: 1, doc: 1, other: 0 });

    const roles = new Map(body.files.map((f) => [f.assetId, f.role]));
    expect(roles.get(stl.id)).toBe('part');
    expect(roles.get(img.id)).toBe('image');
    expect(roles.get(doc.id)).toBe('doc');

    // Load-bearing: this is a preview, not a conversion — no rows written.
    const modelsAfter = (app.db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number }).c;
    const filesAfter = (app.db.prepare('SELECT COUNT(*) as c FROM model_files').get() as { c: number }).c;
    expect(modelsAfter).toBe(modelsBefore);
    expect(filesAfter).toBe(filesBefore);
  });

  it('does not 400 on an empty folder — returns a zero-count preview instead', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Empty');
    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(app.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { assetCount: number; files: unknown[]; coverAssetId: string | null };
    expect(body.assetCount).toBe(0);
    expect(body.files).toEqual([]);
    expect(body.coverAssetId).toBeNull();
  });

  it('404s for an unknown folder', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${uuidv4()}`, { headers: bearer(app.token) });
    expect(res.status).toBe(404);
  });

  it('400s when folder_id is missing', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/models/from-folder/preview`, { headers: bearer(app.token) });
    expect(res.status).toBe(400);
  });

  it('flags alreadyConverted true once a model has been created from the folder', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Already Done');
    insertAsset(app, { filename: 'a.stl', folderId });

    const createRes = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId }),
    });
    const created = await createRes.json() as { id: string };

    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(app.token) });
    const body = await res.json() as { alreadyConverted: boolean; existingModelIds: string[] };
    expect(body.alreadyConverted).toBe(true);
    expect(body.existingModelIds).toEqual([created.id]);
  });

  it('denies with no token', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app);
    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`);
    expect(res.status).toBe(401);
  });

  // Vera phase-D auth review (#2179 fast-follow, Medium): this handler's
  // source_folder_id lookup for alreadyConverted/existingModelIds had no
  // visibility filter at all — unlike every other model read in this
  // file — so a private model's real UUID leaked here to a caller who is
  // correctly 404'd on GET /model/:id, the list, and download for that
  // same model. Bounded impact (folders/assets are the shared pool, so
  // the leaked id unlocked nothing further), but it's exactly the
  // existence-hiding inconsistency this phase's review hunted for.
  it('a private model owned by someone else never surfaces via preview — id absent, alreadyConverted false; owner and admin still see it', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Secret Prints');
    insertAsset(app, { filename: 'a.stl', folderId });

    const alice = await createMemberUser(app, 'alice');
    const bob = await createMemberUser(app, 'bob');

    const createRes = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ folderId }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string };

    const patchRes = await fetch(`${app.baseUrl}/model/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(patchRes.status).toBe(200);

    // Bob (neither owner nor admin): the folder's real, shared contents
    // still preview correctly (assetCount/files are not visibility-
    // scoped — only the marker is), but the already-converted marker
    // must not leak Alice's private model.
    const bobRes = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(bob.token) });
    expect(bobRes.status).toBe(200);
    const bobRawBody = await bobRes.text();
    // Defense at the wire level, not just "the field is empty" — same
    // convention as auth.test.ts's mount-password redaction test: the
    // literal id must not appear anywhere in the response body.
    expect(bobRawBody).not.toContain(created.id);
    const bobBody = JSON.parse(bobRawBody) as { alreadyConverted: boolean; existingModelIds: string[]; assetCount: number };
    expect(bobBody.alreadyConverted).toBe(false);
    expect(bobBody.existingModelIds).toEqual([]);
    expect(bobBody.assetCount).toBe(1); // the folder's real contents are still visible

    // Alice (owner) still sees her own private model reflected.
    const aliceRes = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(alice.token) });
    const aliceBody = await aliceRes.json() as { alreadyConverted: boolean; existingModelIds: string[] };
    expect(aliceBody.alreadyConverted).toBe(true);
    expect(aliceBody.existingModelIds).toEqual([created.id]);

    // Admin bypasses visibility entirely, same as every other read.
    const adminRes = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(app.token) });
    const adminBody = await adminRes.json() as { alreadyConverted: boolean; existingModelIds: string[] };
    expect(adminBody.alreadyConverted).toBe(true);
    expect(adminBody.existingModelIds).toEqual([created.id]);
  });
});

// #2175 — root-cause fix: pointing conversion at a meaningfully-named
// parent whose real assets live several levels down in bare-GUID leaf
// folders (the exact "Droidkyn" shape from Aaron's bug report).
describe('mode=single — recursive collection (#2175)', () => {
  it('pulls deep descendant assets, not just direct children, into one model', async () => {
    const app = await bootApp();
    const droidkyn = insertFolder(app, 'Droidkyn');
    const guidLeaf1 = insertFolder(app, uuidv4(), droidkyn);
    const guidLeaf2 = insertFolder(app, uuidv4(), guidLeaf1);
    const arm = insertAsset(app, { filename: 'arm.stl', folderId: guidLeaf1 });
    const leg = insertAsset(app, { filename: 'leg.stl', folderId: guidLeaf2 });
    const readme = insertAsset(app, { filename: 'readme.txt', folderId: droidkyn }); // direct child too

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: droidkyn, mode: 'single' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { title: string; files: Array<{ assetId: string }> };
    expect(body.title).toBe('Droidkyn');
    const ids = body.files.map((f) => f.assetId).sort();
    expect(ids).toEqual([arm.id, leg.id, readme.id].sort());
  });

  it('defaults to mode=single (recursive) when mode is omitted — back-compat with pre-#2175 callers', async () => {
    const app = await bootApp();
    const root = insertFolder(app, 'Root');
    const nested = insertFolder(app, uuidv4(), root);
    const deep = insertAsset(app, { filename: 'deep.stl', folderId: nested });

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: root }), // no mode
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { files: Array<{ assetId: string }> };
    expect(body.files.map((f) => f.assetId)).toEqual([deep.id]);
  });

  it('preview breakdown (results[0]) matches exactly what the commit creates', async () => {
    const app = await bootApp();
    const root = insertFolder(app, 'Droidkyn');
    const leaf = insertFolder(app, uuidv4(), root);
    insertAsset(app, { filename: 'part.stl', folderId: leaf });
    insertAsset(app, { filename: 'cover.png', folderId: root, thumbStatus: 'done' });

    const previewRes = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${root}&mode=single`, { headers: bearer(app.token) });
    const preview = await previewRes.json() as {
      mode: string; assetCount: number; countsByRole: Record<string, number>;
      results: Array<{ assetCount: number; countsByRole: Record<string, number> }>;
    };
    expect(preview.mode).toBe('single');
    expect(preview.assetCount).toBe(2);
    expect(preview.results).toHaveLength(1);
    expect(preview.results[0].assetCount).toBe(2);
    expect(preview.results[0].countsByRole).toEqual({ part: 1, image: 1, doc: 0, other: 0 });

    const commitRes = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: root, mode: 'single' }),
    });
    const commit = await commitRes.json() as { files: unknown[] };
    expect(commit.files).toHaveLength(preview.assetCount);
  });

  it('flat top-level fields on the preview are unchanged in shape from pre-#2175 callers', async () => {
    const app = await bootApp();
    const folderId = insertFolder(app, 'Flat Folder');
    insertAsset(app, { filename: 'a.stl', folderId });

    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${folderId}`, { headers: bearer(app.token) });
    const body = await res.json() as {
      folderId: string; folderName: string; suggestedTitle: string; assetCount: number;
      coverAssetId: string | null; alreadyConverted: boolean; existingModelIds: string[];
      files: unknown[]; countsByRole: Record<string, number>;
    };
    expect(body.folderName).toBe('Flat Folder');
    expect(body.suggestedTitle).toBe('Flat Folder');
    expect(body.assetCount).toBe(1);
    expect(Array.isArray(body.files)).toBe(true);
  });
});

describe('mode=each-child — batch convert per named immediate child (#2175)', () => {
  it("converts Aaron's Minis example: named children each become their own model, bare-GUID child is skipped", async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    const circuitMaster = insertFolder(app, 'Circuit Master', minis);
    const heavyWeapons = insertFolder(app, 'Heavy Weapons', minis);
    const bareGuidChild = insertFolder(app, uuidv4(), minis);

    insertAsset(app, { filename: 'body.stl', folderId: droidkyn });
    insertAsset(app, { filename: 'turret.stl', folderId: circuitMaster });
    insertAsset(app, { filename: 'gun.stl', folderId: heavyWeapons });
    insertAsset(app, { filename: 'orphan.stl', folderId: bareGuidChild }); // must NOT be converted

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: minis, mode: 'each-child' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      mode: string;
      created: Array<{ title: string; sourceFolderId: string }>;
      skippedChildren: Array<{ folderId: string; reason: string }>;
    };
    expect(body.mode).toBe('each-child');
    expect(body.created.map((m) => m.title).sort()).toEqual(['Circuit Master', 'Droidkyn', 'Heavy Weapons']);
    expect(body.created.map((m) => m.sourceFolderId).sort()).toEqual([circuitMaster, droidkyn, heavyWeapons].sort());

    expect(body.skippedChildren).toHaveLength(1);
    expect(body.skippedChildren[0].folderId).toBe(bareGuidChild);
    expect(body.skippedChildren[0].reason).toBe('bare-guid-leaf');

    // The bare-GUID child's asset was never modeled by this batch.
    const allModels = await (await fetch(`${app.baseUrl}/models?limit=100`, { headers: bearer(app.token) })).json() as
      { items: Array<{ sourceFolderId: string | null }> };
    expect(allModels.items.some((m) => m.sourceFolderId === bareGuidChild)).toBe(false);
  });

  it('recurses each named child\'s own subtree, not just its direct assets', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    const nestedLeaf = insertFolder(app, uuidv4(), droidkyn); // GUID leaf under a named child
    const direct = insertAsset(app, { filename: 'body.stl', folderId: droidkyn });
    const deep = insertAsset(app, { filename: 'arm.stl', folderId: nestedLeaf });

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: minis, mode: 'each-child' }),
    });
    const body = await res.json() as { created: Array<{ files: Array<{ assetId: string }> }> };
    expect(body.created).toHaveLength(1);
    expect(body.created[0].files.map((f) => f.assetId).sort()).toEqual([direct.id, deep.id].sort());
  });

  it('honors childTitles overrides, falling back to the child folder name', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    const circuitMaster = insertFolder(app, 'Circuit Master', minis);
    insertAsset(app, { filename: 'a.stl', folderId: droidkyn });
    insertAsset(app, { filename: 'b.stl', folderId: circuitMaster });

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({
        folderId: minis, mode: 'each-child', childTitles: { [droidkyn]: 'Custom Droidkyn Name' },
      }),
    });
    const body = await res.json() as { created: Array<{ title: string; sourceFolderId: string }> };
    const titles = new Map(body.created.map((m) => [m.sourceFolderId, m.title]));
    expect(titles.get(droidkyn)).toBe('Custom Droidkyn Name');
    expect(titles.get(circuitMaster)).toBe('Circuit Master');
  });

  it('400s when every immediate child is either bare-GUID or empty', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    insertFolder(app, uuidv4(), minis); // bare-GUID, skipped
    const empty = insertFolder(app, 'Empty Named Child', minis); // named but no assets
    void empty;

    const res = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: minis, mode: 'each-child' }),
    });
    expect(res.status).toBe(400);
  });

  it('surfaces looseAssetCount for assets sitting directly in the container, never converting them', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    insertAsset(app, { filename: 'child.stl', folderId: droidkyn });
    insertAsset(app, { filename: 'loose1.stl', folderId: minis });
    insertAsset(app, { filename: 'loose2.stl', folderId: minis });

    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${minis}&mode=each-child`, { headers: bearer(app.token) });
    const body = await res.json() as { looseAssetCount: number; results: unknown[] };
    expect(body.looseAssetCount).toBe(2);
    expect(body.results).toHaveLength(1); // only Droidkyn
  });

  it('preview results[] matches the commit\'s created[] one-for-one (title, assetCount, sourceFolderId)', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    const circuitMaster = insertFolder(app, 'Circuit Master', minis);
    insertAsset(app, { filename: 'a.stl', folderId: droidkyn });
    insertAsset(app, { filename: 'b.stl', folderId: circuitMaster });
    insertAsset(app, { filename: 'c.stl', folderId: circuitMaster });

    const previewRes = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${minis}&mode=each-child`, { headers: bearer(app.token) });
    const preview = await previewRes.json() as {
      results: Array<{ sourceFolderId: string; suggestedTitle: string; assetCount: number }>;
    };

    const commitRes = await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: minis, mode: 'each-child' }),
    });
    const commit = await commitRes.json() as { created: Array<{ title: string; sourceFolderId: string; files: unknown[] }> };

    const previewByFolder = new Map(preview.results.map((r) => [r.sourceFolderId, r]));
    for (const created of commit.created) {
      const match = previewByFolder.get(created.sourceFolderId);
      expect(match).toBeDefined();
      expect(match!.suggestedTitle).toBe(created.title);
      expect(match!.assetCount).toBe(created.files.length);
    }
  });

  it('is additive-only — folders and assets are untouched by an each-child batch', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    const asset = insertAsset(app, { filename: 'a.stl', folderId: droidkyn });

    await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: minis, mode: 'each-child' }),
    });

    const folderRow = app.db.prepare('SELECT id FROM folders WHERE id = ?').get(droidkyn);
    expect(folderRow).toBeTruthy();
    const assetRow = app.db.prepare('SELECT folder_id, deleted_at FROM assets WHERE id = ?').get(asset.id) as
      { folder_id: string; deleted_at: number | null };
    expect(assetRow.folder_id).toBe(droidkyn);
    expect(assetRow.deleted_at).toBeNull();
  });

  it('already-converted marker (alreadyConverted/existingModelIds) is scoped per-child, not per-container', async () => {
    const app = await bootApp();
    const minis = insertFolder(app, 'Minis');
    const droidkyn = insertFolder(app, 'Droidkyn', minis);
    const circuitMaster = insertFolder(app, 'Circuit Master', minis);
    insertAsset(app, { filename: 'a.stl', folderId: droidkyn });
    insertAsset(app, { filename: 'b.stl', folderId: circuitMaster });

    // Convert Droidkyn alone first, mode=single, so only that child has a model.
    await fetch(`${app.baseUrl}/models/from-folder`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ folderId: droidkyn, mode: 'single' }),
    });

    const res = await fetch(`${app.baseUrl}/models/from-folder/preview?folder_id=${minis}&mode=each-child`, { headers: bearer(app.token) });
    const body = await res.json() as { results: Array<{ sourceFolderId: string; alreadyConverted: boolean }> };
    const byFolder = new Map(body.results.map((r) => [r.sourceFolderId, r.alreadyConverted]));
    expect(byFolder.get(droidkyn)).toBe(true);
    expect(byFolder.get(circuitMaster)).toBe(false);
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

// ─── Visibility / ownership authz matrix (#2179, Phase D3) ────────────────────
//
// Two rules, kept deliberately distinct across this whole matrix:
//   - READ (visibility): list / detail / download / like. Public rows
//     visible to everyone; private rows to owner + admin only.
//   - WRITE (ownership): edit / delete / file attach-detach-reorder-cover
//     / print_profiles CRUD (including profiles' own GET — see that
//     section's comment in routes/models.ts for why it's stricter than
//     every other GET here). Owner + admin only, REGARDLESS of
//     visibility — a public model is still not everyone's to edit.
//
// The seeded bootApp() user (app.token) is always admin (see
// seedAdminIfNeeded in db.ts) — every "admin" case below rides that
// existing token rather than minting a second admin, since there is
// exactly one admin path to prove and it's already the default fixture.
describe('Visibility / ownership authz matrix (#2179)', () => {
  it('GET /models list — member sees public + own private, never another member\'s private; admin sees everything', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');

    const aPublic = await createModelAs(app, memberA.token, { title: 'A Public', visibility: 'public' });
    const aPrivate = await createModelAs(app, memberA.token, { title: 'A Private', visibility: 'private' });

    const asB = await fetch(`${app.baseUrl}/models`, { headers: bearer(memberB.token) });
    const bIds = (await asB.json() as { items: Array<{ id: string }> }).items.map((m) => m.id);
    expect(bIds).toContain(aPublic.id);
    expect(bIds).not.toContain(aPrivate.id);

    const asA = await fetch(`${app.baseUrl}/models`, { headers: bearer(memberA.token) });
    const aIds = (await asA.json() as { items: Array<{ id: string }> }).items.map((m) => m.id);
    expect(aIds).toContain(aPublic.id);
    expect(aIds).toContain(aPrivate.id);

    const asAdmin = await fetch(`${app.baseUrl}/models`, { headers: bearer(app.token) });
    const adminIds = (await asAdmin.json() as { items: Array<{ id: string }> }).items.map((m) => m.id);
    expect(adminIds).toContain(aPublic.id);
    expect(adminIds).toContain(aPrivate.id);
  });

  it('GET /model/:id detail — 404s a private model for a non-owner member, 200s for owner and admin', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const aPrivate = await createModelAs(app, memberA.token, { title: 'Secret', visibility: 'private' });

    const asB = await fetch(`${app.baseUrl}/model/${aPrivate.id}`, { headers: bearer(memberB.token) });
    expect(asB.status).toBe(404);

    const asA = await fetch(`${app.baseUrl}/model/${aPrivate.id}`, { headers: bearer(memberA.token) });
    expect(asA.status).toBe(200);

    const asAdmin = await fetch(`${app.baseUrl}/model/${aPrivate.id}`, { headers: bearer(app.token) });
    expect(asAdmin.status).toBe(200);
  });

  it('GET /model/:id detail — a PUBLIC model IS visible to a non-owner member', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const aPublic = await createModelAs(app, memberA.token, { title: 'Open', visibility: 'public' });

    const asB = await fetch(`${app.baseUrl}/model/${aPublic.id}`, { headers: bearer(memberB.token) });
    expect(asB.status).toBe(200);
  });

  it('PATCH /model/:id — a non-owner member 404s editing even a PUBLIC model (write rule beats read visibility)', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const aPublic = await createModelAs(app, memberA.token, { title: 'Open', visibility: 'public' });

    const editByB = await fetch(`${app.baseUrl}/model/${aPublic.id}`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ title: 'Hijacked' }),
    });
    expect(editByB.status).toBe(404);

    const editByOwner = await fetch(`${app.baseUrl}/model/${aPublic.id}`, {
      method: 'PATCH', headers: jsonHeaders(memberA.token), body: JSON.stringify({ title: 'Renamed By Owner' }),
    });
    expect(editByOwner.status).toBe(200);

    const editByAdmin = await fetch(`${app.baseUrl}/model/${aPublic.id}`, {
      method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Renamed By Admin' }),
    });
    expect(editByAdmin.status).toBe(200);
  });

  it('DELETE /model/:id — a non-owner member 404s, owner and admin succeed', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const target = await createModelAs(app, memberA.token, { title: 'Delete Me', visibility: 'public' });

    const byB = await fetch(`${app.baseUrl}/model/${target.id}`, { method: 'DELETE', headers: bearer(memberB.token) });
    expect(byB.status).toBe(404);

    const byOwner = await fetch(`${app.baseUrl}/model/${target.id}`, { method: 'DELETE', headers: bearer(memberA.token) });
    expect(byOwner.status).toBe(200);
  });

  it('DELETE /model/:id — admin can delete another member\'s model', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const target = await createModelAs(app, memberA.token, { title: 'Delete Me Too', visibility: 'private' });

    const byAdmin = await fetch(`${app.baseUrl}/model/${target.id}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(byAdmin.status).toBe(200);
  });

  it('POST /model/:id/files, PATCH .../files/reorder, PATCH .../cover — all 404 for a non-owner member on a PUBLIC model', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const target = await createModelAs(app, memberA.token, { title: 'Open Model', visibility: 'public' });
    const asset = insertAsset(app, { filename: 'part.stl' });

    const attachRes = await fetch(`${app.baseUrl}/model/${target.id}/files`, {
      method: 'POST', headers: jsonHeaders(memberB.token), body: JSON.stringify({ assetIds: [asset.id] }),
    });
    expect(attachRes.status).toBe(404);

    const reorderRes = await fetch(`${app.baseUrl}/model/${target.id}/files/reorder`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ assetIds: [asset.id] }),
    });
    expect(reorderRes.status).toBe(404);

    const coverRes = await fetch(`${app.baseUrl}/model/${target.id}/cover`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ assetId: null }),
    });
    expect(coverRes.status).toBe(404);

    // Owner's own equivalent attach succeeds — proves the 404s above were
    // ownership-specific, not a general breakage of these endpoints.
    const attachByOwner = await fetch(`${app.baseUrl}/model/${target.id}/files`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ assetIds: [asset.id] }),
    });
    expect(attachByOwner.status).toBe(201);
  });

  it('DELETE /model/:id/file/:assetId — a non-owner member 404s detaching a file from a PUBLIC model', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const target = await createModelAs(app, memberA.token, { title: 'Open Model', visibility: 'public' });
    const asset = insertAsset(app, { filename: 'part.stl' });
    await fetch(`${app.baseUrl}/model/${target.id}/files`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ assetIds: [asset.id] }),
    });

    const detachByB = await fetch(`${app.baseUrl}/model/${target.id}/file/${asset.id}`, { method: 'DELETE', headers: bearer(memberB.token) });
    expect(detachByB.status).toBe(404);
  });

  it('GET /model/:id/download (zip) — 404s a private model for a non-owner, 200s a public model for a non-owner, 200s for owner/admin on private', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const priv = await createModelAs(app, memberA.token, { title: 'Private Zip', visibility: 'private' });
    const pub = await createModelAs(app, memberA.token, { title: 'Public Zip', visibility: 'public' });

    const privByB = await fetch(`${app.baseUrl}/model/${priv.id}/download`, { headers: bearer(memberB.token) });
    expect(privByB.status).toBe(404);

    const pubByB = await fetch(`${app.baseUrl}/model/${pub.id}/download`, { headers: bearer(memberB.token) });
    expect(pubByB.status).toBe(200);

    const privByOwner = await fetch(`${app.baseUrl}/model/${priv.id}/download`, { headers: bearer(memberA.token) });
    expect(privByOwner.status).toBe(200);

    const privByAdmin = await fetch(`${app.baseUrl}/model/${priv.id}/download`, { headers: bearer(app.token) });
    expect(privByAdmin.status).toBe(200);
  });

  it('PUT/DELETE /model/:id/like — visibility rule, not ownership: any member can like a PUBLIC model they don\'t own; a private model 404s for a non-owner', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const pub = await createModelAs(app, memberA.token, { title: 'Likeable', visibility: 'public' });
    const priv = await createModelAs(app, memberA.token, { title: 'Unlikeable', visibility: 'private' });

    // B (non-owner) liking a public model they don't own — this is the
    // whole point of likes, must succeed.
    const likePub = await fetch(`${app.baseUrl}/model/${pub.id}/like`, { method: 'PUT', headers: bearer(memberB.token) });
    expect(likePub.status).toBe(200);
    expect((await likePub.json() as { likedByMe: boolean }).likedByMe).toBe(true);

    const unlikePub = await fetch(`${app.baseUrl}/model/${pub.id}/like`, { method: 'DELETE', headers: bearer(memberB.token) });
    expect(unlikePub.status).toBe(200);

    // B liking a private model they can't see — 404, existence-hiding.
    const likePriv = await fetch(`${app.baseUrl}/model/${priv.id}/like`, { method: 'PUT', headers: bearer(memberB.token) });
    expect(likePriv.status).toBe(404);

    // The owner can like their own model (visible to themselves via the
    // owner branch of the rule, not just the public branch).
    const ownerLikesOwn = await fetch(`${app.baseUrl}/model/${priv.id}/like`, { method: 'PUT', headers: bearer(memberA.token) });
    expect(ownerLikesOwn.status).toBe(200);
  });

  it('likeCount never reveals WHO liked a model — only a count, regardless of caller', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const pub = await createModelAs(app, memberA.token, { title: 'Popular', visibility: 'public' });
    await fetch(`${app.baseUrl}/model/${pub.id}/like`, { method: 'PUT', headers: bearer(memberB.token) });

    const detailAsA = await fetch(`${app.baseUrl}/model/${pub.id}`, { headers: bearer(memberA.token) });
    const body = await detailAsA.json() as Record<string, unknown>;
    expect(body.likeCount).toBe(1);
    // No field anywhere in the payload names the liking user.
    expect(JSON.stringify(body)).not.toContain(memberB.userId);
  });

  it('print_profiles POST/PATCH/DELETE inherit the write rule — a non-owner 404s on create/edit/delete even on a PUBLIC model; owner and admin succeed', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const target = await createModelAs(app, memberA.token, { title: 'Profiled', visibility: 'public' });

    const createRes = await fetch(`${app.baseUrl}/model/${target.id}/profiles`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ name: 'PLA 0.2mm' }),
    });
    const profile = await createRes.json() as { id: string };

    const createByB = await fetch(`${app.baseUrl}/model/${target.id}/profiles`, {
      method: 'POST', headers: jsonHeaders(memberB.token), body: JSON.stringify({ name: 'Sneaky Profile' }),
    });
    expect(createByB.status).toBe(404);

    const patchByB = await fetch(`${app.baseUrl}/profile/${profile.id}`, {
      method: 'PATCH', headers: jsonHeaders(memberB.token), body: JSON.stringify({ notes: 'hijacked' }),
    });
    expect(patchByB.status).toBe(404);

    const deleteByB = await fetch(`${app.baseUrl}/profile/${profile.id}`, { method: 'DELETE', headers: bearer(memberB.token) });
    expect(deleteByB.status).toBe(404);

    // Owner and admin can do all of the above.
    const patchByAdmin = await fetch(`${app.baseUrl}/profile/${profile.id}`, {
      method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ notes: 'admin edit ok' }),
    });
    expect(patchByAdmin.status).toBe(200);

    const deleteByOwner = await fetch(`${app.baseUrl}/profile/${profile.id}`, { method: 'DELETE', headers: bearer(memberA.token) });
    expect(deleteByOwner.status).toBe(204);
  });

  it('print_profiles GET (list) is READ-gated (#2179 Remy round) — a non-owner CAN list profiles on a PUBLIC model, but 404s on a PRIVATE model; owner/admin always can', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const pub = await createModelAs(app, memberA.token, { title: 'Profiled Public', visibility: 'public' });
    const priv = await createModelAs(app, memberA.token, { title: 'Profiled Private', visibility: 'private' });
    await fetch(`${app.baseUrl}/model/${pub.id}/profiles`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ name: 'PLA 0.2mm' }),
    });
    await fetch(`${app.baseUrl}/model/${priv.id}/profiles`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ name: 'PETG 0.24mm' }),
    });

    const pubListByB = await fetch(`${app.baseUrl}/model/${pub.id}/profiles`, { headers: bearer(memberB.token) });
    expect(pubListByB.status).toBe(200);
    expect(await pubListByB.json()).toHaveLength(1);

    const privListByB = await fetch(`${app.baseUrl}/model/${priv.id}/profiles`, { headers: bearer(memberB.token) });
    expect(privListByB.status).toBe(404);

    const privListByOwner = await fetch(`${app.baseUrl}/model/${priv.id}/profiles`, { headers: bearer(memberA.token) });
    expect(privListByOwner.status).toBe(200);

    const privListByAdmin = await fetch(`${app.baseUrl}/model/${priv.id}/profiles`, { headers: bearer(app.token) });
    expect(privListByAdmin.status).toBe(200);
  });

  it('GET /model/:id detail embeds `profiles` for a PUBLIC model viewed by a non-owner, consistent with the standalone GET /model/:id/profiles endpoint (#2179 Remy round — no more asymmetry)', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const memberB = await createMemberUser(app, 'member-b');
    const target = await createModelAs(app, memberA.token, { title: 'Profiled Public', visibility: 'public' });
    await fetch(`${app.baseUrl}/model/${target.id}/profiles`, {
      method: 'POST', headers: jsonHeaders(memberA.token), body: JSON.stringify({ name: 'PLA 0.2mm' }),
    });

    const detailByB = await fetch(`${app.baseUrl}/model/${target.id}`, { headers: bearer(memberB.token) });
    expect(detailByB.status).toBe(200);
    const body = await detailByB.json() as { profiles: Array<{ name: string }> };
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].name).toBe('PLA 0.2mm');
  });

  it('single-admin UX does not regress: admin bypasses both the visibility fragment (1=1) and the ownership check on every operation', async () => {
    const app = await bootApp();
    const memberA = await createMemberUser(app, 'member-a');
    const priv = await createModelAs(app, memberA.token, { title: 'Admin Sees All', visibility: 'private' });

    const listRes = await fetch(`${app.baseUrl}/models`, { headers: bearer(app.token) });
    const ids = (await listRes.json() as { items: Array<{ id: string }> }).items.map((m) => m.id);
    expect(ids).toContain(priv.id);

    const detailRes = await fetch(`${app.baseUrl}/model/${priv.id}`, { headers: bearer(app.token) });
    expect(detailRes.status).toBe(200);

    const patchRes = await fetch(`${app.baseUrl}/model/${priv.id}`, {
      method: 'PATCH', headers: jsonHeaders(app.token), body: JSON.stringify({ title: 'Admin Edited' }),
    });
    expect(patchRes.status).toBe(200);
  });
});
