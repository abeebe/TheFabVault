import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { glob } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import { getDb } from '../db.js';
import { assetFilePath, assetDir, cleanupAsset } from './fileStore.js';
import { enqueueThumb } from './thumbGen.js';
import { extractMeta } from './metaExtract.js';
import { archiveAndReplaceAssetFile } from './assetVersion.js';
import { config } from '../config.js';
import type { ScanResult, AssetRow } from '../types/index.js';

const DEFAULT_EXTS = new Set([
  '.stl', '.obj', '.3mf', '.lys', '.ctb', '.photon',
  '.svg', '.dxf', '.cdr', '.ai', '.eps', '.pdf', '.lbrn', '.lbrn2',
  '.png', '.jpg', '.jpeg', '.webp',
  '.gcode', '.gc', '.g',
]);

const THUMB_EXTS = new Set(['.stl', '.obj', '.3mf', '.svg', '.dxf', '.pdf', '.lbrn', '.lbrn2', '.png', '.jpg', '.jpeg', '.webp', '.gcode', '.gc', '.g']);

// System-authored asset_versions.notes marker for versions created by the
// mount rescan (as opposed to an explicit VersionPanel upload's
// user-authored note, or blank). Free-text, not a schema column — see
// services/assetVersion.ts header for why.
export const AUTO_VERSION_NOTE = 'Auto-versioned: NAS rescan detected content change';

function parseAllowedExts(raw: string): Set<string> | null {
  if (!raw.trim()) return null; // null = use defaults
  const lowered = raw.trim().toLowerCase();
  if (lowered === '*') return null; // null = all
  const parts = lowered.split(/[,\s]+/).filter(Boolean);
  const exts = new Set<string>();
  for (const part of parts) {
    exts.add(part.startsWith('.') ? part : `.${part}`);
  }
  return exts.size > 0 ? exts : null;
}

/**
 * Move a file from src to dst.
 * Uses fs.renameSync for zero-copy moves on the same filesystem.
 * Falls back to copy + best-effort delete when a same-mount rename isn't
 * possible — either because src/dst are on different devices (EXDEV) or
 * because the source's mount rejects the write a rename requires
 * (EROFS/EACCES/EPERM).
 *
 * Root-cause note (production EROFS-on-every-scanned-file, found at the
 * versioning-feature deploy): IMPORT_MOUNT_PATHS is used for two
 * different documented source semantics that this function can't tell
 * apart from a path string alone —
 *   1. INSTALLATION.md's "NAS / Mount Import": a writable drop-folder
 *      staging mount. Files are meant to be CONSUMED — moved into vault
 *      storage, removed from the source. This is the behavior this
 *      function has always implemented.
 *   2. The mount-rescan auto-versioning reconcile path added alongside
 *      AUTO_VERSION_NOTE below: a PERMANENT NAS source, rescanned in
 *      place for content changes. Every shipped compose file
 *      (docker-compose.production/bindmount/nfs/smb.yml) mounts
 *      IMPORT_MOUNT_PATHS `:ro` by default, which is only compatible
 *      with semantic 2 — the source must never be deleted.
 * A file already known to the scanner (existing source_path in `assets`)
 * only ever gets reconciled via archiveAndReplaceAssetFile(), which
 * never touches the source path at all (see assetVersion.ts) — that
 * half of the feature was always safe against a `:ro` mount. But a
 * GENUINELY NEW file — including every file on a fresh deploy, since
 * nothing has a tracked source_path yet — still goes through this
 * function, which used to treat a failed unlink as fatal: it rethrew,
 * scanSingleMount()'s catch counted the whole file as `failed`, and the
 * already-copied file + its new `assets` row were rolled back
 * (cleanupAsset + DELETE). That's how a source mount being read-only
 * turned into 100% of scanned files erroring and zero ever importing —
 * the auto-versioning reconcile path had no files to ever reconcile,
 * because nothing could get past this first-import step to become
 * "known" in the first place.
 *
 * Fix: removing the source is best-effort only. The copy into vault
 * storage has already succeeded by the time we'd attempt the unlink, so
 * a source we can't delete degrades to "imported as a copy, original
 * left in place on the NAS" — never a reason to discard a successful
 * import. This matches every other cleanup-unlink in this codebase
 * (assetVersion.ts, routes/assets.ts) already being try/catch
 * best-effort; this was the one call site that wasn't. Semantic 1 (the
 * writable staging drop-folder) is unaffected — a writable mount's
 * unlink still succeeds and the source still gets removed exactly as
 * INSTALLATION.md documents.
 */
function moveFile(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // EXDEV = genuinely different filesystems. EROFS/EACCES/EPERM = a
    // same-mount rename was blocked because the source can't be
    // written to (read-only mount, or a permission-restricted one) —
    // both fall back to copy below rather than failing the import.
    if (code !== 'EXDEV' && code !== 'EROFS' && code !== 'EACCES' && code !== 'EPERM') {
      throw err;
    }
  }

  fs.copyFileSync(src, dst);

  try {
    fs.unlinkSync(src);
  } catch (unlinkErr: unknown) {
    console.warn(`[mountImport] Could not remove source after copy — leaving original in place (read-only or permission-restricted mount?): ${src}`, unlinkErr);
  }
}

/**
 * Mtime pre-filter (Sloane's PRD feasibility Q1): one half of the check
 * that decides whether a known-path file needs to be re-read and
 * re-hashed at all. Compares a cheap fs.statSync() mtime against the
 * mtime captured the last time this asset was reconciled.
 *
 * Returns true only when we HAVE a prior baseline AND it exactly matches
 * the current mtime. Any other case — no baseline yet (pre-existing
 * asset from before this column existed, or a brand-new import whose
 * baseline hasn't landed for some reason) or a baseline that doesn't
 * match — falls through to "needs a hash check," which is the safe
 * default: at worst it costs one redundant hash, never a missed content
 * change.
 *
 * NOT sufficient on its own to conclude "unchanged" — see the call site
 * in scanSingleMount(), which additionally requires the file's size to
 * match (Remy's peer review, Finding 1, 2026-07-11: a timestamp-
 * preserving copy/sync tool — `cp -p`, `rsync -a`/`-t`, a re-export
 * pipeline that intentionally carries the source mtime forward — can
 * re-stamp the exact prior mtime on materially different content,
 * which an mtime-only check would silently miss forever, since a match
 * also never refreshes the baseline). Kept as a standalone named
 * function (rather than folding size into it) because mtime-vs-size are
 * two independently meaningful, independently testable signals, and the
 * call site reads more honestly as "mtime AND size" than as one opaque
 * predicate.
 */
export function mtimeUnchanged(baselineMtimeMs: number | null, currentMtimeMs: number): boolean {
  return baselineMtimeMs !== null && baselineMtimeMs === currentMtimeMs;
}

/** Scan a single mount point and import any new files found */
async function scanSingleMount(mountPath: string): Promise<ScanResult> {
  if (!fs.existsSync(mountPath) || !fs.statSync(mountPath).isDirectory()) {
    // Not mounted or not a directory — silently skip
    return { imported: 0, versioned: 0, skipped: 0, failed: 0 };
  }

  const allowedExts = parseAllowedExts(config.importMountExts) ?? DEFAULT_EXTS;
  const maxBytes = config.importMaxMb * 1024 * 1024;
  const db = getDb();

  // Map of already-imported source paths -> their full asset row. Needed
  // (not just a Set of paths) so a known-path hit can be reconciled
  // against its current file_hash/source_mtime_ms without a second query
  // per file inside the loop.
  const existingByPath = new Map<string, AssetRow>(
    (db.prepare("SELECT * FROM assets WHERE source_path IS NOT NULL").all() as AssetRow[])
      .map((row) => [row.source_path as string, row])
  );

  // Walk the mount directory
  const pattern = path.join(mountPath, '**', '*').replace(/\\/g, '/');
  const allFiles = await glob(pattern, {
    nodir: true,
    dot: false,
    ignore: ['**/.*', '**/.*/'],
  });

  let imported = 0;
  let versioned = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`[mountImport] Scanning ${mountPath} — found ${allFiles.length} files`);

  for (const filePath of allFiles) {
    const ext = path.extname(filePath).toLowerCase();

    // Check extension filter
    if (allowedExts !== null && !allowedExts.has(ext)) {
      skipped++;
      continue;
    }

    const absPath = path.resolve(filePath);
    const existing = existingByPath.get(absPath);

    // ─── Already-imported path: reconcile instead of blind-skip ──────────
    if (existing) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        // Vanished/unreadable mid-scan — leave the existing asset row
        // untouched, don't guess.
        failed++;
        continue;
      }

      const mtimeMs = Math.round(stat.mtimeMs);

      // Cheapest correct path: mtime AND size both match the last-known
      // baseline — skip without reading/hashing. Size is free here
      // (already in `stat` from the statSync above) and closes the real
      // gap an mtime-only check has: a timestamp-preserving copy/sync
      // tool can re-stamp the exact prior mtime on different content,
      // and a re-slice/re-export virtually always changes byte size
      // even when it doesn't change the mtime handling. Requiring BOTH
      // to match is still a pure metadata check — no extra I/O — and
      // still correctly falls through to a real hash check whenever
      // either signal moved.
      if (mtimeUnchanged(existing.source_mtime_ms, mtimeMs) && existing.size === stat.size) {
        skipped++;
        continue;
      }

      if (stat.size > maxBytes) {
        console.warn(`[mountImport] Skipping re-hash (too large): ${absPath}`);
        failed++;
        continue;
      }

      let buf: Buffer;
      try {
        buf = fs.readFileSync(absPath);
      } catch (err) {
        console.error(`[mountImport] Failed to read for rescan ${absPath}:`, err);
        failed++;
        continue;
      }
      const newHash = crypto.createHash('sha256').update(buf).digest('hex');

      if (existing.file_hash !== null && existing.file_hash === newHash) {
        // mtime moved (touch, remount metadata churn, etc.) but content
        // is byte-identical — correct no-op. Update the baseline so
        // future scans don't pay the hash cost again until it actually
        // changes, and count it exactly as today: skipped.
        db.prepare('UPDATE assets SET source_mtime_ms = ? WHERE id = ?').run(mtimeMs, existing.id);
        skipped++;
        continue;
      }

      // Content genuinely changed (or this asset never captured a hash
      // in the first place, e.g. an old hash-read failure at import
      // time — treated as "must version," never as "assume unchanged").
      // Trashed assets are inert to the scanner (matches today's
      // behavior: a trashed row's source_path was already permanently
      // "known" and never touched again) — a content change there is
      // still just a skip, not an auto-version of a file Aaron deleted.
      if (existing.deleted_at !== null) {
        skipped++;
        continue;
      }

      try {
        archiveAndReplaceAssetFile(db, existing, buf, path.basename(absPath), AUTO_VERSION_NOTE);
        db.prepare('UPDATE assets SET source_mtime_ms = ? WHERE id = ?').run(mtimeMs, existing.id);
        versioned++;
      } catch (err) {
        console.error(`[mountImport] Auto-version failed for ${absPath}:`, err);
        failed++;
      }
      continue;
    }

    // ─── Genuinely new path — import exactly as before ────────────────────

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      failed++;
      continue;
    }

    if (stat.size > maxBytes) {
      console.warn(`[mountImport] Skipping (too large): ${absPath}`);
      failed++;
      continue;
    }

    // Derive folder structure from relative path
    const relPath = path.relative(mountPath, absPath);
    const relDir = path.dirname(relPath);
    const filename = path.basename(absPath);

    // Create/find folder hierarchy
    let folderId: string | null = null;
    if (relDir && relDir !== '.') {
      folderId = ensureFolderPath(db, relDir);
    }

    const mimeType = mime.lookup(filename) || 'application/octet-stream';
    const id = uuidv4();

    // Compute SHA-256 hash before moving the file
    let fileHash: string | null = null;
    try {
      const buf = fs.readFileSync(absPath);
      fileHash = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      // Hash failure is non-fatal — asset is still importable
    }

    const mtimeMs = Math.round(stat.mtimeMs);

    db.prepare(
      `INSERT INTO assets (id, filename, original_name, mime, size, folder_id, tags_json, source_path, thumb_status, meta_json, file_hash, source_mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, '{}', ?, ?)`
    ).run(
      id,
      filename,
      filename,
      mimeType,
      stat.size,
      folderId,
      absPath,
      THUMB_EXTS.has(ext) ? 'pending' : 'none',
      fileHash,
      mtimeMs,
    );

    try {
      // Move file into storage (rename on same FS, copy+delete across devices)
      const dest = assetFilePath(id, filename);
      moveFile(absPath, dest);

      // Extract metadata asynchronously (fire and forget — errors are logged)
      extractMeta(dest).then((meta) => {
        db.prepare('UPDATE assets SET meta_json = ? WHERE id = ?')
          .run(JSON.stringify(meta), id);
      }).catch((err) => console.warn(`[mountImport] Meta extraction failed for ${id}:`, err));

      if (THUMB_EXTS.has(ext)) {
        enqueueThumb(id);
      }

      // Keep the in-memory map consistent for the rest of this pass (glob
      // shouldn't yield the same absolute path twice, but this matches
      // the original Set.add() behavior exactly rather than assuming).
      existingByPath.set(absPath, db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow);
      imported++;
    } catch (err) {
      console.error(`[mountImport] Failed to copy ${absPath}:`, err);
      cleanupAsset(id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      failed++;
    }
  }

  console.log(`[mountImport] ${mountPath} done — imported: ${imported}, versioned: ${versioned}, skipped: ${skipped}, failed: ${failed}`);
  return { imported, versioned, skipped, failed };
}

// In-process guard against overlapping scans (Remy's peer review,
// Finding 2, 2026-07-11). Both real production entry points —
// index.ts's fire-and-forget startup scan and the (now, as of this PR,
// actually-wired-up) manual "Scan mounts" button hitting POST
// /import/scan — call scanMountImports() directly, with nothing
// preventing a second call from starting while the first is still
// walking a large mount. Traced consequence if unguarded: scan B builds
// its existingByPath snapshot before scan A's already-in-flight loop
// finishes, then A versions an asset, then B (working off its now-stale
// cached file_hash/size) re-reads the same file, sees a hash mismatch
// against its stale snapshot, and versions it AGAIN — producing an
// asset_versions row whose recorded metadata (copied from B's stale
// snapshot) doesn't match what it actually archived (A's already-new
// content). Does not lose data or create a duplicate assets row, but
// does corrupt a version-history entry, which is exactly the kind of
// untrustworthy state this whole feature exists to eliminate.
//
// A single module-level in-flight promise closes this: a second caller
// that arrives while a scan is running gets the SAME result instead of
// starting a second overlapping pass. Scoped to the whole
// scanMountImports() call (not per-mount) because both real call sites
// always scan every configured mount together — there's no scenario in
// this app where two DIFFERENT mounts need to scan concurrently badly
// enough to justify per-mount locking, and a single guard is simpler to
// reason about correctly.
let inFlightScan: Promise<ScanResult> | null = null;

/**
 * Scan all configured import mount paths in parallel.
 * Paths that aren't mounted or don't exist are silently skipped.
 */
export async function scanMountImports(): Promise<ScanResult> {
  if (inFlightScan) {
    console.log('[mountImport] Scan already in progress — reusing the in-flight result instead of starting a second overlapping scan.');
    return inFlightScan;
  }

  const paths = config.importMountPaths;
  if (!paths.length) {
    return { imported: 0, versioned: 0, skipped: 0, failed: 0 };
  }

  const run = (async (): Promise<ScanResult> => {
    const results = await Promise.allSettled(paths.map(scanSingleMount));

    return results.reduce<ScanResult>(
      (acc, r) => {
        if (r.status === 'fulfilled') {
          acc.imported += r.value.imported;
          acc.versioned += r.value.versioned;
          acc.skipped += r.value.skipped;
          acc.failed += r.value.failed;
        } else {
          console.error('[mountImport] Scan error:', r.reason);
          acc.failed++;
        }
        return acc;
      },
      { imported: 0, versioned: 0, skipped: 0, failed: 0 },
    );
  })();

  inFlightScan = run;
  try {
    return await run;
  } finally {
    // Release the guard once this run settles (success or failure) so
    // the NEXT genuinely-sequential scan isn't stuck reusing a stale
    // completed result.
    inFlightScan = null;
  }
}

// Exported for tests only — scanSingleMount() is the real entry point used
// by scanMountImports(), but the mount-rescan versioning tests exercise it
// directly against a temp mount dir + isolated DB (see
// __tests__/mountImportVersioning.test.ts) rather than going through the
// multi-mount fan-out.
export { scanSingleMount };

function ensureFolderPath(db: ReturnType<typeof getDb>, relDir: string): string {
  const parts = relDir.split(path.sep).filter(Boolean);
  let parentId: string | null = null;

  for (const part of parts) {
    const existing = db
      .prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ?')
      .get(part, parentId) as { id: string } | undefined;

    if (existing) {
      parentId = existing.id;
    } else {
      const id = uuidv4();
      db.prepare('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)').run(id, part, parentId);
      parentId = id;
    }
  }

  return parentId!;
}
