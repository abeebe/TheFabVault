// Integration tests for routes/modelImport.ts (#2172) — exercise the real
// Express router (draft create/commit/abandon) against a throwaway
// on-disk SQLite DB + storage/data dirs, over a real HTTP loopback
// server. Same boot pattern as models.test.ts; see that file's header
// for the full rationale on why this needs a real request path rather
// than a bare unit call (module-level singletons in db.ts/fileStore.ts/
// config.ts).
//
// Real zips are built with the hand-rolled buildRawZip helper
// (./helpers/rawZip.ts), not `archiver` — archiver sanitizes entry names
// on write, which would silently defeat the zip-slip test. The
// commit-dedup and happy-path tests don't need hostile entries, but use
// the same helper throughout for one consistent zip-building path in
// this file.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { buildRawZip } from './helpers/rawZip.js';

interface Booted {
  baseUrl: string;
  token: string;
  db: Database.Database;
  dataDir: string;
  storageDir: string;
  close: () => Promise<void>;
}

const booted: Booted[] = [];

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'correct-horse-battery-staple';

async function bootApp(opts: { dataDir?: string } = {}): Promise<Booted> {
  // dataDir is only auto-cleaned on close() when THIS call generated it --
  // the TTL-on-boot test passes its own shared dataDir across two boots
  // (simulating a restart) and owns cleaning that one up itself.
  const ownsDataDir = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-importtest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-importtest-storage-'));
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_USERNAME = ADMIN_USER;
  process.env.AUTH_PASSWORD = ADMIN_PASS;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authRouterMod = await import('../routes/auth.js');
  const modelsRouterMod = await import('../routes/models.js');
  const modelImportRouterMod = await import('../routes/modelImport.js');
  const zipImportDraftMod = await import('../services/zipImportDraft.js');

  const app = express();
  app.use(express.json());
  app.use('/', authRouterMod.default);
  app.use('/', modelsRouterMod.default);
  app.use('/', modelImportRouterMod.default);

  const db = dbMod.getDb();

  // Same boot-time sweep index.ts runs — exercised here explicitly so
  // the TTL-on-boot test can assert its effect without booting the full
  // app entrypoint.
  zipImportDraftMod.sweepExpiredDrafts();

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
    dataDir,
    storageDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbMod.closeDb();
      fs.rmSync(storageDir, { recursive: true, force: true });
      if (ownsDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
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

async function uploadZip(app: Booted, buf: Buffer, filename = 'import.zip'): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/zip' }), filename);
  return fetch(`${app.baseUrl}/import/zip`, { method: 'POST', headers: bearer(app.token), body: form });
}

interface DraftResponse {
  draftId: string;
  zipFilename: string;
  plan: {
    suggestedTitle: string;
    files: Array<{ path: string; role: string; invalid: boolean; invalidReason?: string }>;
    guessedSourceSite: string | null;
    descriptionSource: string | null;
    licenseFile: string | null;
    profileCandidates: string[];
  };
  expiresAt: number;
}

describe('POST /import/zip — draft creation + real-zip integration', () => {
  it('extracts a real zip, classifies it, and returns a draft plan (Printables shape)', async () => {
    const app = await bootApp();
    const zip = buildRawZip([
      { name: 'files/dragon_body.stl', content: 'stl bytes body' },
      { name: 'files/dragon_tail.stl', content: 'stl bytes tail' },
      { name: 'images/render1.jpg', content: 'jpg bytes' },
      { name: 'README.md', content: '# Dragon\nA nice dragon.' },
    ]);

    const res = await uploadZip(app, zip, 'articulated_dragon_printables.zip');
    expect(res.status).toBe(201);
    const body = await res.json() as DraftResponse;

    expect(body.draftId).toBeTruthy();
    expect(body.plan.guessedSourceSite).toBe('printables');
    expect(body.plan.descriptionSource).toBe('README.md');
    expect(body.plan.files).toHaveLength(4);
    expect(body.plan.files.find((f) => f.path === 'files/dragon_body.stl')?.role).toBe('part');
    expect(body.plan.files.find((f) => f.path === 'images/render1.jpg')?.role).toBe('image');
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Extracted to disk under the draft dir, not just held in memory.
    const draftDir = path.join(app.dataDir, 'import-drafts', body.draftId);
    expect(fs.existsSync(path.join(draftDir, 'files', 'dragon_body.stl'))).toBe(true);
    expect(fs.readFileSync(path.join(draftDir, 'README.md'), 'utf8')).toContain('A nice dragon');
  });

  it('full happy path: upload -> commit -> model exists with correct files, roles, and cover', async () => {
    const app = await bootApp();
    const zip = buildRawZip([
      { name: 'model.stl', content: 'the model bytes' },
      { name: 'cover.jpg', content: 'the cover image bytes' },
      { name: 'notes.pdf', content: 'the doc bytes' },
    ]);
    const draftRes = await uploadZip(app, zip, 'phone_stand_v2.zip');
    const draft = await draftRes.json() as DraftResponse;

    const commitRes = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({
        title: 'Phone Stand v2',
        sourceUrl: 'https://example.com/model/123',
        files: [
          { path: 'model.stl', role: 'part' },
          { path: 'cover.jpg', role: 'image' },
          { path: 'notes.pdf', role: 'doc' },
        ],
        coverPath: 'cover.jpg',
      }),
    });
    expect(commitRes.status).toBe(201);
    const { model } = await commitRes.json() as { model: { id: string; title: string; coverAssetId: string; sourceSite: string | null; files: Array<{ role: string; asset: { filename: string } }> } };

    expect(model.title).toBe('Phone Stand v2');
    expect(model.files).toHaveLength(3);
    // guessedSourceSite (makerworld, flat shape) carried through since
    // sourceSite wasn't explicitly overridden.
    expect(model.sourceSite).toBe('makerworld');

    const coverAsset = model.files.find((f) => f.asset.filename.includes('cover'));
    expect(coverAsset?.role).toBe('image');
    expect(model.coverAssetId).toBeTruthy();

    // Draft cleaned up after a successful commit.
    const draftDir = path.join(app.dataDir, 'import-drafts', draft.draftId);
    expect(fs.existsSync(draftDir)).toBe(false);

    const assetCount = (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c;
    expect(assetCount).toBe(3);
  });

  it('rejects a request with no file', async () => {
    const app = await bootApp();
    const form = new FormData();
    const res = await fetch(`${app.baseUrl}/import/zip`, { method: 'POST', headers: bearer(app.token), body: form });
    expect(res.status).toBe(400);
  });

  it('rejects a corrupt zip with a 400, and leaves no draft directory behind', async () => {
    const app = await bootApp();
    const res = await uploadZip(app, Buffer.from('not a zip at all'), 'bad.zip');
    expect(res.status).toBe(400);

    const draftsDir = path.join(app.dataDir, 'import-drafts');
    const leftoverDirs = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir) : [];
    expect(leftoverDirs).toHaveLength(0);
  });

  it('denies with no auth token', async () => {
    const app = await bootApp();
    const zip = buildRawZip([{ name: 'a.stl', content: 'x' }]);
    const form = new FormData();
    form.append('file', new Blob([zip]), 'a.zip');
    const res = await fetch(`${app.baseUrl}/import/zip`, { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });
});

describe('commit — hash-dedup', () => {
  it('links an existing asset by hash instead of creating a duplicate', async () => {
    const app = await bootApp();
    const sameContent = 'byte-identical content';

    // Pre-existing asset with known bytes on disk, same shape as
    // models.test.ts's insertAsset helper.
    const existingId = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(sameContent).digest('hex');
    app.db.prepare(
      `INSERT INTO assets (id, filename, mime, size, thumb_status, file_hash)
       VALUES (?, 'already-here.stl', 'application/octet-stream', ?, 'none', ?)`
    ).run(existingId, sameContent.length, hash);
    const existingDir = path.join(app.storageDir, existingId);
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'already-here.stl'), sameContent);

    const zip = buildRawZip([{ name: 'duplicate-name.stl', content: sameContent }]);
    const draftRes = await uploadZip(app, zip);
    const draft = await draftRes.json() as DraftResponse;

    const commitRes = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({
        title: 'Dedup Test',
        files: [{ path: 'duplicate-name.stl', role: 'part' }],
      }),
    });
    expect(commitRes.status).toBe(201);
    const { model } = await commitRes.json() as { model: { files: Array<{ assetId: string }> } };

    expect(model.files).toHaveLength(1);
    expect(model.files[0].assetId).toBe(existingId);

    const assetCount = (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c;
    expect(assetCount).toBe(1); // no second asset row created
  });

  it('dedups two selected files that hash to the same content without violating the model_files PK', async () => {
    const app = await bootApp();
    const zip = buildRawZip([
      { name: 'files/part.stl', content: 'identical bytes' },
      { name: 'spares/part.stl', content: 'identical bytes' },
    ]);
    const draftRes = await uploadZip(app, zip);
    const draft = await draftRes.json() as DraftResponse;

    const commitRes = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({
        title: 'Dup Content Test',
        files: [
          { path: 'files/part.stl', role: 'part' },
          { path: 'spares/part.stl', role: 'part' },
        ],
      }),
    });
    expect(commitRes.status).toBe(201);
    const { model } = await commitRes.json() as { model: { files: Array<{ assetId: string }> } };
    // Both paths resolved to the same asset (identical bytes) -- INSERT
    // OR IGNORE means the second link is a no-op, not a 500.
    expect(model.files).toHaveLength(1);

    const assetCount = (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c;
    expect(assetCount).toBe(1);
  });
});

describe('commit — zip-slip re-rejection', () => {
  it('hard-rejects a commit that references a path the plan flagged invalid', async () => {
    const app = await bootApp();
    const zip = buildRawZip([
      { name: '../../etc/passwd', content: 'hostile' },
      { name: 'legit.stl', content: 'fine bytes' },
    ]);
    const draftRes = await uploadZip(app, zip);
    const draft = await draftRes.json() as DraftResponse;

    const hostile = draft.plan.files.find((f) => f.path === '../../etc/passwd');
    expect(hostile?.invalid).toBe(true);

    const commitRes = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({
        title: 'Should Fail',
        files: [
          { path: '../../etc/passwd', role: 'other' },
          { path: 'legit.stl', role: 'part' },
        ],
      }),
    });
    expect(commitRes.status).toBe(400);

    // Nothing was created -- the whole commit was rejected, not a partial one.
    const modelCount = (app.db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number }).c;
    expect(modelCount).toBe(0);
  });

  it('commits successfully when only the legitimate path (from the same hostile zip) is selected', async () => {
    const app = await bootApp();
    const zip = buildRawZip([
      { name: '../../etc/passwd', content: 'hostile' },
      { name: 'legit.stl', content: 'fine bytes' },
    ]);
    const draftRes = await uploadZip(app, zip);
    const draft = await draftRes.json() as DraftResponse;

    const commitRes = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Only Legit', files: [{ path: 'legit.stl', role: 'part' }] }),
    });
    expect(commitRes.status).toBe(201);
  });

  it('rejects a commit path that is not in the original plan at all (tampered/replayed)', async () => {
    const app = await bootApp();
    const zip = buildRawZip([{ name: 'legit.stl', content: 'fine bytes' }]);
    const draftRes = await uploadZip(app, zip);
    const draft = await draftRes.json() as DraftResponse;

    const commitRes = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'Tampered', files: [{ path: '../../../etc/hosts', role: 'other' }] }),
    });
    expect(commitRes.status).toBe(400);
  });
});

describe('draft lifecycle', () => {
  it('DELETE removes an active draft; a second DELETE 404s', async () => {
    const app = await bootApp();
    const zip = buildRawZip([{ name: 'a.stl', content: 'x' }]);
    const draftRes = await uploadZip(app, zip);
    const draft = await draftRes.json() as DraftResponse;

    const del1 = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(del1.status).toBe(204);

    const del2 = await fetch(`${app.baseUrl}/import/zip/${draft.draftId}`, { method: 'DELETE', headers: bearer(app.token) });
    expect(del2.status).toBe(404);

    expect(fs.existsSync(path.join(app.dataDir, 'import-drafts', draft.draftId))).toBe(false);
  });

  it('commit 404s for an unknown draft id', async () => {
    const app = await bootApp();
    const res = await fetch(`${app.baseUrl}/import/zip/does-not-exist/commit`, {
      method: 'POST',
      headers: jsonHeaders(app.token),
      body: JSON.stringify({ title: 'X', files: [{ path: 'a.stl', role: 'part' }] }),
    });
    expect(res.status).toBe(404);
  });

  it('sweeps an expired draft on the next boot against the same data directory, while a fresh draft from that same boot survives', async () => {
    const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-importtest-ttl-'));

    const app1 = await bootApp({ dataDir: sharedDataDir });
    const zip = buildRawZip([{ name: 'a.stl', content: 'x' }]);
    const draftRes = await uploadZip(app1, zip);
    const draft = await draftRes.json() as DraftResponse;

    // Age the draft's sidecar past the TTL, simulating "this was created
    // two days ago" without waiting two real days.
    const metaPath = path.join(sharedDataDir, 'import-drafts', draft.draftId, '.draft-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { createdAt: number };
    const { DRAFT_TTL_MS } = await import('../services/zipImportDraft.js');
    meta.createdAt = Date.now() - DRAFT_TTL_MS - 1000;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    await app1.close();

    // Second "boot" against the SAME data dir, simulating a server
    // restart. bootApp's zipImportDraftMod.sweepExpiredDrafts() call
    // mirrors index.ts's boot-time sweep exactly.
    const app2 = await bootApp({ dataDir: sharedDataDir });
    expect(fs.existsSync(path.join(sharedDataDir, 'import-drafts', draft.draftId))).toBe(false);

    // A brand new draft created during this second boot is NOT swept by
    // its own creation (sweep runs BEFORE the new draft is written).
    const zip2 = buildRawZip([{ name: 'b.stl', content: 'y' }]);
    const draft2Res = await uploadZip(app2, zip2);
    expect(draft2Res.status).toBe(201);
    const draft2 = await draft2Res.json() as DraftResponse;
    expect(fs.existsSync(path.join(sharedDataDir, 'import-drafts', draft2.draftId))).toBe(true);

    fs.rmSync(sharedDataDir, { recursive: true, force: true });
  });
});
