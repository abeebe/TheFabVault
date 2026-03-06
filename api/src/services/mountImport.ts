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
import { config } from '../config.js';
import type { ScanResult, AssetRow } from '../types/index.js';

const DEFAULT_EXTS = new Set([
  '.stl', '.obj', '.3mf',
  '.svg', '.dxf',
  '.png', '.jpg', '.jpeg', '.webp',
  '.gcode', '.gc', '.g',
]);

const THUMB_EXTS = new Set(['.stl', '.obj', '.3mf', '.svg', '.dxf', '.png', '.jpg', '.jpeg', '.webp', '.gcode', '.gc', '.g']);

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

/** Scan a single mount point and import any new files found */
async function scanSingleMount(mountPath: string): Promise<ScanResult> {
  if (!fs.existsSync(mountPath) || !fs.statSync(mountPath).isDirectory()) {
    // Not mounted or not a directory — silently skip
    return { imported: 0, skipped: 0, failed: 0 };
  }

  const allowedExts = parseAllowedExts(config.importMountExts) ?? DEFAULT_EXTS;
  const maxBytes = config.importMaxMb * 1024 * 1024;
  const db = getDb();

  // Build set of already-imported source paths
  const existingPaths = new Set<string>(
    (db.prepare("SELECT source_path FROM assets WHERE source_path IS NOT NULL").all() as { source_path: string }[])
      .map((r) => r.source_path)
  );

  // Walk the mount directory
  const pattern = path.join(mountPath, '**', '*').replace(/\\/g, '/');
  const allFiles = await glob(pattern, {
    nodir: true,
    dot: false,
    ignore: ['**/.*', '**/.*/'],
  });

  let imported = 0;
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

    // Already imported
    if (existingPaths.has(absPath)) {
      skipped++;
      continue;
    }

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

    db.prepare(
      `INSERT INTO assets (id, filename, original_name, mime, size, folder_id, tags_json, source_path, thumb_status, meta_json, file_hash)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, '{}', ?)`
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

      existingPaths.add(absPath);
      imported++;
    } catch (err) {
      console.error(`[mountImport] Failed to copy ${absPath}:`, err);
      cleanupAsset(id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      failed++;
    }
  }

  console.log(`[mountImport] ${mountPath} done — imported: ${imported}, skipped: ${skipped}, failed: ${failed}`);
  return { imported, skipped, failed };
}

/**
 * Scan all configured import mount paths in parallel.
 * Paths that aren't mounted or don't exist are silently skipped.
 */
export async function scanMountImports(): Promise<ScanResult> {
  const paths = config.importMountPaths;
  if (!paths.length) {
    return { imported: 0, skipped: 0, failed: 0 };
  }

  const results = await Promise.allSettled(paths.map(scanSingleMount));

  return results.reduce<ScanResult>(
    (acc, r) => {
      if (r.status === 'fulfilled') {
        acc.imported += r.value.imported;
        acc.skipped += r.value.skipped;
        acc.failed += r.value.failed;
      } else {
        console.error('[mountImport] Scan error:', r.reason);
        acc.failed++;
      }
      return acc;
    },
    { imported: 0, skipped: 0, failed: 0 },
  );
}

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
