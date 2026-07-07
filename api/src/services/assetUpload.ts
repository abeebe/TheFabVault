// Shared asset-persistence logic — the actual "write bytes + insert a row"
// mechanics behind POST /upload (routes/assets.ts). Extracted so the
// folder-import batch endpoints (routes/manifestImport.ts) can create a
// genuinely new asset exactly the same way a regular single-file upload
// does, rather than a second, divergent copy of this logic living in the
// import route. Behavior is unchanged from the pre-extraction version —
// this is a pure move, not a rewrite.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from '../db.js';
import { assetFilePath } from './fileStore.js';
import { extractMeta } from './metaExtract.js';
import type { AssetRow } from '../types/index.js';

export const THUMB_ELIGIBLE_EXTS = new Set([
  '.stl', '.obj', '.3mf',
  '.svg', '.dxf', '.pdf', '.lbrn', '.lbrn2',
  '.png', '.jpg', '.jpeg', '.webp',
  '.gcode', '.gc', '.g',
]);

export function needsThumbnail(filename: string): boolean {
  return THUMB_ELIGIBLE_EXTS.has(path.extname(filename).toLowerCase());
}

// Looks up an existing, non-deleted asset by content hash. Shared by
// POST /check-hash (client-side pre-upload dedup warning) and the
// folder-import batch endpoint's server-side dedup backstop (see
// routes/manifestImport.ts) — one query, not two copies that could drift.
export function findAssetByHash(db: ReturnType<typeof getDb>, hash: string): AssetRow | undefined {
  return db.prepare('SELECT * FROM assets WHERE file_hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as
    | AssetRow | undefined;
}

export async function saveUploadedFile(
  buffer: Buffer,
  assetId: string,
  filename: string,
  mimeType: string,
  folderId: string | null,
  tags: string[],
  notes: string | null,
  originalName: string | null,
  sourcePath: string | null = null,
): Promise<AssetRow> {
  const db = getDb();

  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  db.prepare(
    `INSERT INTO assets (id, filename, original_name, mime, size, folder_id, tags_json, notes, source_path, thumb_status, meta_json, file_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    assetId, filename, originalName, mimeType, buffer.length,
    folderId ?? null, JSON.stringify(tags), notes ?? null, sourcePath,
    needsThumbnail(filename) ? 'pending' : 'none', '{}', fileHash,
  );

  const dest = assetFilePath(assetId, filename);
  fs.writeFileSync(dest, buffer);

  const size = fs.statSync(dest).size;
  db.prepare('UPDATE assets SET size = ? WHERE id = ?').run(size, assetId);

  // Run metadata extraction in the background so large 3D files don't block
  // the upload response. The row is returned immediately with meta_json='{}'
  // and updated once extraction finishes.
  void extractMeta(dest)
    .then((meta) => {
      getDb()
        .prepare('UPDATE assets SET meta_json = ? WHERE id = ?')
        .run(JSON.stringify(meta), assetId);
    })
    .catch((err) => {
      console.warn(`[assetUpload] Meta extraction failed for ${assetId}:`, err);
    });

  return db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow;
}
