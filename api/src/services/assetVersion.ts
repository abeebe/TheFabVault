// Shared version-archive logic — the "archive current bytes as an
// asset_versions row, then replace the live file in place" mechanics
// behind POST /asset/:id/version (routes/assets.ts). Extracted so the
// mount-scan auto-versioning path (services/mountImport.ts) creates a
// version exactly the same way an explicit VersionPanel upload does —
// one archive-and-replace implementation, not two that could drift.
// Same extraction rationale as services/assetUpload.ts's
// saveUploadedFile/findAssetByHash (see that file's header comment).
//
// Race safety (Sloane's PRD feasibility Q2,
// Reports/sloane-prd-thefabvault-file-versioning-2026-07-11.md):
// the existing manual endpoint computed `MAX(version_num) + 1` via a
// plain read-then-insert with no transaction. In THIS codebase that is
// not actually racy against another caller within the same process:
// better-sqlite3 is fully synchronous, and there is no `await` between
// the MAX read and the INSERT below, so nothing else can interleave
// mid-sequence — Node's run-to-completion semantics make this stretch
// atomic by construction, regardless of how many "concurrent" HTTP
// requests or scan passes are in flight. (This is a structural fact
// about the current single-process code, not a guarantee that survives
// a future refactor that adds an `await` in between, or a
// horizontally-scaled multi-process deployment.) The read+insert is
// still wrapped in an explicit db.transaction() below, for two reasons
// that are NOT "fixing a real race": (1) it documents the atomicity
// requirement in code instead of leaving it implicit, and (2) it keeps
// UNIQUE(asset_id, version_num) as a defense-in-depth backstop — if it
// ever fires (e.g. after a future change reintroduces a real race),
// better-sqlite3 throws synchronously, the transaction rolls back, and
// the orphaned archive copy is removed below — a loud failure, never a
// silent lost-archive or corrupted asset row.
// See api/src/__tests__/assetVersion.test.ts for the tests backing this.

import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { assetFilePath, versionFilePath, sanitizeFilename } from './fileStore.js';
import { needsThumbnail } from './assetUpload.js';
import { enqueueThumb } from './thumbGen.js';
import type { AssetRow } from '../types/index.js';

export interface ArchiveAndReplaceResult {
  asset: AssetRow;
  versionId: string;
  versionNum: number;
}

/**
 * Archive `asset`'s current live bytes into asset_versions + versionDir(),
 * then replace the live file with newBuffer/requestedFilename and update
 * the assets row in place (same id — never a new asset row).
 *
 * `notes` carries either a user-authored note (explicit VersionPanel
 * upload) or a system-authored origin marker string (mount-scan
 * auto-version) — see mountImport.ts's AUTO_VERSION_NOTE. No schema
 * column for "source" — Sloane's PRD leans on the existing free-text
 * `notes` column rather than a migration for this (fork left to Kit's
 * call; taking the cheaper option since a single-user tool doesn't need
 * a CHECK-constrained source enum to filter by later).
 */
export function archiveAndReplaceAssetFile(
  db: Database.Database,
  asset: AssetRow,
  newBuffer: Buffer,
  requestedFilename: string,
  notes: string | null,
): ArchiveAndReplaceResult {
  const versionId = uuidv4();

  const currentFilePath = assetFilePath(asset.id, asset.filename);
  const archivePath = versionFilePath(asset.id, versionId, asset.filename);

  // Archive prior bytes to versions/ BEFORE any DB write — if this
  // throws (disk full, permissions), nothing below runs and no
  // asset_versions row is created pointing at bytes that don't exist.
  if (fs.existsSync(currentFilePath)) {
    fs.copyFileSync(currentFilePath, archivePath);
  }

  let versionNum: number;
  try {
    versionNum = db.transaction(() => {
      const { maxVer } = db.prepare(
        'SELECT COALESCE(MAX(version_num), 0) AS maxVer FROM asset_versions WHERE asset_id = ?'
      ).get(asset.id) as { maxVer: number };
      const num = maxVer + 1;

      db.prepare(
        `INSERT INTO asset_versions (id, asset_id, version_num, filename, size, file_hash, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(versionId, asset.id, num, asset.filename, asset.size, asset.file_hash, notes);

      return num;
    })();
  } catch (err) {
    // Roll back the archive copy too — don't strand an orphaned version
    // file on disk with no asset_versions row pointing at it. The SQL
    // transaction above already rolled itself back; the asset row and
    // live file are untouched (we haven't gotten to them yet).
    try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch { /* best effort */ }
    throw err;
  }

  // Same order as the pre-extraction route: write new bytes, unlink the
  // old file if renamed, THEN update the assets row. Not crash-atomic
  // with the file write (pre-existing characteristic, not something
  // this bet is fixing) — preserved as-is rather than reordered, so the
  // explicit VersionPanel flow's observable behavior is unchanged.
  const newFilename = sanitizeFilename(requestedFilename);
  const newHash = crypto.createHash('sha256').update(newBuffer).digest('hex');
  const newPath = assetFilePath(asset.id, newFilename);
  fs.writeFileSync(newPath, newBuffer);

  if (newFilename !== asset.filename && fs.existsSync(currentFilePath)) {
    try { fs.unlinkSync(currentFilePath); } catch { /* best effort */ }
  }

  db.prepare(
    `UPDATE assets SET filename = ?, size = ?, file_hash = ?, thumb_status = ? WHERE id = ?`
  ).run(newFilename, newBuffer.length, newHash, needsThumbnail(newFilename) ? 'pending' : 'none', asset.id);

  if (needsThumbnail(newFilename)) enqueueThumb(asset.id);

  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id) as AssetRow;
  return { asset: updated, versionId, versionNum };
}
