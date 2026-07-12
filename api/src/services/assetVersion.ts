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
//
// Transactional scope (Remy's peer review, Finding 3, 2026-07-11): the
// asset_versions INSERT and the final `assets` UPDATE are one
// db.transaction() together (not two separate, unguarded writes as in
// the pre-review version of this function). Remy traced that with them
// split, a late failure on the UPDATE (e.g. a WAL I/O hiccup) after the
// live file had already been overwritten could leave the asset_versions
// row committed while the assets row still described the pre-change
// state — and flagged that this was inherited from the original
// pre-extraction endpoint (not a regression this file introduced), but
// that the new unattended scanner call site changes who's watching when
// it happens: a human clicking "upload new version" would see an error
// toast; a scanner running unattended would just leave it for the next
// pass to build on top of. The live-file write is sequenced INSIDE the
// transaction closure (a side effect, not a SQL statement) specifically
// so it happens BEFORE the UPDATE it needs to be consistent with — if
// anything after it throws, better-sqlite3 rolls back both SQL writes
// and the catch below removes the orphaned archive copy, so the net
// state is "as if this call never started," not "half-applied."
//
// Residual, not engineered away here: fs writes are not part of the SQL
// transaction and can't be rolled back by it. If fs.writeFileSync
// itself succeeds and the UPDATE immediately after it then throws, the
// live file already has the new bytes while the assets row (rolled
// back) still describes the old ones — a real but narrow window
// (basically just the gap between two sequential in-process statements,
// not the wider one that existed before this fix), accepted as residual
// risk for a Small-appetite bet rather than solved with a staging-file/
// two-phase-commit scheme, which would be new architecture, not a cheap
// tightening.
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

  // Archive prior bytes to versions/ BEFORE anything else — if this
  // throws (disk full, permissions), nothing below runs: no DB write,
  // no live-file mutation.
  if (fs.existsSync(currentFilePath)) {
    fs.copyFileSync(currentFilePath, archivePath);
  }

  const newFilename = sanitizeFilename(requestedFilename);
  const newHash = crypto.createHash('sha256').update(newBuffer).digest('hex');
  const newPath = assetFilePath(asset.id, newFilename);

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

      // Side effects inside the transaction closure, sequenced before
      // the UPDATE they need to be consistent with — see this file's
      // header comment (Finding 3). If either throws, better-sqlite3
      // rolls back the INSERT above (and the UPDATE never runs).
      fs.writeFileSync(newPath, newBuffer);
      if (newFilename !== asset.filename && fs.existsSync(currentFilePath)) {
        try { fs.unlinkSync(currentFilePath); } catch { /* best effort */ }
      }

      db.prepare(
        `UPDATE assets SET filename = ?, size = ?, file_hash = ?, thumb_status = ? WHERE id = ?`
      ).run(newFilename, newBuffer.length, newHash, needsThumbnail(newFilename) ? 'pending' : 'none', asset.id);

      return num;
    })();
  } catch (err) {
    // Roll back the archive copy too — don't strand an orphaned version
    // file on disk with no asset_versions row pointing at it. The SQL
    // transaction above already rolled back the INSERT/UPDATE; the
    // asset row (if the throw happened before the UPDATE ran) still
    // describes its pre-call state.
    try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch { /* best effort */ }
    throw err;
  }

  if (needsThumbnail(newFilename)) enqueueThumb(asset.id);

  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id) as AssetRow;
  return { asset: updated, versionId, versionNum };
}
