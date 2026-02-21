import fs from 'fs';
import path from 'path';
import { STORAGE_DIR, THUMBS_DIR } from './fileStore.js';
import { getDb } from '../db.js';

/**
 * Recursively calculate total storage usage for a directory
 */
export function calculateDirectorySize(dirPath: string): number {
  let totalSize = 0;

  try {
    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      try {
        if (entry.isDirectory()) {
          totalSize += calculateDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          totalSize += stat.size;
        }
      } catch (err) {
        // Skip files we can't access
        console.warn(`[storageStats] Failed to stat ${fullPath}:`, err);
      }
    }
  } catch (err) {
    console.error(`[storageStats] Failed to read directory ${dirPath}:`, err);
    return 0;
  }

  return totalSize;
}

/**
 * Get storage breakdown including assets, thumbnails, and total
 */
export function getStorageBreakdown(): {
  total: number;
  assets: number;
  thumbnails: number;
  assetCount: number;
  percentUsed?: number;
} {
  const db = getDb();

  // Calculate directory sizes
  const assetsSize = calculateDirectorySize(STORAGE_DIR);
  const thumbnailsSize = calculateDirectorySize(THUMBS_DIR);

  // Get asset count from DB
  const countResult = db
    .prepare('SELECT COUNT(*) as count FROM assets')
    .get() as { count: number };
  const assetCount = countResult.count;

  return {
    total: assetsSize,
    assets: assetsSize,
    thumbnails: thumbnailsSize,
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
