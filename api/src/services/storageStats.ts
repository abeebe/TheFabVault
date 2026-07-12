import fs from 'fs';
import path from 'path';
import { STORAGE_DIR, THUMBS_DIR } from './fileStore.js';
import { getDb } from '../db.js';

export interface DirSizeResult {
  total: number;
  // Bytes under any directory named "versions" — asset_versions archive
  // copies live at <STORAGE_DIR>/<assetId>/versions/... (see
  // fileStore.ts#versionDir). Folded into the same recursive pass as
  // `total` rather than a second walk (Sloane's PRD feasibility Q5) —
  // STORAGE_DIR can hold large 3D files, so a second full pass over it
  // isn't free the way re-walking THUMBS_DIR (small JPEGs) would be.
  versions: number;
}

/**
 * Single recursive walk of a directory that sums total bytes AND, in the
 * same pass, buckets out how many of those bytes sit under a `versions/`
 * subdirectory at any depth.
 */
export function walkDirectorySize(dirPath: string, insideVersions = false): DirSizeResult {
  let total = 0;
  let versions = 0;

  try {
    if (!fs.existsSync(dirPath)) {
      return { total: 0, versions: 0 };
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const nowInsideVersions = insideVersions || entry.name === 'versions';

      try {
        if (entry.isDirectory()) {
          const sub = walkDirectorySize(fullPath, nowInsideVersions);
          total += sub.total;
          versions += sub.versions;
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          total += stat.size;
          if (nowInsideVersions) versions += stat.size;
        }
      } catch (err) {
        // Skip files we can't access
        console.warn(`[storageStats] Failed to stat ${fullPath}:`, err);
      }
    }
  } catch (err) {
    console.error(`[storageStats] Failed to read directory ${dirPath}:`, err);
    return { total: 0, versions: 0 };
  }

  return { total, versions };
}

/**
 * Recursively calculate total storage usage for a directory
 */
export function calculateDirectorySize(dirPath: string): number {
  return walkDirectorySize(dirPath).total;
}

/**
 * Get storage breakdown including assets, thumbnails, version archives,
 * and total.
 */
export function getStorageBreakdown(): {
  total: number;
  assets: number;
  thumbnails: number;
  versions: number;
  assetCount: number;
  percentUsed?: number;
} {
  const db = getDb();

  // Single walk of STORAGE_DIR gets both the total and the versions/
  // sub-bucket. THUMBS_DIR is a separate (small) tree, walked on its own
  // exactly as before — that second call is pre-existing, not something
  // this change adds.
  const assetsWalk = walkDirectorySize(STORAGE_DIR);
  const thumbnailsSize = calculateDirectorySize(THUMBS_DIR);

  // Get asset count from DB
  const countResult = db
    .prepare('SELECT COUNT(*) as count FROM assets')
    .get() as { count: number };
  const assetCount = countResult.count;

  return {
    total: assetsWalk.total,
    assets: assetsWalk.total,
    thumbnails: thumbnailsSize,
    versions: assetsWalk.versions,
    assetCount,
  };
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
