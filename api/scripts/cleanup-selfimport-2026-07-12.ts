// TheFabVault — self-import cleanup (#2078, 2026-07-12 incident)
//
// Background: production's docker-compose bound /app/storage AND all
// three /imports/1,2,3 to the SAME host directory (/mnt/fabvault/storage).
// The (now-removed, see git history for services/mountImport.ts)
// mount-scan subsystem walked all three /imports/N paths on every scan,
// which meant it was walking the vault's own storage back into itself.
// A scan on 2026-07-12 (cutoff ~02:37:00Z) produced 8,934 spurious asset
// rows (imported:8934, versioned:0, skipped:24, failed:0) on top of the
// 1,629 legitimate pre-existing (interface-loaded) assets — 10,563 total.
// scanMountImports() ran all three /imports/N scans concurrently via
// Promise.allSettled, and each of the three built its own snapshot of
// "already-known" paths at start — so the same real files on disk were
// very likely independently re-imported by more than one of the three
// concurrent scans, each producing its own new asset row and its own
// independent physical copy (moveFile()'s :ro-mount fallback always
// fs.copyFileSync()s into a brand-new per-asset UUID directory — see
// services/fileStore.ts's assetFilePath()/assetDir(); this app never
// hardlinks two different asset ids together). That mechanism is why the
// spurious set splits into ~54% exact file_hash duplicates of
// pre-existing assets' PRIMARY files, and the remainder ("distinct-new")
// duplicates of storage-internal artifacts the scanner also walked and
// re-imported as if new — generated thumbnails (THUMBS_DIR/<id>.jpg) and
// asset_versions archive files (STORAGE_DIR/<id>/versions/*) — never
// genuinely new user content, since nothing was actually added to the
// vault by a human during this incident.
//
// This script identifies and removes exactly that spurious set. It is
// SAFE BY DEFAULT:
//
//   1. Two independent signals, cross-checked. A row only counts as
//      spurious if BOTH (a) its source_path starts with the configured
//      /imports/ prefix — a signal ONLY the removed mount-scan subsystem
//      ever wrote (interface uploads and folder-tree project imports
//      always leave source_path NULL — see services/assetUpload.ts's
//      saveUploadedFile() and routes/manifestImport.ts's call site) —
//      AND (b) created_at falls at/after the scan cutoff. Requiring the
//      INTERSECTION (not the union) means a hypothetical legitimate,
//      properly-configured historical mount-import (source_path set,
//      but created BEFORE the cutoff) is never touched, and a
//      legitimate upload that happened to land right after the cutoff
//      (created_at matches, but source_path is NULL) is never touched
//      either. The dry-run report surfaces the two signals' set sizes
//      independently (and the "only A" / "only B" leftovers, which
//      should both be empty in the real incident) so a drifted/ambiguous
//      result is visible before anyone executes anything, not
//      discovered after.
//
//   2. Physical-file deletion is gated on an inode-identity check, not
//      an assumption. Before deleting the bytes backing a spurious row,
//      the script builds a set of every (device, inode) pair referenced
//      by a SURVIVING (non-spurious) asset's live file AND every one of
//      its asset_versions archive files. A spurious row's physical file
//      is only deleted if its own (device, inode) is NOT in that
//      protected set. In this codebase that check should always pass
//      (nothing ever hardlinks two different asset ids' files together —
//      confirmed against services/fileStore.ts and every fs.write*/
//      fs.copyFileSync/fs.renameSync call site as of this ticket), but
//      the check is real filesystem truth, not a restatement of that
//      assumption — if it ever finds a shared inode, that specific
//      file is skipped (left on disk) while its DB row is still removed,
//      and the skip is called out loudly in the report/result rather
//      than silently succeeding.
//
//   3. Default mode is DRY RUN. Nothing is written — the DB is opened
//      `readonly: true` for identification and reporting, which makes a
//      write structurally impossible during a dry run, not just
//      unlikely by control flow. `--execute` is required to write
//      anything, and even then it additionally requires
//      `--confirm-count=<N>` to match the FRESHLY recomputed spurious
//      row count at execute time — if the live count has drifted from
//      whatever number a human reviewed in an earlier dry run (someone
//      uploaded something, another cleanup ran, etc.), the run aborts
//      instead of deleting a different set than what was reviewed.
//
//   4. Re-runnable / idempotent. The identification query is a pure
//      function of DB state (source_path + created_at), so a second run
//      after a successful execute finds zero rows left to consider.
//      File deletion uses `fs.rmSync(..., { force: true })` (a safe
//      no-op if the path is already gone) and is attempted independently
//      per asset with its own try/catch — one file's error (e.g. a
//      permission problem on the CIFS-backed storage mount) is logged
//      and does not abort the run or block that asset's DB row from
//      being removed. The one edge case this does NOT fully self-heal:
//      if a physical delete errors (not just "already gone") AFTER its
//      DB row has already been removed, that orphaned directory has no
//      row left to re-discover it by on a later run — the final summary
//      lists every such path explicitly by name specifically so it can
//      be checked/removed by hand. In the normal case (no permission
//      errors) this list is empty.
//
// Usage:
//   Dry run (default — prints a report, writes nothing):
//     npx tsx scripts/cleanup-selfimport-2026-07-12.ts
//
//   Execute (after reviewing the dry-run report and its printed count):
//     npx tsx scripts/cleanup-selfimport-2026-07-12.ts --execute --confirm-count=8934
//
// Flags:
//   --db=<path>             SQLite file. Default: $DATA_DIR/thefabricatorsvault.db
//                            (DATA_DIR default './data/db', matching config.ts)
//   --storage=<path>        Asset storage root. Default: $STORAGE_DIR
//                            (default './data/storage', matching config.ts)
//   --cutoff=<ISO8601>       Scan cutoff. Default: 2026-07-12T02:37:00Z — the
//                            timestamp from Holt's live diagnostic. Pass the
//                            exact value from the real diagnostic when
//                            running against prod; do not assume the default
//                            is correct for a different environment/run.
//   --import-prefix=<path>  source_path prefix that identifies a mount-scan
//                            row. Default: '/imports/' (matches
//                            IMPORT_MOUNT_PATHS's container-internal paths).
//   --execute                Perform the deletion. Omit for dry-run (default).
//   --confirm-count=<N>      Required with --execute. Must equal the
//                            spurious row count recomputed at execute time.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Minimal row shapes (subset of api/src/types/index.ts's AssetRow /
// asset_versions columns — kept local and minimal rather than importing
// the app's full type module, since this script only ever reads the
// handful of columns its logic actually touches). ────────────────────────

export interface AssetRow {
  id: string;
  filename: string;
  original_name: string | null;
  size: number;
  source_path: string | null;
  created_at: number;
  file_hash: string | null;
  deleted_at: number | null;
}

interface VersionFileRow {
  asset_id: string;
  id: string;
  filename: string;
}

export interface CleanupOptions {
  dbPath: string;
  storageDir: string;
  cutoffUnix: number;
  cutoffIso: string;
  importPrefix: string;
}

// ─── Pure path helpers ───────────────────────────────────────────────────
// Deliberately NOT imported from services/fileStore.ts: assetDir()/
// assetFilePath() there call fs.mkdirSync() as a side effect (fine for
// the running app, wrong for a dry-run tool that must never touch disk
// before --execute is confirmed). These mirror the exact same layout
// (STORAGE_DIR/<id>/<filename>, STORAGE_DIR/<id>/versions/<verId>_<name>,
// STORAGE_DIR/thumbs/<id>.jpg) with zero side effects.

export function assetLivePath(storageDir: string, id: string, filename: string): string {
  return path.join(storageDir, id, filename);
}
export function assetDirPath(storageDir: string, id: string): string {
  return path.join(storageDir, id);
}
export function versionFilePath(storageDir: string, id: string, versionId: string, filename: string): string {
  return path.join(storageDir, id, 'versions', `${versionId}_${filename}`);
}
export function thumbFilePath(storageDir: string, id: string): string {
  return path.join(storageDir, 'thumbs', `${id}.jpg`);
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function inodeKey(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

// ─── Identification (two signals, cross-checked) ─────────────────────────

export interface SpuriousIdentification {
  setA: AssetRow[]; // source_path LIKE `${importPrefix}%`
  setB: AssetRow[]; // created_at >= cutoff
  spurious: AssetRow[]; // setA ∩ setB — the actual delete candidates
  onlyA: AssetRow[]; // setA \ setB — imports-path but OLD (should be empty)
  onlyB: AssetRow[]; // setB \ setA — recent but not imports-path (legitimate, excluded)
}

export function identifySpurious(db: Database.Database, opts: CleanupOptions): SpuriousIdentification {
  const setA = db.prepare(
    `SELECT id, filename, original_name, size, source_path, created_at, file_hash, deleted_at
     FROM assets WHERE source_path LIKE ? ESCAPE '\\'`
  ).all(`${escapeLike(opts.importPrefix)}%`) as AssetRow[];

  const setB = db.prepare(
    `SELECT id, filename, original_name, size, source_path, created_at, file_hash, deleted_at
     FROM assets WHERE created_at >= ?`
  ).all(opts.cutoffUnix) as AssetRow[];

  const idsB = new Set(setB.map((r) => r.id));
  const idsA = new Set(setA.map((r) => r.id));

  const spurious = setA.filter((r) => idsB.has(r.id));
  const onlyA = setA.filter((r) => !idsB.has(r.id));
  const onlyB = setB.filter((r) => !idsA.has(r.id));

  return { setA, setB, spurious, onlyA, onlyB };
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ─── Entanglement check — has a spurious row been placed anywhere a
// human would have had to deliberately act (project, sub-assembly,
// set, set cover, or its own version history)? Should always be empty
// for genuine scan artifacts; anything returned here is surfaced in the
// report as a loud anomaly for manual review, not silently deleted. ─────

export interface EntanglementReport {
  assetId: string;
  projectPlacements: number;
  subAssemblyPlacements: number;
  setPlacements: number;
  isSetCover: boolean;
  hasVersions: boolean;
  alreadyTrashed: boolean;
}

export function checkEntanglement(db: Database.Database, spuriousIds: string[]): EntanglementReport[] {
  if (spuriousIds.length === 0) return [];
  const out: EntanglementReport[] = [];
  const placeholders = spuriousIds.map(() => '?').join(',');

  const projectCounts = new Map<string, number>();
  for (const row of db.prepare(
    `SELECT asset_id, COUNT(*) as n FROM project_assets WHERE asset_id IN (${placeholders}) GROUP BY asset_id`
  ).all(...spuriousIds) as { asset_id: string; n: number }[]) {
    projectCounts.set(row.asset_id, row.n);
  }

  const subAssemblyCounts = new Map<string, number>();
  for (const row of db.prepare(
    `SELECT asset_id, COUNT(*) as n FROM sub_assembly_parts WHERE asset_id IN (${placeholders}) GROUP BY asset_id`
  ).all(...spuriousIds) as { asset_id: string; n: number }[]) {
    subAssemblyCounts.set(row.asset_id, row.n);
  }

  const setCounts = new Map<string, number>();
  for (const row of db.prepare(
    `SELECT asset_id, COUNT(*) as n FROM set_assets WHERE asset_id IN (${placeholders}) GROUP BY asset_id`
  ).all(...spuriousIds) as { asset_id: string; n: number }[]) {
    setCounts.set(row.asset_id, row.n);
  }

  const coverIds = new Set(
    (db.prepare(
      `SELECT cover_asset_id FROM sets WHERE cover_asset_id IN (${placeholders})`
    ).all(...spuriousIds) as { cover_asset_id: string }[]).map((r) => r.cover_asset_id)
  );

  const versionIds = new Set(
    (db.prepare(
      `SELECT DISTINCT asset_id FROM asset_versions WHERE asset_id IN (${placeholders})`
    ).all(...spuriousIds) as { asset_id: string }[]).map((r) => r.asset_id)
  );

  const trashedIds = new Set(
    (db.prepare(
      `SELECT id FROM assets WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`
    ).all(...spuriousIds) as { id: string }[]).map((r) => r.id)
  );

  for (const id of spuriousIds) {
    const projectPlacements = projectCounts.get(id) ?? 0;
    const subAssemblyPlacements = subAssemblyCounts.get(id) ?? 0;
    const setPlacements = setCounts.get(id) ?? 0;
    const isSetCover = coverIds.has(id);
    const hasVersions = versionIds.has(id);
    const alreadyTrashed = trashedIds.has(id);
    if (projectPlacements || subAssemblyPlacements || setPlacements || isSetCover || hasVersions) {
      out.push({ assetId: id, projectPlacements, subAssemblyPlacements, setPlacements, isSetCover, hasVersions, alreadyTrashed });
    }
  }
  return out;
}

// ─── Protected-inode set — every (device, inode) a SURVIVOR (non-spurious
// asset) still references: its live file, every asset_versions archive
// file, and its thumbnail. Built from real fs.statSync() calls, not from
// assumptions about the app's dedup model. ────────────────────────────────

export function buildProtectedInodes(
  db: Database.Database,
  storageDir: string,
  spuriousIds: Set<string>,
): Map<string, { path: string; assetId: string; kind: 'live' | 'version' | 'thumb' }> {
  const protectedMap = new Map<string, { path: string; assetId: string; kind: 'live' | 'version' | 'thumb' }>();

  const allAssets = db.prepare('SELECT id, filename FROM assets').all() as { id: string; filename: string }[];
  for (const a of allAssets) {
    if (spuriousIds.has(a.id)) continue; // survivors only
    const livePath = assetLivePath(storageDir, a.id, a.filename);
    const liveStat = statOrNull(livePath);
    if (liveStat) protectedMap.set(inodeKey(liveStat), { path: livePath, assetId: a.id, kind: 'live' });

    const thumbPath = thumbFilePath(storageDir, a.id);
    const thumbStat = statOrNull(thumbPath);
    if (thumbStat) protectedMap.set(inodeKey(thumbStat), { path: thumbPath, assetId: a.id, kind: 'thumb' });
  }

  const allVersions = db.prepare('SELECT asset_id, id, filename FROM asset_versions').all() as VersionFileRow[];
  for (const v of allVersions) {
    if (spuriousIds.has(v.asset_id)) continue; // survivors only
    const vPath = versionFilePath(storageDir, v.asset_id, v.id, v.filename);
    const vStat = statOrNull(vPath);
    if (vStat) protectedMap.set(inodeKey(vStat), { path: vPath, assetId: v.asset_id, kind: 'version' });
  }

  return protectedMap;
}

// ─── Per-spurious-row file plan — does its physical file exist, and is
// it safe to delete (i.e. its inode is not in the protected set)? ────────

export interface FilePlan {
  assetId: string;
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  sharedWithSurvivor: boolean;
  sharedWithPath: string | null;
}

export function planFileDeletions(
  spurious: AssetRow[],
  storageDir: string,
  protectedInodes: Map<string, { path: string; assetId: string; kind: string }>,
): FilePlan[] {
  return spurious.map((row) => {
    const filePath = assetLivePath(storageDir, row.id, row.filename);
    const stat = statOrNull(filePath);
    if (!stat) {
      return { assetId: row.id, filePath, exists: false, sizeBytes: 0, sharedWithSurvivor: false, sharedWithPath: null };
    }
    const key = inodeKey(stat);
    const shared = protectedInodes.get(key);
    return {
      assetId: row.id,
      filePath,
      exists: true,
      sizeBytes: stat.size,
      sharedWithSurvivor: !!shared,
      sharedWithPath: shared?.path ?? null,
    };
  });
}

// ─── Dry-run report ────────────────────────────────────────────────────

export interface DryRunReport {
  opts: CleanupOptions;
  identification: SpuriousIdentification;
  entanglements: EntanglementReport[];
  filePlan: FilePlan[];
  hashBreakdown: {
    dupeOfSurvivorCount: number;
    distinctNewCount: number;
    nullHashCount: number;
    distinctHashesInSpuriousSet: number;
  };
  bytesToFree: number;
  sample: AssetRow[];
}

export function buildDryRunReport(db: Database.Database, opts: CleanupOptions, sampleSize = 10): DryRunReport {
  const identification = identifySpurious(db, opts);
  const spuriousIds = new Set(identification.spurious.map((r) => r.id));
  const entanglements = checkEntanglement(db, [...spuriousIds]);
  const protectedInodes = buildProtectedInodes(db, opts.storageDir, spuriousIds);
  const filePlan = planFileDeletions(identification.spurious, opts.storageDir, protectedInodes);

  // Survivor hash set — every non-spurious asset's file_hash — for the
  // dupe-of-survivor vs distinct-new breakdown.
  const survivorHashes = new Set(
    (db.prepare('SELECT file_hash FROM assets WHERE file_hash IS NOT NULL').all() as { file_hash: string }[])
      .map((r) => r.file_hash)
      .filter((h) => !spuriousFileHashOnly(db, h, spuriousIds)),
  );
  // The filter above is intentionally conservative — see spuriousFileHashOnly()
  // below: a hash counts as a real "survivor hash" unless EVERY asset row
  // carrying it is itself in the spurious set.

  let dupeOfSurvivorCount = 0;
  let nullHashCount = 0;
  const distinctHashesInSpuriousSet = new Set<string>();
  for (const row of identification.spurious) {
    if (row.file_hash === null) {
      nullHashCount++;
      continue;
    }
    distinctHashesInSpuriousSet.add(row.file_hash);
    if (survivorHashes.has(row.file_hash)) dupeOfSurvivorCount++;
  }
  const distinctNewCount = identification.spurious.length - dupeOfSurvivorCount - nullHashCount;

  const bytesToFree = filePlan.reduce((sum, f) => (f.exists && !f.sharedWithSurvivor ? sum + f.sizeBytes : sum), 0);

  const sample = identification.spurious
    .slice()
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, sampleSize);

  return {
    opts,
    identification,
    entanglements,
    filePlan,
    hashBreakdown: {
      dupeOfSurvivorCount,
      distinctNewCount,
      nullHashCount,
      distinctHashesInSpuriousSet: distinctHashesInSpuriousSet.size,
    },
    bytesToFree,
    sample,
  };
}

// A hash "belongs to a survivor" only if at least one NON-spurious asset
// row carries it. If every row with that hash is itself in the spurious
// set (e.g. two of the three concurrent /imports/N scans both re-copied
// the same real file and produced two spurious rows sharing a hash, with
// no pre-existing survivor sharing it — a thumbnail or version-archive
// artifact unique to the incident), it is NOT a "dupe of a survivor" —
// it is still spurious-set-internal duplication, reported separately via
// distinctHashesInSpuriousSet rather than folded into dupeOfSurvivorCount.
function spuriousFileHashOnly(db: Database.Database, hash: string, spuriousIds: Set<string>): boolean {
  const rows = db.prepare('SELECT id FROM assets WHERE file_hash = ?').all(hash) as { id: string }[];
  return rows.length > 0 && rows.every((r) => spuriousIds.has(r.id));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${units[i]}`;
}

export function formatReport(report: DryRunReport): string {
  const { identification, entanglements, filePlan, hashBreakdown, bytesToFree, sample, opts } = report;
  const sharedCount = filePlan.filter((f) => f.sharedWithSurvivor).length;
  const existingCount = filePlan.filter((f) => f.exists).length;
  const missingCount = filePlan.filter((f) => !f.exists).length;

  const lines: string[] = [];
  lines.push('═══ TheFabVault self-import cleanup — DRY RUN ═══');
  lines.push(`DB:              ${opts.dbPath}`);
  lines.push(`Storage:         ${opts.storageDir}`);
  lines.push(`Cutoff:          ${opts.cutoffIso} (unix ${opts.cutoffUnix})`);
  lines.push(`Import prefix:   ${opts.importPrefix}`);
  lines.push('');
  lines.push('── Two-signal cross-check ──────────────────────────────');
  lines.push(`  Signal A (source_path LIKE prefix):  ${identification.setA.length}`);
  lines.push(`  Signal B (created_at >= cutoff):     ${identification.setB.length}`);
  lines.push(`  Intersection (SPURIOUS, will delete): ${identification.spurious.length}`);
  lines.push(`  Only A (imports-path, but OLD):       ${identification.onlyA.length}  ${identification.onlyA.length > 0 ? '⚠ NOT deleted — review manually' : '(expected: 0)'}`);
  lines.push(`  Only B (recent, but not imports-path):${identification.onlyB.length}  ${identification.onlyB.length > 0 ? ' — legitimate, excluded' : ''}`);
  lines.push('');
  lines.push('── Hash breakdown (within the spurious set) ────────────');
  lines.push(`  Exact dupe of a surviving asset's hash: ${hashBreakdown.dupeOfSurvivorCount}`);
  lines.push(`  Distinct-new (storage-internal, e.g. thumbs/versions): ${hashBreakdown.distinctNewCount}`);
  lines.push(`  Null file_hash (hash-read failure at scan time):       ${hashBreakdown.nullHashCount}`);
  lines.push(`  Distinct hash values within the spurious set:          ${hashBreakdown.distinctHashesInSpuriousSet}`);
  lines.push('');
  lines.push('── Physical files ───────────────────────────────────────');
  lines.push(`  Spurious rows:            ${identification.spurious.length}`);
  lines.push(`  Physical files found:     ${existingCount}`);
  lines.push(`  Physical files missing:   ${missingCount} (row exists, file already gone — harmless)`);
  lines.push(`  Shared with a survivor:   ${sharedCount}  ${sharedCount > 0 ? '⚠ these files will be PRESERVED even though their row is deleted' : '(expected: 0)'}`);
  lines.push(`  Disk bytes that would be freed: ${formatBytes(bytesToFree)} (${bytesToFree} bytes)`);
  lines.push('');
  lines.push(`── Entanglement check (${entanglements.length} anomalies) ${entanglements.length > 0 ? '⚠ REVIEW BEFORE EXECUTING' : '(expected: 0)'} ──`);
  for (const e of entanglements.slice(0, 20)) {
    lines.push(`  ${e.assetId}: projects=${e.projectPlacements} subAssemblies=${e.subAssemblyPlacements} sets=${e.setPlacements} isSetCover=${e.isSetCover} hasVersions=${e.hasVersions} alreadyTrashed=${e.alreadyTrashed}`);
  }
  if (entanglements.length > 20) lines.push(`  ... and ${entanglements.length - 20} more`);
  lines.push('');
  lines.push(`── Sample (${sample.length} of ${identification.spurious.length}, oldest first) ────────────────`);
  for (const r of sample) {
    lines.push(`  ${r.id}  ${new Date(r.created_at * 1000).toISOString()}  ${r.source_path}`);
  }
  lines.push('');
  lines.push(identification.spurious.length > 0
    ? `To execute: --execute --confirm-count=${identification.spurious.length}`
    : 'Nothing to clean up.');
  return lines.join('\n');
}

// ─── Execute ────────────────────────────────────────────────────────────

export interface ExecuteResult {
  rowsDeleted: number;
  filesDeleted: number;
  filesSkippedShared: number;
  filesAlreadyMissing: number;
  bytesFreed: number;
  fileDeleteErrors: { assetId: string; path: string; error: string }[];
}

export function executeCleanup(
  db: Database.Database,
  opts: CleanupOptions,
  spurious: AssetRow[],
  filePlan: FilePlan[],
): ExecuteResult {
  const result: ExecuteResult = {
    rowsDeleted: 0,
    filesDeleted: 0,
    filesSkippedShared: 0,
    filesAlreadyMissing: 0,
    bytesFreed: 0,
    fileDeleteErrors: [],
  };

  // Phase 1: physical files first. Each attempt is independent — one
  // file's error never blocks another asset's row from being removed
  // (a stray DB row pointing at nothing is low-severity clutter; losing
  // track of a deletable file because an unrelated row-delete aborted a
  // shared transaction would not be).
  for (const plan of filePlan) {
    if (!plan.exists) {
      result.filesAlreadyMissing++;
      continue;
    }
    if (plan.sharedWithSurvivor) {
      result.filesSkippedShared++;
      continue;
    }
    try {
      fs.rmSync(assetDirPath(opts.storageDir, plan.assetId), { recursive: true, force: true });
      try { fs.rmSync(thumbFilePath(opts.storageDir, plan.assetId), { force: true }); } catch { /* best effort */ }
      result.filesDeleted++;
      result.bytesFreed += plan.sizeBytes;
    } catch (err) {
      result.fileDeleteErrors.push({ assetId: plan.assetId, path: plan.filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Phase 2: DB rows, one transaction. FK cascades (ON DELETE CASCADE on
  // asset_versions/project_assets/set_assets/sub_assembly_parts, ON
  // DELETE SET NULL on sets.cover_asset_id — see db.ts migrations v1,
  // v9, v11, v12) clean up any placements atomically with the row.
  const ids = spurious.map((r) => r.id);
  const deleteTx = db.transaction((assetIds: string[]) => {
    const stmt = db.prepare('DELETE FROM assets WHERE id = ?');
    let n = 0;
    for (const id of assetIds) n += stmt.run(id).changes;
    return n;
  });
  result.rowsDeleted = deleteTx(ids);

  return result;
}

// ─── DB connection ────────────────────────────────────────────────────

export function openDb(dbPath: string, { readonly }: { readonly: boolean }): Database.Database {
  const db = new Database(dbPath, { readonly, fileMustExist: true });
  if (!readonly) db.pragma('foreign_keys = ON');
  return db;
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { opts: CleanupOptions; execute: boolean; confirmCount: number | null } {
  const map = new Map<string, string | boolean>();
  for (const arg of argv) {
    if (arg === '--execute') { map.set('execute', true); continue; }
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) map.set(m[1], m[2] ?? true);
  }

  const dataDir = process.env.DATA_DIR ?? './data/db';
  const storageDirDefault = process.env.STORAGE_DIR ?? './data/storage';
  const dbPath = (map.get('db') as string) ?? path.join(dataDir, 'thefabricatorsvault.db');
  const storageDir = (map.get('storage') as string) ?? storageDirDefault;
  const cutoffIso = (map.get('cutoff') as string) ?? '2026-07-12T02:37:00Z';
  const importPrefix = (map.get('import-prefix') as string) ?? '/imports/';
  const cutoffUnix = Math.floor(Date.parse(cutoffIso) / 1000);
  if (Number.isNaN(cutoffUnix)) {
    throw new Error(`Invalid --cutoff value: ${cutoffIso} (expected ISO 8601, e.g. 2026-07-12T02:37:00Z)`);
  }

  const execute = map.get('execute') === true;
  const confirmCountRaw = map.get('confirm-count');
  const confirmCount = confirmCountRaw !== undefined ? parseInt(String(confirmCountRaw), 10) : null;

  return {
    opts: { dbPath, storageDir, cutoffUnix, cutoffIso, importPrefix },
    execute,
    confirmCount,
  };
}

export async function runCli(argv: string[]): Promise<number> {
  const { opts, execute, confirmCount } = parseArgs(argv);

  if (!fs.existsSync(opts.dbPath)) {
    console.error(`[cleanup] DB file not found: ${opts.dbPath}`);
    return 1;
  }

  // Dry-run / report pass — ALWAYS readonly, regardless of --execute.
  // This is a structural guarantee (better-sqlite3 refuses writes on a
  // readonly connection), not just "we don't call write methods here."
  const readDb = openDb(opts.dbPath, { readonly: true });
  let report: DryRunReport;
  try {
    report = buildDryRunReport(readDb, opts);
  } finally {
    readDb.close();
  }
  console.log(formatReport(report));

  if (!execute) {
    return 0; // dry run — nothing written
  }

  const liveCount = report.identification.spurious.length;
  if (confirmCount === null || Number.isNaN(confirmCount)) {
    console.error('\n[cleanup] --execute requires --confirm-count=<N> matching the count printed above. Aborting — nothing written.');
    return 1;
  }
  if (confirmCount !== liveCount) {
    console.error(`\n[cleanup] --confirm-count=${confirmCount} does not match the freshly recomputed spurious count (${liveCount}). State has drifted since whatever dry run you reviewed — aborting without writing anything. Re-run the dry run and pass the current count.`);
    return 1;
  }
  if (report.identification.onlyA.length > 0) {
    console.error(`\n[cleanup] ${report.identification.onlyA.length} row(s) matched the /imports/ path signal but predate the cutoff (Signal A \\ Signal B) — these are excluded from the spurious set already, but their existence means the two signals disagree on history in a way this script has not seen before. Aborting out of caution — investigate before executing. (This does not block a rerun once reviewed; it is not counted in --confirm-count.)`);
    return 1;
  }

  console.log(`\n[cleanup] Executing — deleting ${liveCount} rows + their physical files...`);
  const writeDb = openDb(opts.dbPath, { readonly: false });
  let result: ExecuteResult;
  try {
    result = executeCleanup(writeDb, opts, report.identification.spurious, report.filePlan);
  } finally {
    try { writeDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    writeDb.close();
  }

  console.log('═══ Execute result ═══');
  console.log(`  Rows deleted:              ${result.rowsDeleted}`);
  console.log(`  Files deleted:             ${result.filesDeleted}`);
  console.log(`  Files skipped (shared):    ${result.filesSkippedShared}`);
  console.log(`  Files already missing:     ${result.filesAlreadyMissing}`);
  console.log(`  Bytes freed:               ${formatBytes(result.bytesFreed)} (${result.bytesFreed} bytes)`);
  if (result.fileDeleteErrors.length > 0) {
    console.log(`  ⚠ File delete ERRORS (row removed, file left behind — clean up by hand):`);
    for (const e of result.fileDeleteErrors) {
      console.log(`    ${e.assetId}: ${e.path} — ${e.error}`);
    }
  }
  return 0;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[cleanup] Fatal error:', err);
      process.exit(1);
    });
}
