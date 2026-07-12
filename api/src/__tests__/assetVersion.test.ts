// Tests for the shared archive-and-replace mechanism
// (services/assetVersion.ts) behind POST /asset/:id/version (the
// VersionPanel's explicit "upload new version" action).
//
// Why the vi.resetModules() + fresh DATA_DIR/STORAGE_DIR-per-fixture
// style instead of the in-memory-DB style used by
// manifestRollup.test.ts/subAssemblyImport.test.ts: assetVersion.ts
// deliberately reuses fileStore.ts's real assetFilePath/versionFilePath
// helpers (so the test exercises the exact path-resolution production
// uses), and those are pinned to a module-level STORAGE_DIR constant
// resolved from config at import time — same reasoning as
// auth.test.ts's bootApp(). Each fixture gets its own real (throwaway)
// on-disk SQLite file and its own real (throwaway) storage directory.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { AssetRow } from '../types/index.js';

interface Fixture {
  db: Database.Database;
  archiveAndReplaceAssetFile: typeof import('../services/assetVersion.js').archiveAndReplaceAssetFile;
  assetFilePath: typeof import('../services/fileStore.js').assetFilePath;
  versionFilePath: typeof import('../services/fileStore.js').versionFilePath;
  close: () => void;
}

const booted: Fixture[] = [];

async function bootFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-avtest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-avtest-storage-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const fileStoreMod = await import('../services/fileStore.js');
  const assetVersionMod = await import('../services/assetVersion.js');

  const db = dbMod.getDb(); // runs all migrations, including v14

  const fixture: Fixture = {
    db,
    archiveAndReplaceAssetFile: assetVersionMod.archiveAndReplaceAssetFile,
    assetFilePath: fileStoreMod.assetFilePath,
    versionFilePath: fileStoreMod.versionFilePath,
    close: () => {
      dbMod.closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
  booted.push(fixture);
  return fixture;
}

afterEach(() => {
  while (booted.length) booted.pop()?.close();
  delete process.env.DATA_DIR;
  delete process.env.STORAGE_DIR;
});

/** Insert a minimal-but-real asset row + live file, return the full AssetRow. */
function makeAsset(fx: Fixture, content: string, filename = 'part.bin'): AssetRow {
  const id = uuidv4();
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  fx.db.prepare(
    `INSERT INTO assets (id, filename, original_name, mime, size, tags_json, thumb_status, meta_json, file_hash)
     VALUES (?, ?, ?, 'application/octet-stream', ?, '[]', 'none', '{}', ?)`
  ).run(id, filename, filename, Buffer.byteLength(content), hash);

  fs.writeFileSync(fx.assetFilePath(id, filename), content);

  return fx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow;
}

describe('archiveAndReplaceAssetFile', () => {
  it('archives the prior bytes, replaces the live file, and updates the asset row in place — zero duplicate asset rows', async () => {
    const fx = await bootFixture();
    const asset = makeAsset(fx, 'v1 content');

    const { asset: updated, versionId, versionNum } = fx.archiveAndReplaceAssetFile(
      fx.db, asset, Buffer.from('v2 content'), 'part.bin', 'manual note',
    );

    expect(versionNum).toBe(1);
    expect(updated.id).toBe(asset.id);
    expect(updated.file_hash).toBe(crypto.createHash('sha256').update('v2 content').digest('hex'));
    expect(updated.size).toBe(Buffer.byteLength('v2 content'));

    // Live file now holds the new content.
    expect(fs.readFileSync(fx.assetFilePath(asset.id, 'part.bin'), 'utf-8')).toBe('v2 content');

    // Exactly one archived version, holding the OLD content — restorable.
    const versions = fx.db.prepare('SELECT * FROM asset_versions WHERE asset_id = ?').all(asset.id) as Array<{
      id: string; version_num: number; filename: string; size: number; file_hash: string | null; notes: string | null;
    }>;
    expect(versions.length).toBe(1);
    expect(versions[0].id).toBe(versionId);
    expect(versions[0].version_num).toBe(1);
    expect(versions[0].notes).toBe('manual note');
    expect(versions[0].file_hash).toBe(crypto.createHash('sha256').update('v1 content').digest('hex'));
    expect(fs.readFileSync(fx.versionFilePath(asset.id, versionId, 'part.bin'), 'utf-8')).toBe('v1 content');

    // Never a second asset row for the same logical file.
    const assetCount = (fx.db.prepare('SELECT COUNT(*) as n FROM assets').get() as { n: number }).n;
    expect(assetCount).toBe(1);
  });

  it('a second version bumps version_num to 2 and preserves both archives independently', async () => {
    const fx = await bootFixture();
    const asset = makeAsset(fx, 'v1');

    const first = fx.archiveAndReplaceAssetFile(fx.db, asset, Buffer.from('v2'), 'part.bin', null);
    const second = fx.archiveAndReplaceAssetFile(fx.db, first.asset, Buffer.from('v3'), 'part.bin', null);

    expect(first.versionNum).toBe(1);
    expect(second.versionNum).toBe(2);

    const versions = fx.db.prepare(
      'SELECT version_num FROM asset_versions WHERE asset_id = ? ORDER BY version_num'
    ).all(asset.id) as Array<{ version_num: number }>;
    expect(versions.map((v) => v.version_num)).toEqual([1, 2]);

    expect(fs.readFileSync(fx.versionFilePath(asset.id, first.versionId, 'part.bin'), 'utf-8')).toBe('v1');
    expect(fs.readFileSync(fx.versionFilePath(asset.id, second.versionId, 'part.bin'), 'utf-8')).toBe('v2');
    expect(fs.readFileSync(fx.assetFilePath(asset.id, 'part.bin'), 'utf-8')).toBe('v3');
  });

  // ─── Q2: race safety on version_num ────────────────────────────────────
  // Reports/sloane-prd-thefabvault-file-versioning-2026-07-11.md asks Kit
  // to confirm whether UNIQUE(asset_id, version_num) is sufficient — i.e.
  // a collision fails loudly rather than silently corrupting data — or
  // whether the new scan-triggered path needs its own lock.

  it('the schema-level UNIQUE(asset_id, version_num) constraint rejects a duplicate insert (fails loudly)', async () => {
    const fx = await bootFixture();
    const asset = makeAsset(fx, 'v1');
    fx.archiveAndReplaceAssetFile(fx.db, asset, Buffer.from('v2'), 'part.bin', null); // creates version_num 1

    expect(() => {
      fx.db.prepare(
        `INSERT INTO asset_versions (id, asset_id, version_num, filename, size, file_hash, notes)
         VALUES (?, ?, 1, 'part.bin', 2, 'deadbeef', 'forced collision')`
      ).run(uuidv4(), asset.id);
    }).toThrowError(/UNIQUE constraint failed/);

    // The failed insert didn't leave a second row behind.
    const count = (fx.db.prepare('SELECT COUNT(*) as n FROM asset_versions WHERE asset_id = ? AND version_num = 1')
      .get(asset.id) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('two archiveAndReplaceAssetFile calls dispatched via microtask scheduling (the closest thing to "concurrent" callers in this single-process, fully-synchronous-per-call architecture) still get distinct, gapless version numbers', async () => {
    // archiveAndReplaceAssetFile has no `await` anywhere in its body — it
    // is 100% synchronous (better-sqlite3 + sync fs calls). Scheduling
    // both calls via Promise.resolve().then() simulates two "concurrent"
    // async callers without being able to actually interleave them:
    // Node's run-to-completion semantics guarantee the first .then()
    // callback's entire synchronous body finishes before the second one
    // starts.
    // That's the structural argument in assetVersion.ts's header comment,
    // pinned here as an executable proof rather than left as a claim.
    const fx = await bootFixture();
    const asset = makeAsset(fx, 'v1');

    const results = await Promise.all([
      Promise.resolve().then(() => fx.archiveAndReplaceAssetFile(fx.db, asset, Buffer.from('v2'), 'part.bin', 'first')),
      Promise.resolve().then(() => fx.archiveAndReplaceAssetFile(fx.db, asset, Buffer.from('v3'), 'part.bin', 'second')),
    ]);

    const versionNums = results.map((r) => r.versionNum).sort((a, b) => a - b);
    expect(versionNums).toEqual([1, 2]); // no collision, no gap

    const versions = fx.db.prepare(
      'SELECT version_num FROM asset_versions WHERE asset_id = ?'
    ).all(asset.id) as Array<{ version_num: number }>;
    expect(versions.length).toBe(2); // never a duplicate version_num, never a lost write
  });

  it('renaming on version upload removes the old filename and leaves only the new one live', async () => {
    const fx = await bootFixture();
    const asset = makeAsset(fx, 'v1', 'old-name.bin');

    fx.archiveAndReplaceAssetFile(fx.db, asset, Buffer.from('v2'), 'new-name.bin', null);

    expect(fs.existsSync(fx.assetFilePath(asset.id, 'old-name.bin'))).toBe(false);
    expect(fs.existsSync(fx.assetFilePath(asset.id, 'new-name.bin'))).toBe(true);
    const updated = fx.db.prepare('SELECT filename FROM assets WHERE id = ?').get(asset.id) as { filename: string };
    expect(updated.filename).toBe('new-name.bin');
  });
});
