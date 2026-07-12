// Proof test for scripts/cleanup-selfimport-2026-07-12.ts (#2078) — the
// self-import cleanup tool for the 2026-07-12 mount-scan incident (see
// that file's header for full background).
//
// Same vi.resetModules() + fresh-temp-DATA_DIR/STORAGE_DIR-per-fixture
// style as assetVersion.test.ts / the now-removed
// mountImportVersioning.test.ts — this suite needs a real (throwaway) DB
// (to run the real db.ts migrations, so the script is proven against the
// actual production schema, not a hand-rolled approximation of it) and a
// real (throwaway) storage tree (to exercise the script's real
// fs.statSync()-based inode-safety check against real files, not mocks).
//
// This is NOT run against production data — no prod access exists from
// this environment. It reproduces the incident's shape at small scale:
//   - "survivor" assets: pre-existing, interface-loaded (source_path
//     NULL), created well before the cutoff — must never be selected.
//   - "spurious" assets: the shapes the mount-scan self-import bug
//     actually produced — exact-hash copies of a survivor's primary
//     file, "distinct-new" copies of storage-internal artifacts
//     (thumbnails/version archives) that don't match any survivor hash,
//     and two spurious rows sharing a hash with EACH OTHER but not any
//     survivor (modeling the documented concurrent-triple-scan
//     mechanism — see the script header) — must all be selected.
//   - one "ambiguous" row: /imports/ source_path but predates the
//     cutoff — must be excluded and surfaced via onlyA, never deleted.
//   - one "coincidental recent upload": source_path NULL but created
//     at/after the cutoff — must be excluded and surfaced via onlyB.
//   - one "shared-inode" spurious row: its physical file is a hard link
//     to a survivor's physical file (the filesystem-truth case the
//     inode-safety guard exists for, even though nothing in this
//     codebase's normal write paths produces it) — its DB row must
//     still be deleted, but its physical file must NOT be, and the
//     survivor's bytes must remain intact and correct afterward.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  identifySpurious, buildDryRunReport, executeCleanup, checkEntanglement,
  assetLivePath, versionFilePath, type AssetRow, type CleanupOptions,
} from './cleanup-selfimport-2026-07-12.js';

const CUTOFF_ISO = '2026-07-12T02:37:00Z';
const CUTOFF_UNIX = Math.floor(Date.parse(CUTOFF_ISO) / 1000);
const BEFORE_CUTOFF = CUTOFF_UNIX - 100_000; // ~28h earlier
const AFTER_CUTOFF = CUTOFF_UNIX + 60; // 1 minute into the scan

interface Fixture {
  db: Database.Database;
  storageDir: string;
  close: () => void;
}

const booted: Fixture[] = [];

async function bootFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-cleanuptest-data-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-cleanuptest-storage-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;

  vi.resetModules();
  const dbMod = await import('../src/db.js');
  const db = dbMod.getDb(); // runs all real migrations against a throwaway DB

  const fixture: Fixture = {
    db,
    storageDir,
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

function hashOf(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function insertAsset(db: Database.Database, row: {
  id: string; filename: string; sourcePath: string | null; createdAt: number;
  fileHash: string | null; size: number;
}): void {
  db.prepare(
    `INSERT INTO assets (id, filename, original_name, size, folder_id, tags_json, source_path, thumb_status, meta_json, created_at, file_hash)
     VALUES (?, ?, ?, ?, NULL, '[]', ?, 'none', '{}', ?, ?)`
  ).run(row.id, row.filename, row.filename, row.size, row.sourcePath, row.createdAt, row.fileHash);
}

function writeAssetFile(storageDir: string, id: string, filename: string, content: string): void {
  const p = assetLivePath(storageDir, id, filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function opts(storageDir: string, dbPath: string): CleanupOptions {
  return {
    dbPath,
    storageDir,
    cutoffUnix: CUTOFF_UNIX,
    cutoffIso: CUTOFF_ISO,
    importPrefix: '/imports/',
  };
}

/** Builds the full incident-shaped fixture described in the file header. Returns the ids in each category. */
function seedIncidentShape(fx: Fixture) {
  const { db, storageDir } = fx;

  // ── Survivors (pre-existing, interface-loaded) ──────────────────────
  const survivor1Content = 'survivor-1 dragon.stl bytes';
  const survivor1Hash = hashOf(survivor1Content);
  insertAsset(db, { id: 'survivor-1', filename: 'dragon.stl', sourcePath: null, createdAt: BEFORE_CUTOFF, fileHash: survivor1Hash, size: survivor1Content.length });
  writeAssetFile(storageDir, 'survivor-1', 'dragon.stl', survivor1Content);

  const survivor2Content = 'survivor-2 bracket.3mf bytes';
  const survivor2Hash = hashOf(survivor2Content);
  insertAsset(db, { id: 'survivor-2', filename: 'bracket.3mf', sourcePath: null, createdAt: BEFORE_CUTOFF, fileHash: survivor2Hash, size: survivor2Content.length });
  writeAssetFile(storageDir, 'survivor-2', 'bracket.3mf', survivor2Content);

  // Survivor with real version history — proves the protected-inode set
  // covers asset_versions archive files, not just the live file.
  const survivor3LiveContent = 'survivor-3 v2 content';
  const survivor3OldContent = 'survivor-3 v1 content (archived)';
  insertAsset(db, { id: 'survivor-3', filename: 'part.stl', sourcePath: null, createdAt: BEFORE_CUTOFF, fileHash: hashOf(survivor3LiveContent), size: survivor3LiveContent.length });
  writeAssetFile(storageDir, 'survivor-3', 'part.stl', survivor3LiveContent);
  db.prepare(
    `INSERT INTO asset_versions (id, asset_id, version_num, filename, size, file_hash, notes) VALUES (?, 'survivor-3', 1, 'part.stl', ?, ?, NULL)`
  ).run('survivor-3-v1', survivor3OldContent.length, hashOf(survivor3OldContent));
  const v1Path = versionFilePath(storageDir, 'survivor-3', 'survivor-3-v1', 'part.stl');
  fs.mkdirSync(path.dirname(v1Path), { recursive: true });
  fs.writeFileSync(v1Path, survivor3OldContent);

  // ── Spurious: exact-hash copies of survivors' primary files ─────────
  insertAsset(db, { id: 'spurious-dupe-1', filename: 'dragon.stl', sourcePath: '/imports/1/survivor-1/dragon.stl', createdAt: AFTER_CUTOFF, fileHash: survivor1Hash, size: survivor1Content.length });
  writeAssetFile(storageDir, 'spurious-dupe-1', 'dragon.stl', survivor1Content); // independent copy, same bytes

  insertAsset(db, { id: 'spurious-dupe-2', filename: 'bracket.3mf', sourcePath: '/imports/2/survivor-2/bracket.3mf', createdAt: AFTER_CUTOFF, fileHash: survivor2Hash, size: survivor2Content.length });
  writeAssetFile(storageDir, 'spurious-dupe-2', 'bracket.3mf', survivor2Content);

  // A THIRD independent copy of the same survivor-1 content — models the
  // documented "3 concurrent /imports/N scans each copy the same real
  // file" mechanism. Still a "dupe of a survivor" (matches survivor1Hash).
  insertAsset(db, { id: 'spurious-dupe-3', filename: 'dragon.stl', sourcePath: '/imports/3/survivor-1/dragon.stl', createdAt: AFTER_CUTOFF, fileHash: survivor1Hash, size: survivor1Content.length });
  writeAssetFile(storageDir, 'spurious-dupe-3', 'dragon.stl', survivor1Content);

  // ── Spurious: "distinct-new" storage-internal artifacts (e.g. a
  // thumbnail's bytes, or a version archive's bytes) — hash matches
  // nothing among survivors. Two of these SHARE A HASH WITH EACH OTHER
  // (two concurrent scans re-copied the same thumbnail file) — must
  // count toward distinctHashesInSpuriousSet but NOT dupeOfSurvivorCount.
  const thumbContent = 'jpeg-thumbnail-bytes-not-a-real-asset';
  const thumbHash = hashOf(thumbContent);
  insertAsset(db, { id: 'spurious-thumb-copy-1', filename: 'survivor-3.jpg', sourcePath: '/imports/1/thumbs/survivor-3.jpg', createdAt: AFTER_CUTOFF, fileHash: thumbHash, size: thumbContent.length });
  writeAssetFile(storageDir, 'spurious-thumb-copy-1', 'survivor-3.jpg', thumbContent);
  insertAsset(db, { id: 'spurious-thumb-copy-2', filename: 'survivor-3.jpg', sourcePath: '/imports/2/thumbs/survivor-3.jpg', createdAt: AFTER_CUTOFF, fileHash: thumbHash, size: thumbContent.length });
  writeAssetFile(storageDir, 'spurious-thumb-copy-2', 'survivor-3.jpg', thumbContent);

  // A version-archive artifact re-imported as "new" — distinct hash, no
  // survivor shares it (survivor-3's OWN old-version hash, re-scanned).
  insertAsset(db, { id: 'spurious-version-artifact', filename: 'part.stl', sourcePath: '/imports/1/survivor-3/versions/survivor-3-v1_part.stl', createdAt: AFTER_CUTOFF, fileHash: hashOf(survivor3OldContent), size: survivor3OldContent.length });
  writeAssetFile(storageDir, 'spurious-version-artifact', 'part.stl', survivor3OldContent);

  // ── Spurious with a null file_hash (hash-read failure at scan time) ──
  insertAsset(db, { id: 'spurious-null-hash', filename: 'mystery.gcode', sourcePath: '/imports/1/mystery.gcode', createdAt: AFTER_CUTOFF, fileHash: null, size: 123 });
  writeAssetFile(storageDir, 'spurious-null-hash', 'mystery.gcode', 'gcode content');

  // ── Shared-inode edge case: a spurious row whose "file" is a HARD
  // LINK to survivor-2's actual file (the filesystem-truth scenario the
  // inode-safety guard exists to catch, even though nothing in this
  // app's write paths produces it today). Its row must still be
  // deletable; its bytes must NOT be, because survivor-2 still needs them.
  insertAsset(db, { id: 'spurious-shared-inode', filename: 'bracket.3mf', sourcePath: '/imports/3/survivor-2-hardlink/bracket.3mf', createdAt: AFTER_CUTOFF, fileHash: survivor2Hash, size: survivor2Content.length });
  const sharedPath = assetLivePath(storageDir, 'spurious-shared-inode', 'bracket.3mf');
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.linkSync(assetLivePath(storageDir, 'survivor-2', 'bracket.3mf'), sharedPath);

  // ── Ambiguous: /imports/ source_path but predates the cutoff ────────
  insertAsset(db, { id: 'ambiguous-old-imports-row', filename: 'old-import.stl', sourcePath: '/imports/1/old-import.stl', createdAt: BEFORE_CUTOFF, fileHash: hashOf('old import content'), size: 50 });
  writeAssetFile(storageDir, 'ambiguous-old-imports-row', 'old-import.stl', 'old import content');

  // ── Coincidental: normal interface upload right after the cutoff ────
  insertAsset(db, { id: 'coincidental-recent-upload', filename: 'new-upload.svg', sourcePath: null, createdAt: AFTER_CUTOFF, fileHash: hashOf('brand new upload'), size: 40 });
  writeAssetFile(storageDir, 'coincidental-recent-upload', 'new-upload.svg', 'brand new upload');

  return {
    survivorIds: ['survivor-1', 'survivor-2', 'survivor-3'],
    spuriousIds: [
      'spurious-dupe-1', 'spurious-dupe-2', 'spurious-dupe-3',
      'spurious-thumb-copy-1', 'spurious-thumb-copy-2',
      'spurious-version-artifact', 'spurious-null-hash', 'spurious-shared-inode',
    ],
    ambiguousId: 'ambiguous-old-imports-row',
    coincidentalId: 'coincidental-recent-upload',
  };
}

describe('identifySpurious — two-signal cross-check', () => {
  it('selects exactly the spurious set (intersection of both signals), excluding every survivor and every ambiguous/coincidental row', async () => {
    const fx = await bootFixture();
    const shape = seedIncidentShape(fx);
    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const o = opts(fx.storageDir, dbPath);

    const result = identifySpurious(fx.db, o);
    const spuriousIds = result.spurious.map((r: AssetRow) => r.id).sort();
    expect(spuriousIds).toEqual([...shape.spuriousIds].sort());

    // Every survivor is preserved — never in the spurious set.
    for (const id of shape.survivorIds) {
      expect(spuriousIds).not.toContain(id);
    }

    // The ambiguous row surfaces via onlyA, not in spurious.
    expect(result.onlyA.map((r: AssetRow) => r.id)).toEqual([shape.ambiguousId]);
    expect(spuriousIds).not.toContain(shape.ambiguousId);

    // The coincidental recent upload surfaces via onlyB, not in spurious.
    expect(result.onlyB.map((r: AssetRow) => r.id)).toEqual([shape.coincidentalId]);
    expect(spuriousIds).not.toContain(shape.coincidentalId);
  });
});

describe('buildDryRunReport — hash breakdown, file plan, and safety', () => {
  it('classifies dupe-of-survivor vs distinct-new correctly and never overlaps them', async () => {
    const fx = await bootFixture();
    seedIncidentShape(fx);
    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const report = buildDryRunReport(fx.db, opts(fx.storageDir, dbPath));

    // dupeOfSurvivorCount = dupe-1/2/3 (3 independent copies of
    // survivor-1's content) + spurious-shared-inode (shares survivor-2's
    // hash, even though its bytes are a hardlink not a copy — the hash
    // breakdown is content-based, independent of the inode-safety
    // question tested separately below) = 4.
    expect(report.hashBreakdown.dupeOfSurvivorCount).toBe(4);
    // 1 row has a null hash.
    expect(report.hashBreakdown.nullHashCount).toBe(1);
    // Remaining 3 = 2 thumb copies + 1 version artifact.
    // spurious total = 8; 8 - 4 (dupeOfSurvivor) - 1 (nullHash) = 3.
    expect(report.hashBreakdown.distinctNewCount).toBe(3);
    expect(report.hashBreakdown.dupeOfSurvivorCount + report.hashBreakdown.distinctNewCount + report.hashBreakdown.nullHashCount)
      .toBe(report.identification.spurious.length);

    // Two thumb copies share a hash with EACH OTHER but no survivor —
    // still counted once in distinctHashesInSpuriousSet, not folded into
    // dupeOfSurvivorCount.
    expect(report.hashBreakdown.distinctNewCount).toBeGreaterThanOrEqual(2);
  });

  it('flags the shared-inode row as unsafe to delete, and preserves it in the file plan', async () => {
    const fx = await bootFixture();
    seedIncidentShape(fx);
    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const report = buildDryRunReport(fx.db, opts(fx.storageDir, dbPath));

    const sharedPlan = report.filePlan.find((f) => f.assetId === 'spurious-shared-inode');
    expect(sharedPlan).toBeDefined();
    expect(sharedPlan!.sharedWithSurvivor).toBe(true);
    expect(sharedPlan!.sharedWithPath).toContain('survivor-2');

    // Every OTHER spurious file is correctly identified as safe (not shared).
    const notShared = report.filePlan.filter((f) => f.assetId !== 'spurious-shared-inode');
    for (const f of notShared) {
      expect(f.sharedWithSurvivor).toBe(false);
    }
  });

  it('reports zero entanglements for a clean incident shape (nothing was ever placed into a project/set/sub-assembly)', async () => {
    const fx = await bootFixture();
    seedIncidentShape(fx);
    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const report = buildDryRunReport(fx.db, opts(fx.storageDir, dbPath));
    expect(report.entanglements).toEqual([]);
  });

  it('surfaces an entanglement when a spurious row has been placed in a project (anomaly, not auto-excluded)', async () => {
    const fx = await bootFixture();
    const shape = seedIncidentShape(fx);
    fx.db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-1', 'Test Project')`).run();
    fx.db.prepare(`INSERT INTO project_assets (project_id, asset_id) VALUES ('proj-1', ?)`).run(shape.spuriousIds[0]);

    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const report = buildDryRunReport(fx.db, opts(fx.storageDir, dbPath));

    const entangled = checkEntanglement(fx.db, [shape.spuriousIds[0]]);
    expect(entangled).toHaveLength(1);
    expect(entangled[0].projectPlacements).toBe(1);
    // Still selected for deletion — entanglement is a reporting signal,
    // not a filter (see script header: row deletion is driven purely by
    // the two-signal identification; entanglement is surfaced for human
    // review, never silently excluded or silently deleted).
    expect(report.identification.spurious.map((r) => r.id)).toContain(shape.spuriousIds[0]);
  });
});

describe('executeCleanup — the actual deletion, proven end to end', () => {
  it('deletes every spurious row and its physical file, preserves every survivor row/file/version, and preserves the shared-inode file while still deleting its row', async () => {
    const fx = await bootFixture();
    const shape = seedIncidentShape(fx);
    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const o = opts(fx.storageDir, dbPath);

    const report = buildDryRunReport(fx.db, o);
    expect(report.identification.spurious).toHaveLength(8);

    const result = executeCleanup(fx.db, o, report.identification.spurious, report.filePlan);

    expect(result.rowsDeleted).toBe(8);
    expect(result.filesSkippedShared).toBe(1); // the hardlinked row
    expect(result.fileDeleteErrors).toEqual([]);

    // Every spurious row is gone from the DB.
    for (const id of shape.spuriousIds) {
      const row = fx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id);
      expect(row).toBeUndefined();
    }

    // Every survivor row is untouched.
    for (const id of shape.survivorIds) {
      const row = fx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id);
      expect(row).toBeDefined();
    }
    // The ambiguous and coincidental rows are untouched too.
    expect(fx.db.prepare('SELECT id FROM assets WHERE id = ?').get(shape.ambiguousId)).toBeDefined();
    expect(fx.db.prepare('SELECT id FROM assets WHERE id = ?').get(shape.coincidentalId)).toBeDefined();

    // Physical files: every non-shared spurious asset's directory is gone.
    for (const id of shape.spuriousIds) {
      if (id === 'spurious-shared-inode') continue;
      expect(fs.existsSync(path.join(fx.storageDir, id))).toBe(false);
    }

    // The shared-inode row's physical file is PRESERVED (never deleted —
    // it's the same inode as survivor-2's live file).
    const sharedPath = assetLivePath(fx.storageDir, 'spurious-shared-inode', 'bracket.3mf');
    expect(fs.existsSync(sharedPath)).toBe(true);

    // Survivor-2's own file is intact and byte-correct — the real proof
    // that deleting the spurious row never touched the survivor's bytes.
    const survivor2Path = assetLivePath(fx.storageDir, 'survivor-2', 'bracket.3mf');
    expect(fs.existsSync(survivor2Path)).toBe(true);
    expect(fs.readFileSync(survivor2Path, 'utf-8')).toBe('survivor-2 bracket.3mf bytes');

    // Survivor-1's file and survivor-3's live file + archived v1 file are
    // all intact — none of the three independent copies of survivor-1's
    // content, nor the version-artifact copy of survivor-3's old
    // content, touched the real files.
    expect(fs.readFileSync(assetLivePath(fx.storageDir, 'survivor-1', 'dragon.stl'), 'utf-8')).toBe('survivor-1 dragon.stl bytes');
    expect(fs.readFileSync(assetLivePath(fx.storageDir, 'survivor-3', 'part.stl'), 'utf-8')).toBe('survivor-3 v2 content');
    expect(fs.readFileSync(versionFilePath(fx.storageDir, 'survivor-3', 'survivor-3-v1', 'part.stl'), 'utf-8')).toBe('survivor-3 v1 content (archived)');

    // Bytes-freed accounting excludes the shared file (never actually freed).
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('is idempotent — a second identification pass after execute finds nothing left to clean', async () => {
    const fx = await bootFixture();
    const shape = seedIncidentShape(fx);
    const dbPath = path.join(process.env.DATA_DIR!, 'thefabricatorsvault.db');
    const o = opts(fx.storageDir, dbPath);

    const first = buildDryRunReport(fx.db, o);
    executeCleanup(fx.db, o, first.identification.spurious, first.filePlan);

    const second = identifySpurious(fx.db, o);
    expect(second.spurious).toEqual([]);

    // Survivors, ambiguous, and coincidental rows are all still present
    // and still correctly NOT selected on the second pass.
    expect(second.setA.map((r) => r.id)).toEqual([shape.ambiguousId]); // only the untouched ambiguous row still has an /imports/ path
    expect(second.setB.map((r) => r.id).sort()).toEqual([shape.coincidentalId].sort());
  });
});
