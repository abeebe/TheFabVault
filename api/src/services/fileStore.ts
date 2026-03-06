import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

export const STORAGE_DIR = config.storageDir;
export const THUMBS_DIR = path.join(STORAGE_DIR, 'thumbs');

// Ensure base dirs exist on import
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

export function assetDir(assetId: string): string {
  const dir = path.join(STORAGE_DIR, assetId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetFilePath(assetId: string, filename: string): string {
  return path.join(assetDir(assetId), filename);
}

export function versionDir(assetId: string): string {
  const dir = path.join(assetDir(assetId), 'versions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function versionFilePath(assetId: string, versionId: string, filename: string): string {
  return path.join(versionDir(assetId), `${versionId}_${filename}`);
}

export function thumbFilePath(assetId: string): string {
  return path.join(THUMBS_DIR, `${assetId}.jpg`);
}

export function thumbExists(assetId: string): boolean {
  return fs.existsSync(thumbFilePath(assetId));
}

export function cleanupAsset(assetId: string, { deleteFile = true }: { deleteFile?: boolean } = {}): void {
  if (deleteFile) {
    try {
      const dir = path.join(STORAGE_DIR, assetId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[fileStore] Failed to cleanup asset dir ${assetId}:`, err);
    }
  }
  // Always remove the generated thumbnail regardless of deleteFile
  try {
    const thumb = thumbFilePath(assetId);
    if (fs.existsSync(thumb)) {
      fs.unlinkSync(thumb);
    }
  } catch (err) {
    console.error(`[fileStore] Failed to cleanup thumb ${assetId}:`, err);
  }
}

export function sanitizeFilename(name: string): string {
  return path
    .basename(name)
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 255);
}
