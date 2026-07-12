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
 * Falls back to copy + delete when src and dst are on different devices (EXDEV).
 */
function moveFile(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

/**
 * Mtime pre-filter (Sloane's PRD feasibility Q1): decide whether a
 * known-path file needs to be re-read and re-hashed at all, based purely
 * on a cheap fs.statSync() mtime comparison against the mtime captured
 * the last time this asset was reconciled.
 *
 * Returns true (skip re-hash) only when we HAVE a prior baseline AND it
 * exactly matches the current mtime. Any other case — no baseline yet
 * (pre-existing asset from before this column existed, or a brand-new
 * import whose baseline hasn't landed for some reason) or a baseline
 * that doesn't match — falls through to "needs a hash check," which is
 * the safe default: at worst it costs one redundant hash, never a
 * missed content change.
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

      if (mtimeUnchanged(existing.source_mtime_ms, mtimeMs)) {
        // Cheapest correct path: mtime matches the last-known baseline,
        // so the bytes have not changed — skip without reading/hashing.
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

/**
 * Scan all configured import mount paths in parallel.
 * Paths that aren't mounted or don't exist are silently skipped.
 */
export async function scanMountImports(): Promise<ScanResult> {
  const paths = config.importMountPaths;
  if (!paths.length) {
    return { imported: 0, versioned: 0, skipped: 0, failed: 0 };
  }

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
