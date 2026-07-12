// Tests for the mount-rescan auto-versioning fix (services/mountImport.ts,
// scanSingleMount()) — the core of Bet 1
// (Reports/sloane-prd-thefabvault-file-versioning-2026-07-11.md).
//
// Before this fix, dedup on a known source_path was a blind skip with no
// hashing at all — a re-sliced file at the same path was a silent,
// permanent no-op. These tests pin the three-way outcome the PRD's
// acceptance criteria describe: genuinely new -> imported, content
// changed at a known path -> versioned (auto archive-and-replace, zero
// duplicate asset rows), content unchanged at a known path -> skipped,
// including the mtime pre-filter that avoids re-hashing when nothing on
// disk actually moved (feasibility Q1).
//
// Same vi.resetModules()+fresh-temp-dirs-per-fixture style as
// auth.test.ts/assetVersion.test.ts — db.ts and fileStore.ts cache
// module-level singletons keyed off DATA_DIR/STORAGE_DIR env vars, and
// this suite needs a real (throwaway) DB + real (throwaway) storage dir
// + a real (throwaway) "mount" directory to exercise the real fs.statSync
// / fs.readFileSync code path scanSingleMount() actually runs in
// production — not a mocked stand-in for it.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { AssetRow, ScanResult } from '../types/index.js';

interface Fixture {
  db: Database.Database;
  scanSingleMount: (mountPath: string) => Promise<ScanResult>;
  scanMountImports: () => Promise<ScanResult>;
  AUTO_VERSION_NOTE: string;
  mountDir: string;
  close: () => void;
}

const booted: Fixture[] = [];

async function bootFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-mounttest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-mounttest-storage-'));
  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-mounttest-mount-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;

  vi.resetModules();

  const dbMod = await import('../db.js');
  const mountImportMod = await import('../services/mountImport.js');

  const db = dbMod.getDb(); // runs all migrations, including v14

  const fixture: Fixture = {
    db,
    scanSingleMount: mountImportMod.scanSingleMount,
    scanMountImports: mountImportMod.scanMountImports,
    AUTO_VERSION_NOTE: mountImportMod.AUTO_VERSION_NOTE,
    mountDir,
    close: () => {
      dbMod.closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(storageDir, { recursive: true, force: true });
      fs.rmSync(mountDir, { recursive: true, force: true });
    },
  };
  booted.push(fixture);
  return fixture;
}

afterEach(() => {
  while (booted.length) booted.pop()?.close();
  delete process.env.DATA_DIR;
  delete process.env.STORAGE_DIR;
  delete process.env.IMPORT_MOUNT_PATHS;
});

function getAssetBySourcePath(fx: Fixture, sourcePath: string): AssetRow {
  const row = fx.db.prepare('SELECT * FROM assets WHERE source_path = ?').get(sourcePath) as AssetRow | undefined;
  if (!row) throw new Error(`test setup: no asset row for source_path ${sourcePath}`);
  return row;
}

function countAssetVersions(fx: Fixture, assetId: string): number {
  return (fx.db.prepare('SELECT COUNT(*) as n FROM asset_versions WHERE asset_id = ?').get(assetId) as { n: number }).n;
}

/** Bump a file's mtime by +5s without necessarily changing its content — deterministic across filesystem timestamp granularities (avoids flaky same-millisecond writes). */
function bumpMtime(filePath: string): void {
  const current = fs.statSync(filePath).mtime;
  const bumped = new Date(current.getTime() + 5000);
  fs.utimesSync(filePath, bumped, bumped);
}

// Important architectural fact these tests are written around: a
// genuinely-NEW-file import MOVES the file out of the mount directory
// into vault storage (services/mountImport.ts's moveFile(), pre-existing,
// untouched by this bet) — the mount dir is an inbox, not a mirror. So
// "Aaron re-slices in place at the same NAS path" really means: a fresh
// file reappears at that path later (his slicer re-exporting there),
// not "the original file we imported is still sitting there." Every
// test below writes the file fresh for each round to model that
// accurately, rather than assuming the first-imported file persists.
// The known-path/auto-version branch (unlike new-file import) does NOT
// delete the source after archiving — it has to still be there for the
// NEXT rescan to compare against, which is exactly what lets a later,
// truly-unchanged rescan take the cheap mtime-skip path.

describe('scanSingleMount — genuinely new files', () => {
  it('imports a new file, moves it out of the mount dir, and records a source_mtime_ms baseline matching the file\'s real mtime at import time', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1 content');
    const statBeforeImport = fs.statSync(filePath); // captured before scan moves the file out

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result).toEqual({ imported: 1, versioned: 0, skipped: 0, failed: 0 });
    expect(fs.existsSync(filePath)).toBe(false); // moved into vault storage, inbox cleared

    const asset = getAssetBySourcePath(fx, path.resolve(filePath));
    expect(asset.source_mtime_ms).not.toBeNull();
    expect(asset.source_mtime_ms).toBe(Math.round(statBeforeImport.mtimeMs));
  });
});

describe('scanSingleMount — acceptance criterion 2: unchanged file at a known path', () => {
  it('resolves to a plain skip with no version and no false positive when a file reappears at the same path with byte-identical content and an identical mtime (mtime pre-filter, Q1: no hash read needed)', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1 content');
    await fx.scanSingleMount(fx.mountDir); // imports it, moves it out
    const asset = getAssetBySourcePath(fx, path.resolve(filePath));

    // Simulate the file reappearing with the exact same content AND the
    // exact same mtime baseline already recorded — this is the case
    // that must resolve without ever reading/hashing the bytes.
    fs.writeFileSync(filePath, 'v1 content');
    const targetMtime = new Date(asset.source_mtime_ms!);
    fs.utimesSync(filePath, targetMtime, targetMtime);
    expect(Math.round(fs.statSync(filePath).mtimeMs)).toBe(asset.source_mtime_ms); // fixture sanity check

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result).toEqual({ imported: 0, versioned: 0, skipped: 1, failed: 0 });
    expect(countAssetVersions(fx, asset.id)).toBe(0);
  });

  it('a metadata-only mtime bump (touch, remount churn) with byte-identical content still resolves to a skip, not a version — and refreshes the baseline', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1 content');
    await fx.scanSingleMount(fx.mountDir);
    const asset = getAssetBySourcePath(fx, path.resolve(filePath));
    const originalMtime = asset.source_mtime_ms;

    // File reappears with identical bytes but a naturally later mtime
    // (fresh write) — the case that DOES need a hash read to confirm
    // "unchanged," unlike the exact-mtime-match case above.
    fs.writeFileSync(filePath, 'v1 content');

    bumpMtime(filePath); // mtime moves, bytes do not

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result).toEqual({ imported: 0, versioned: 0, skipped: 1, failed: 0 });
    expect(countAssetVersions(fx, asset.id)).toBe(0);

    // Baseline was refreshed to the new mtime (so a THIRD scan takes the
    // cheap mtime-unchanged path again, instead of re-hashing forever).
    const refreshed = getAssetBySourcePath(fx, path.resolve(filePath));
    expect(refreshed.source_mtime_ms).not.toBe(originalMtime);
    expect(refreshed.source_mtime_ms).toBe(Math.round(fs.statSync(filePath).mtimeMs));
    expect(refreshed.file_hash).toBe(asset.file_hash); // hash unchanged
  });
});

describe('scanSingleMount — acceptance criterion 1: content change at a known path (the core fix)', () => {
  it('re-slicing a file in place is detected and auto-versioned: hash/size updated, prior bytes archived, restorable, zero duplicate asset rows', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1 content');
    await fx.scanSingleMount(fx.mountDir);
    const before = getAssetBySourcePath(fx, path.resolve(filePath));

    fs.writeFileSync(filePath, 'v2 content, re-sliced');
    bumpMtime(filePath);

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result).toEqual({ imported: 0, versioned: 1, skipped: 0, failed: 0 });

    // Never a second asset row for the same source_path.
    const totalAssets = (fx.db.prepare('SELECT COUNT(*) as n FROM assets').get() as { n: number }).n;
    expect(totalAssets).toBe(1);

    const after = getAssetBySourcePath(fx, path.resolve(filePath));
    expect(after.id).toBe(before.id); // same asset row, updated in place
    expect(after.file_hash).toBe(crypto.createHash('sha256').update('v2 content, re-sliced').digest('hex'));
    expect(after.size).toBe(Buffer.byteLength('v2 content, re-sliced'));
    expect(after.source_mtime_ms).toBe(Math.round(fs.statSync(filePath).mtimeMs));

    // Exactly one archived version, holding the OLD content, with the
    // system-authored origin marker — restorable via the same mechanism
    // VersionPanel's restore action uses (versionFilePath).
    expect(countAssetVersions(fx, after.id)).toBe(1);
    const version = fx.db.prepare('SELECT * FROM asset_versions WHERE asset_id = ?').get(after.id) as {
      id: string; version_num: number; notes: string | null; file_hash: string | null;
    };
    expect(version.version_num).toBe(1);
    expect(version.notes).toBe(fx.AUTO_VERSION_NOTE);
    expect(version.file_hash).toBe(before.file_hash);

    const { versionFilePath, assetFilePath } = await import('../services/fileStore.js');
    expect(fs.readFileSync(versionFilePath(after.id, version.id, before.filename), 'utf-8')).toBe('v1 content');
    expect(fs.readFileSync(assetFilePath(after.id, after.filename), 'utf-8')).toBe('v2 content, re-sliced');
  });

  it('a second re-slice on the already-versioned asset creates version 2, not a duplicate asset', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    await fx.scanSingleMount(fx.mountDir);

    fs.writeFileSync(filePath, 'v2');
    bumpMtime(filePath);
    await fx.scanSingleMount(fx.mountDir);

    fs.writeFileSync(filePath, 'v3');
    bumpMtime(filePath);
    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result.versioned).toBe(1);

    const asset = getAssetBySourcePath(fx, path.resolve(filePath));
    expect(countAssetVersions(fx, asset.id)).toBe(2);
    const totalAssets = (fx.db.prepare('SELECT COUNT(*) as n FROM assets').get() as { n: number }).n;
    expect(totalAssets).toBe(1);
  });

  it('a hash that was never captured at import time (null file_hash) is treated as "must version," never assumed unchanged', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    await fx.scanSingleMount(fx.mountDir);
    const asset = getAssetBySourcePath(fx, path.resolve(filePath));

    // Simulate the pre-existing "hash failure at import" edge case
    // (mountImport.ts already tolerates a null file_hash on new-file
    // import — see the try/catch around the hash computation).
    fx.db.prepare('UPDATE assets SET file_hash = NULL WHERE id = ?').run(asset.id);

    fs.writeFileSync(filePath, 'v2');
    bumpMtime(filePath);

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result.versioned).toBe(1);
    expect(countAssetVersions(fx, asset.id)).toBe(1);
  });

  // ─── Remy's peer-review Finding 1 (HIGH), 2026-07-11 ──────────────────
  // Remy reproduced this directly against the real scanSingleMount(): a
  // timestamp-preserving copy/sync tool (cp -p, rsync -a/-t, a re-export
  // pipeline that intentionally carries the source mtime forward) can
  // re-stamp the EXACT prior mtime on materially different content. An
  // mtime-only pre-filter treats that as "unchanged" and skips forever —
  // the same silent-no-op bug this whole feature exists to eliminate,
  // just reintroduced at the pre-filter layer. Fix: also require size to
  // match before trusting the mtime match.
  it('a re-slice whose mtime is re-stamped to the exact prior value (cp -p / rsync -t style) is still detected and versioned, because size no longer matches', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1 content');
    await fx.scanSingleMount(fx.mountDir);
    const before = getAssetBySourcePath(fx, path.resolve(filePath));
    const originalMtimeMs = before.source_mtime_ms!;

    // Materially different content, different size — but re-stamp the
    // mtime back to the EXACT baseline value, exactly like a
    // timestamp-preserving copy would.
    const newContent = 'v2 content, re-sliced with a materially different byte count';
    expect(Buffer.byteLength(newContent)).not.toBe(before.size); // fixture sanity check
    fs.writeFileSync(filePath, newContent);
    const restamped = new Date(originalMtimeMs);
    fs.utimesSync(filePath, restamped, restamped);
    expect(Math.round(fs.statSync(filePath).mtimeMs)).toBe(originalMtimeMs); // fixture sanity check — mtime genuinely unchanged

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result).toEqual({ imported: 0, versioned: 1, skipped: 0, failed: 0 });

    const after = getAssetBySourcePath(fx, path.resolve(filePath));
    expect(after.id).toBe(before.id); // same asset row, zero duplicates
    expect(after.file_hash).toBe(crypto.createHash('sha256').update(newContent).digest('hex'));
    expect(after.size).toBe(Buffer.byteLength(newContent));
    expect(countAssetVersions(fx, after.id)).toBe(1); // the original content was archived, not silently dropped
  });

  it('an mtime re-stamped to the exact prior value on genuinely byte-identical content still resolves to a skip (the size check does not introduce a false positive)', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1 content');
    await fx.scanSingleMount(fx.mountDir);
    const before = getAssetBySourcePath(fx, path.resolve(filePath));

    fs.writeFileSync(filePath, 'v1 content'); // byte-identical
    const restamped = new Date(before.source_mtime_ms!);
    fs.utimesSync(filePath, restamped, restamped);

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result).toEqual({ imported: 0, versioned: 0, skipped: 1, failed: 0 });
    expect(countAssetVersions(fx, before.id)).toBe(0);
  });
});

describe('scanSingleMount — trashed assets are inert to the scanner', () => {
  it('a content change at a known path belonging to a trashed asset stays a skip — no auto-version of a deleted file', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    await fx.scanSingleMount(fx.mountDir);
    const asset = getAssetBySourcePath(fx, path.resolve(filePath));
    fx.db.prepare('UPDATE assets SET deleted_at = unixepoch() WHERE id = ?').run(asset.id);

    fs.writeFileSync(filePath, 'v2');
    bumpMtime(filePath);

    const result = await fx.scanSingleMount(fx.mountDir);
    expect(result.versioned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(countAssetVersions(fx, asset.id)).toBe(0);

    const unchanged = fx.db.prepare('SELECT file_hash, filename FROM assets WHERE id = ?').get(asset.id) as {
      file_hash: string | null; filename: string;
    };
    expect(unchanged.file_hash).toBe(asset.file_hash); // untouched
  });
});

describe('scanMountImports — aggregate reducer carries the versioned bucket', () => {
  it('sums versioned across the reduce alongside imported/skipped/failed', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    process.env.IMPORT_MOUNT_PATHS = fx.mountDir;

    const first = await fx.scanMountImports();
    expect(first).toEqual({ imported: 1, versioned: 0, skipped: 0, failed: 0 });

    fs.writeFileSync(filePath, 'v2');
    bumpMtime(filePath);

    const second = await fx.scanMountImports();
    expect(second).toEqual({ imported: 0, versioned: 1, skipped: 0, failed: 0 });
  });
});

// ─── Remy's peer-review Finding 2 (MEDIUM), 2026-07-11 ───────────────────
// Both real production entry points (the fire-and-forget startup scan and
// the — as of this PR — actually-wired-up manual "Scan mounts" button)
// call scanMountImports() with nothing preventing a second call from
// starting while the first is still walking a mount. Traced consequence:
// scan B's existingByPath snapshot goes stale mid-scan-A, and B can
// re-version an asset A already versioned, producing an asset_versions
// row whose recorded metadata doesn't match what it actually archived.
// Fix: a module-level in-flight promise so a second concurrent call
// reuses the first call's result instead of starting an overlapping pass.
describe('scanMountImports — overlapping-scan guard', () => {
  it('two scanMountImports() calls fired without awaiting between them share one in-flight run instead of racing', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    process.env.IMPORT_MOUNT_PATHS = fx.mountDir;

    const p1 = fx.scanMountImports();
    const p2 = fx.scanMountImports(); // fired before p1 has been awaited

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both callers got the exact same result object — proof they shared
    // one run rather than two independent (and potentially racing) passes.
    expect(r1).toBe(r2);
    expect(r1).toEqual({ imported: 1, versioned: 0, skipped: 0, failed: 0 });

    // Only one asset row exists — a second overlapping pass did not
    // reprocess the same file independently.
    const totalAssets = (fx.db.prepare('SELECT COUNT(*) as n FROM assets').get() as { n: number }).n;
    expect(totalAssets).toBe(1);
  });

  it('does not corrupt a version-history entry the way an unguarded overlap would: a content change picked up by an in-flight scan is versioned exactly once, not twice, when a second call arrives mid-scan', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    await fx.scanSingleMount(fx.mountDir); // establish the known asset first
    const before = getAssetBySourcePath(fx, path.resolve(filePath));

    fs.writeFileSync(filePath, 'v2, re-sliced');
    bumpMtime(filePath);
    process.env.IMPORT_MOUNT_PATHS = fx.mountDir;

    // Two "concurrent" callers hitting the changed file at once — before
    // the guard, this is exactly Remy's traced scenario (scan B stale-
    // reads scan A's in-progress work).
    const [r1, r2] = await Promise.all([fx.scanMountImports(), fx.scanMountImports()]);
    expect(r1).toBe(r2);
    expect(r1).toEqual({ imported: 0, versioned: 1, skipped: 0, failed: 0 });

    const after = getAssetBySourcePath(fx, path.resolve(filePath));
    expect(countAssetVersions(fx, after.id)).toBe(1); // not 2

    // The single archived version's recorded metadata matches what it
    // actually archived (the true original content) — the exact
    // consistency property Remy's traced race would have broken.
    const version = fx.db.prepare('SELECT * FROM asset_versions WHERE asset_id = ?').get(after.id) as {
      id: string; file_hash: string | null;
    };
    expect(version.file_hash).toBe(before.file_hash);
    const { versionFilePath } = await import('../services/fileStore.js');
    expect(fs.readFileSync(versionFilePath(after.id, version.id, before.filename), 'utf-8')).toBe('v1');
  });

  it('the guard releases after a scan completes — a later, genuinely sequential scan is not stuck reusing a stale finished result', async () => {
    const fx = await bootFixture();
    const filePath = path.join(fx.mountDir, 'part.cdr');
    fs.writeFileSync(filePath, 'v1');
    process.env.IMPORT_MOUNT_PATHS = fx.mountDir;

    const first = await fx.scanMountImports();
    expect(first.imported).toBe(1);

    fs.writeFileSync(filePath, 'v2');
    bumpMtime(filePath);

    const second = await fx.scanMountImports();
    expect(second.versioned).toBe(1); // genuinely re-ran, not a cached first-run result
  });
});
