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
//   3. Entanglement is a HARD EXCLUSION, not a printed warning (Remy's
//      review, Finding 1, 2026-07-12). A spurious row that has since been
//      placed in a project/sub-assembly/set, marked as a set cover, or
//      given real version history — i.e. a human has touched it since
//      the incident and something now depends on it — is NEVER included
//      in the delete set, full stop. It is computed OUT of `deletable`
//      before `--confirm-count` is even computed, so there is no code
//      path (a human skimming past a warning, or not) by which
//      `--execute` can remove one. Every excluded row's file is also
//      folded into the protected-inode set (point 4 below), so nothing
//      else can be deleted out from under it either. The dry-run report
//      lists every excluded row with its reason under its own section,
//      loudly, for separate manual handling — it is not silently kept
//      and not silently deleted, just never auto-deleted.
//
//   4. Physical-file deletion is gated on an inode-identity check, not
//      an assumption. Before deleting the bytes backing a row in the
//      delete set, the script builds a set of every (device, inode) pair
//      referenced by a file that will still exist after this run — every
//      survivor's (non-spurious asset's) live file, thumbnail, and every
//      asset_versions archive file, AND every excluded-entangled row's
//      live file and thumbnail too (point 3). A row's physical file (and
//      separately, its thumbnail) is only deleted if its own (device,
//      inode) is NOT in that protected set. In this codebase that check
//      should always pass (nothing ever hardlinks two different asset
//      ids' files together — confirmed against services/fileStore.ts and
//      every fs.write*/fs.copyFileSync/fs.renameSync call site as of
//      this ticket), but the check is real filesystem truth, not a
//      restatement of that assumption — if it ever finds a shared inode,
//      that specific file is skipped (left on disk) while its DB row is
//      still removed, and the skip is called out loudly in the
//      report/result rather than silently succeeding.
//
//   5. Default mode is DRY RUN. Nothing is written — the DB is opened
//      `readonly: true` for identification and reporting, which makes a
//      write structurally impossible during a dry run, not just
//      unlikely by control flow. `--execute` is required to write
//      anything, and even then it additionally requires
//      `--confirm-count=<N>` to match the FRESHLY recomputed deletable
//      row count at execute time — if the live count has drifted from
//      whatever number a human reviewed in an earlier dry run (someone
//      uploaded something, an asset got entangled or un-entangled,
//      another cleanup ran, etc.), the run aborts instead of deleting a
//      different set than what was reviewed.
//
//   6. Re-runnable / idempotent. The identification query is a pure
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
//   --storage=<path>        Asset storage root. If passed, wins outright —
//                            this is the recommended belt-and-suspenders
//                            default for a live run (e.g.
//                            --storage=/app/storage, verified against the
//                            live compose file). If omitted, resolved with
//                            the SAME precedence as api/src/config.ts's real
//                            storageDir getter (Remy's review, Finding 2,
//                            2026-07-12): the live system_config.storageDir
//                            DB override first (set when an admin marks a
//                            Network Mount slot as `library` role — a
//                            feature this same PR keeps alive), then
//                            $STORAGE_DIR, then './data/storage'. Getting
//                            this wrong doesn't over-delete — it silently
//                            UNDER-deletes (every file shows up as
//                            "already missing," rows still get removed).
//                            Sanity-check the dry run's "physical files
//                            found" count tracks close to the deletable
//                            row count, not near-zero, before trusting it.
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
//                            DELETABLE row count (spurious minus any
//                            entangled exclusions) recomputed at execute
//                            time.

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

// ─── Protected-inode set — every (device, inode) that will still be
// referenced by something AFTER this run: every survivor's (an asset NOT
// in the caller-supplied `excludeIds` — which the caller must pass as the
// DELETABLE set, not the raw spurious set, so an excluded-entangled row's
// own files are protected too, see buildDryRunReport) live file, every
// asset_versions archive file, and its thumbnail. Built from real
// fs.statSync() calls, not from assumptions about the app's dedup model. ──

export function buildProtectedInodes(
  db: Database.Database,
  storageDir: string,
  excludeIds: Set<string>,
): Map<string, { path: string; assetId: string; kind: 'live' | 'version' | 'thumb' }> {
  const protectedMap = new Map<string, { path: string; assetId: string; kind: 'live' | 'version' | 'thumb' }>();

  const allAssets = db.prepare('SELECT id, filename FROM assets').all() as { id: string; filename: string }[];
  for (const a of allAssets) {
    if (excludeIds.has(a.id)) continue; // will be deleted by this run — not a protector
    const livePath = assetLivePath(storageDir, a.id, a.filename);
    const liveStat = statOrNull(livePath);
    if (liveStat) protectedMap.set(inodeKey(liveStat), { path: livePath, assetId: a.id, kind: 'live' });

    const thumbPath = thumbFilePath(storageDir, a.id);
    const thumbStat = statOrNull(thumbPath);
    if (thumbStat) protectedMap.set(inodeKey(thumbStat), { path: thumbPath, assetId: a.id, kind: 'thumb' });
  }

  const allVersions = db.prepare('SELECT asset_id, id, filename FROM asset_versions').all() as VersionFileRow[];
  for (const v of allVersions) {
    if (excludeIds.has(v.asset_id)) continue; // will be deleted by this run — not a protector
    const vPath = versionFilePath(storageDir, v.asset_id, v.id, v.filename);
    const vStat = statOrNull(vPath);
    if (vStat) protectedMap.set(inodeKey(vStat), { path: vPath, assetId: v.asset_id, kind: 'version' });
  }

  return protectedMap;
}

// ─── Per-row file plan — does its physical file (and separately, its
// thumbnail) exist, and is each safe to delete (i.e. its own inode is not
// in the protected set)? Thumbnail deletion is gated exactly like the
// live file (Remy's review, Finding 3, 2026-07-12) — buildProtectedInodes
// already populates thumbnail entries into the protected map, so this
// was previously computed data going unused for half its purpose. ────────

export interface FilePlan {
  assetId: string;
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  sharedWithSurvivor: boolean;
  sharedWithPath: string | null;
  thumbPath: string;
  thumbExists: boolean;
  thumbSizeBytes: number;
  thumbSharedWithSurvivor: boolean;
  thumbSharedWithPath: string | null;
}

export function planFileDeletions(
  rows: AssetRow[],
  storageDir: string,
  protectedInodes: Map<string, { path: string; assetId: string; kind: string }>,
): FilePlan[] {
  return rows.map((row) => {
    const filePath = assetLivePath(storageDir, row.id, row.filename);
    const stat = statOrNull(filePath);
    const thumbPath = thumbFilePath(storageDir, row.id);
    const thumbStat = statOrNull(thumbPath);

    const shared = stat ? protectedInodes.get(inodeKey(stat)) : undefined;
    const thumbShared = thumbStat ? protectedInodes.get(inodeKey(thumbStat)) : undefined;

    return {
      assetId: row.id,
      filePath,
      exists: !!stat,
      sizeBytes: stat?.size ?? 0,
      sharedWithSurvivor: !!shared,
      sharedWithPath: shared?.path ?? null,
      thumbPath,
      thumbExists: !!thumbStat,
      thumbSizeBytes: thumbStat?.size ?? 0,
      thumbSharedWithSurvivor: !!thumbShared,
      thumbSharedWithPath: thumbShared?.path ?? null,
    };
  });
}

// ─── Dry-run report ────────────────────────────────────────────────────

export interface DryRunReport {
  opts: CleanupOptions;
  identification: SpuriousIdentification;
  entanglements: EntanglementReport[];
  // The two-signal spurious set, split by entanglement (Remy's review,
  // Finding 1, 2026-07-12): `deletable` is what --execute will actually
  // remove; `excludedEntangled` is held back automatically and must be
  // handled by hand. hashBreakdown/filePlan/bytesToFree/sample below all
  // describe `deletable`, NOT the raw `identification.spurious` set —
  // they are what is actually about to happen, not the raw signal match.
  deletable: AssetRow[];
  excludedEntangled: AssetRow[];
  filePlan: FilePlan[];
  hashBreakdown: {
    dupeOfSurvivorCount: number;
    distinctNewCount: number;
    nullHashCount: number;
    distinctHashesInDeletableSet: number;
  };
  bytesToFree: number;
  sample: AssetRow[];
}

export function buildDryRunReport(db: Database.Database, opts: CleanupOptions, sampleSize = 10): DryRunReport {
  const identification = identifySpurious(db, opts);
  const spuriousIds = new Set(identification.spurious.map((r) => r.id));
  const entanglements = checkEntanglement(db, [...spuriousIds]);
  const entangledIds = new Set(entanglements.map((e) => e.assetId));

  // Hard exclusion, not a filter a human has to remember to apply: an
  // entangled row NEVER enters `deletable`, so no downstream step
  // (hash breakdown, file plan, --confirm-count, executeCleanup) can
  // ever touch it. See this file's header, point 3.
  const deletable = identification.spurious.filter((r) => !entangledIds.has(r.id));
  const excludedEntangled = identification.spurious.filter((r) => entangledIds.has(r.id));
  const deletableIds = new Set(deletable.map((r) => r.id));

  // Protected-inode set is built EXCLUDING only `deletable` — every
  // survivor AND every excluded-entangled row's files count as
  // protectors, so a deletable row that happens to share bytes with an
  // excluded-entangled row (not just a true survivor) is still preserved.
  const protectedInodes = buildProtectedInodes(db, opts.storageDir, deletableIds);
  const filePlan = planFileDeletions(deletable, opts.storageDir, protectedInodes);

  // "Survivor" hash set for the dupe-of-survivor vs distinct-new
  // breakdown now means "every asset that will still exist after this
  // run" — i.e. every file_hash NOT carried exclusively by rows in
  // `deletable`.
  const survivorHashes = new Set(
    (db.prepare('SELECT file_hash FROM assets WHERE file_hash IS NOT NULL').all() as { file_hash: string }[])
      .map((r) => r.file_hash)
      .filter((h) => !hashOnlyIn(db, h, deletableIds)),
  );

  let dupeOfSurvivorCount = 0;
  let nullHashCount = 0;
  const distinctHashesInDeletableSet = new Set<string>();
  for (const row of deletable) {
    if (row.file_hash === null) {
      nullHashCount++;
      continue;
    }
    distinctHashesInDeletableSet.add(row.file_hash);
    if (survivorHashes.has(row.file_hash)) dupeOfSurvivorCount++;
  }
  const distinctNewCount = deletable.length - dupeOfSurvivorCount - nullHashCount;

  const bytesToFree = filePlan.reduce((sum, f) => {
    let total = sum;
    if (f.exists && !f.sharedWithSurvivor) total += f.sizeBytes;
    if (f.thumbExists && !f.thumbSharedWithSurvivor) total += f.thumbSizeBytes;
    return total;
  }, 0);

  const sample = deletable
    .slice()
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, sampleSize);

  return {
    opts,
    identification,
    entanglements,
    deletable,
    excludedEntangled,
    filePlan,
    hashBreakdown: {
      dupeOfSurvivorCount,
      distinctNewCount,
      nullHashCount,
      distinctHashesInDeletableSet: distinctHashesInDeletableSet.size,
    },
    bytesToFree,
    sample,
  };
}

// A hash "belongs to a survivor" only if at least one asset row OUTSIDE
// `ids` carries it. If every row with that hash is itself inside `ids`
// (e.g. two of the three concurrent /imports/N scans both re-copied the
// same real file and produced two spurious rows sharing a hash, with no
// pre-existing survivor sharing it — a thumbnail or version-archive
// artifact unique to the incident), it is NOT a "dupe of a survivor" —
// it is still deletable-set-internal duplication, reported separately via
// distinctHashesInDeletableSet rather than folded into dupeOfSurvivorCount.
function hashOnlyIn(db: Database.Database, hash: string, ids: Set<string>): boolean {
  const rows = db.prepare('SELECT id FROM assets WHERE file_hash = ?').all(hash) as { id: string }[];
  return rows.length > 0 && rows.every((r) => ids.has(r.id));
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
  const {
    identification, entanglements, excludedEntangled, deletable, filePlan, hashBreakdown, bytesToFree, sample, opts,
  } = report;
  const sharedCount = filePlan.filter((f) => f.sharedWithSurvivor).length;
  const existingCount = filePlan.filter((f) => f.exists).length;
  const missingCount = filePlan.filter((f) => !f.exists).length;
  const thumbSharedCount = filePlan.filter((f) => f.thumbExists && f.thumbSharedWithSurvivor).length;

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
  lines.push(`  Intersection (SPURIOUS):              ${identification.spurious.length}`);
  lines.push(`  Only A (imports-path, but OLD):       ${identification.onlyA.length}  ${identification.onlyA.length > 0 ? '⚠ NOT deleted — review manually' : '(expected: 0)'}`);
  lines.push(`  Only B (recent, but not imports-path):${identification.onlyB.length}  ${identification.onlyB.length > 0 ? ' — legitimate, excluded' : ''}`);
  lines.push('');
  lines.push(`── Entanglement — EXCLUDED from deletion (${excludedEntangled.length}) ${excludedEntangled.length > 0 ? '⚠ HANDLE MANUALLY' : '(expected: 0)'} ──`);
  lines.push('  A spurious row is auto-excluded here (row AND bytes both preserved,');
  lines.push('  never deleted by --execute) the moment it has been placed in a');
  lines.push('  project/sub-assembly/set, marked as a set cover, or given real');
  lines.push('  version history since the incident — this is a hard gate, not a');
  lines.push('  warning to skim past.');
  for (const e of entanglements.slice(0, 20)) {
    lines.push(`  ${e.assetId}: projects=${e.projectPlacements} subAssemblies=${e.subAssemblyPlacements} sets=${e.setPlacements} isSetCover=${e.isSetCover} hasVersions=${e.hasVersions} alreadyTrashed=${e.alreadyTrashed}`);
  }
  if (entanglements.length > 20) lines.push(`  ... and ${entanglements.length - 20} more`);
  lines.push('');
  lines.push(`── Deletable (spurious minus entangled — what --execute will remove: ${deletable.length}) ──`);
  lines.push('');
  lines.push('── Hash breakdown (within the deletable set) ────────────');
  lines.push(`  Exact dupe of a surviving asset's hash: ${hashBreakdown.dupeOfSurvivorCount}`);
  lines.push(`  Distinct-new (storage-internal, e.g. thumbs/versions): ${hashBreakdown.distinctNewCount}`);
  lines.push(`  Null file_hash (hash-read failure at scan time):       ${hashBreakdown.nullHashCount}`);
  lines.push(`  Distinct hash values within the deletable set:         ${hashBreakdown.distinctHashesInDeletableSet}`);
  lines.push('');
  lines.push('── Physical files (within the deletable set) ────────────');
  lines.push(`  Deletable rows:           ${deletable.length}`);
  lines.push(`  Physical files found:     ${existingCount}`);
  lines.push(`  Physical files missing:   ${missingCount} (row exists, file already gone — harmless)`);
  lines.push(`  Shared with a survivor:   ${sharedCount}  ${sharedCount > 0 ? '⚠ these files will be PRESERVED even though their row is deleted' : '(expected: 0)'}`);
  lines.push(`  Thumbnails shared with a survivor: ${thumbSharedCount}  ${thumbSharedCount > 0 ? '⚠ these thumbnails will be PRESERVED too' : '(expected: 0)'}`);
  lines.push(`  Disk bytes that would be freed: ${formatBytes(bytesToFree)} (${bytesToFree} bytes)`);
  lines.push('');
  lines.push(`── Sample (${sample.length} of ${deletable.length}, oldest first) ────────────────`);
  for (const r of sample) {
    lines.push(`  ${r.id}  ${new Date(r.created_at * 1000).toISOString()}  ${r.source_path}`);
  }
  lines.push('');
  if (deletable.length > 0) {
    lines.push(`To execute: --execute --confirm-count=${deletable.length}`);
  } else if (excludedEntangled.length > 0) {
    lines.push(`Nothing auto-deletable — ${excludedEntangled.length} entangled row(s) require manual review (see above).`);
  } else {
    lines.push('Nothing to clean up.');
  }
  return lines.join('\n');
}

// ─── Execute ────────────────────────────────────────────────────────────

export interface ExecuteResult {
  rowsDeleted: number;
  filesDeleted: number;
  filesSkippedShared: number;
  filesAlreadyMissing: number;
  thumbsSkippedShared: number;
  bytesFreed: number;
  fileDeleteErrors: { assetId: string; path: string; error: string }[];
}

// `rows` MUST be the DELETABLE set (report.deletable), never the raw
// spurious set — the caller (runCli) is responsible for having already
// excluded entangled rows; this function does not re-check entanglement
// itself, it trusts filePlan/rows to already reflect that exclusion
// (both are produced together by buildDryRunReport for exactly this
// reason — see this file's header, point 3).
export function executeCleanup(
  db: Database.Database,
  opts: CleanupOptions,
  rows: AssetRow[],
  filePlan: FilePlan[],
): ExecuteResult {
  const result: ExecuteResult = {
    rowsDeleted: 0,
    filesDeleted: 0,
    filesSkippedShared: 0,
    filesAlreadyMissing: 0,
    thumbsSkippedShared: 0,
    bytesFreed: 0,
    fileDeleteErrors: [],
  };

  // Phase 1: physical files first. Each attempt is independent — one
  // file's error never blocks another asset's row from being removed
  // (a stray DB row pointing at nothing is low-severity clutter; losing
  // track of a deletable file because an unrelated row-delete aborted a
  // shared transaction would not be).
  for (const plan of filePlan) {
    // Thumbnail: gated on its OWN inode check and accounted for
    // independently of the live file's outcome (Remy's review, Finding
    // 3, 2026-07-12) — never assumed safe, and never bundled into the
    // live file's success/failure, just because they belong to the same
    // asset.
    if (plan.thumbExists) {
      if (plan.thumbSharedWithSurvivor) {
        result.thumbsSkippedShared++;
      } else {
        try {
          fs.rmSync(plan.thumbPath, { force: true });
          result.bytesFreed += plan.thumbSizeBytes;
        } catch { /* best effort, matches the app's own cleanupAsset() — a thumbnail is a derived artifact, never worth failing the run over */ }
      }
    }

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
  const ids = rows.map((r) => r.id);
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

// Mirrors api/src/config.ts's real `storageDir` getter precedence EXACTLY
// (Remy's review, Finding 2, 2026-07-12): an explicit override (the
// script's --storage flag) wins outright — the recommended
// belt-and-suspenders default for a live run. Absent that, the live
// system_config.storageDir DB override wins (set when an admin marks a
// Network Mount slot as `library` role — a feature this same PR keeps
// alive), matching config.ts's own DB-first, env-fallback order. Absent
// that, $STORAGE_DIR, then the same './data/storage' literal default
// config.ts falls back to. Getting this wrong doesn't over-delete — a
// wrong storage dir just means every file plan comes back
// "already missing" and rows still get removed — it silently
// UNDER-deletes, leaving the real spurious bytes on disk while the
// report claims a clean run. This is why the dry-run report's "physical
// files found" count matters as a tripwire, not just a data point.
export function resolveStorageDir(db: Database.Database, explicitOverride: string | null): string {
  if (explicitOverride) return explicitOverride;
  try {
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'storageDir'").get() as { value: string } | undefined;
    if (row?.value) return row.value;
  } catch {
    // system_config may not exist against an unmigrated/partial DB —
    // fall through to the env/default path, same as config.ts's own
    // try/catch around this exact lookup.
  }
  return process.env.STORAGE_DIR ?? './data/storage';
}

// ─── CLI ────────────────────────────────────────────────────────────────

interface ParsedArgs {
  dbPath: string;
  storageDirOverride: string | null;
  cutoffUnix: number;
  cutoffIso: string;
  importPrefix: string;
  execute: boolean;
  confirmCount: number | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string | boolean>();
  for (const arg of argv) {
    if (arg === '--execute') { map.set('execute', true); continue; }
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) map.set(m[1], m[2] ?? true);
  }

  const dataDir = process.env.DATA_DIR ?? './data/db';
  const dbPath = (map.get('db') as string) ?? path.join(dataDir, 'thefabricatorsvault.db');
  // Deliberately NOT resolved here — see resolveStorageDir()'s header
  // comment. This is only ever the EXPLICIT --storage flag, or null;
  // runCli() resolves the real value against the DB once it has an open
  // connection.
  const storageDirOverride = (map.get('storage') as string) ?? null;
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
    dbPath, storageDirOverride, cutoffUnix, cutoffIso, importPrefix, execute, confirmCount,
  };
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (!fs.existsSync(parsed.dbPath)) {
    console.error(`[cleanup] DB file not found: ${parsed.dbPath}`);
    return 1;
  }

  // Dry-run / report pass — ALWAYS readonly, regardless of --execute.
  // This is a structural guarantee (better-sqlite3 refuses writes on a
  // readonly connection), not just "we don't call write methods here."
  // storageDir is also resolved against this same connection (Finding 2)
  // before the report is built, so "physical files found" reflects the
  // real runtime storage root, not a naive env-var-only guess.
  const readDb = openDb(parsed.dbPath, { readonly: true });
  let opts: CleanupOptions;
  let report: DryRunReport;
  try {
    const storageDir = resolveStorageDir(readDb, parsed.storageDirOverride);
    opts = {
      dbPath: parsed.dbPath, storageDir, cutoffUnix: parsed.cutoffUnix, cutoffIso: parsed.cutoffIso, importPrefix: parsed.importPrefix,
    };
    report = buildDryRunReport(readDb, opts);
  } finally {
    readDb.close();
  }
  console.log(formatReport(report));

  if (!parsed.execute) {
    return 0; // dry run — nothing written
  }

  // The DELETABLE count (spurious minus entangled exclusions), never the
  // raw spurious count — entangled rows are never part of what --execute
  // touches (Finding 1), so they must never be part of what
  // --confirm-count has to match either.
  const liveCount = report.deletable.length;
  if (parsed.confirmCount === null || Number.isNaN(parsed.confirmCount)) {
    console.error('\n[cleanup] --execute requires --confirm-count=<N> matching the DELETABLE count printed above. Aborting — nothing written.');
    return 1;
  }
  if (parsed.confirmCount !== liveCount) {
    console.error(`\n[cleanup] --confirm-count=${parsed.confirmCount} does not match the freshly recomputed deletable count (${liveCount}). State has drifted since whatever dry run you reviewed (a new upload, a row becoming entangled/un-entangled, another cleanup run, etc.) — aborting without writing anything. Re-run the dry run and pass the current count.`);
    return 1;
  }
  if (report.identification.onlyA.length > 0) {
    console.error(`\n[cleanup] ${report.identification.onlyA.length} row(s) matched the /imports/ path signal but predate the cutoff (Signal A \\ Signal B) — these are excluded from the deletable set already, but their existence means the two signals disagree on history in a way this script has not seen before. Aborting out of caution — investigate before executing. (This does not block a rerun once reviewed; it is not counted in --confirm-count.)`);
    return 1;
  }

  if (report.excludedEntangled.length > 0) {
    console.log(`\n[cleanup] ${report.excludedEntangled.length} entangled row(s) are being held back automatically (row + bytes both preserved) — see the "EXCLUDED from deletion" section above. They are NOT part of this run and require separate manual handling.`);
  }

  console.log(`\n[cleanup] Executing — deleting ${liveCount} rows + their physical files...`);
  const writeDb = openDb(opts.dbPath, { readonly: false });
  let result: ExecuteResult;
  try {
    result = executeCleanup(writeDb, opts, report.deletable, report.filePlan);
  } finally {
    try { writeDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    writeDb.close();
  }

  console.log('═══ Execute result ═══');
  console.log(`  Rows deleted:              ${result.rowsDeleted}`);
  console.log(`  Files deleted:             ${result.filesDeleted}`);
  console.log(`  Files skipped (shared):    ${result.filesSkippedShared}`);
  console.log(`  Files already missing:     ${result.filesAlreadyMissing}`);
  console.log(`  Thumbnails skipped (shared): ${result.thumbsSkippedShared}`);
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
