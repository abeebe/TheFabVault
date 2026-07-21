// Folder-tree auto-import — Bet 2 of the build manifest. See:
// Reports/sloane-prd-thefabvault-build-manifest-2026-07-06.md (folder-import
//   mapping: hash-check ordering, ensureSubAssemblyPath, idempotency)
// Reports/reid-thefabvault-import-ux-2026-07-07.md (the Scan/Preview/Commit/
//   Result modal this API backs, and the two-endpoint shape below)
//
// Two endpoints, one per file, matching the existing worker-pool pattern
// (uploadStore.ts) rather than one opaque batch call — Reid's UX spec
// requires per-file progress to be observable, and the client already
// knows exactly which of these two calls a given file needs by the time
// Commit starts (resolved during the Scan phase's hashing pass):
//
//   POST /project/:id/import/upload-file   — a genuinely new file: send the
//     bytes, this creates the asset (or discovers a server-side hash match
//     and links instead — see "server-side hash check" below).
//   POST /project/:id/import/link-existing — a file whose bytes are already
//     known to exist as an asset (vault-wide dedup, or the 2nd..Nth file in
//     a same-batch duplicate group): no bytes sent, just a placement.
//
// Server-side hash check on upload-file, even though the client already
// ran its own scan-phase hash check via /check-hash: this is the
// correctness backstop the PRD's "shared parts are links, not copies"
// decision actually depends on. The client's scan and the commit can be
// separated by an arbitrarily long Preview phase (Aaron reviewing a
// 500-file tree), during which another asset with the same hash could
// land in the vault from something unrelated. Re-checking here is what
// makes "a hash match must create a PLACEMENT, not a bare skip" hold even
// under that race, not just in the common case.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import { requireAuth } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getDb } from '../db.js';
import { sanitizeFilename, thumbExists } from '../services/fileStore.js';
import { enqueueThumb } from '../services/thumbGen.js';
import { saveUploadedFile, needsThumbnail, findAssetByHash } from '../services/assetUpload.js';
import { resolveAndPlace } from '../services/subAssemblyImport.js';
import type { AssetOut, AssetRow } from '../types/index.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB — matches routes/assets.ts's /upload limit
});

// Mirrors routes/subAssemblies.ts / routes/projects.ts's assetRowToOut —
// kept inline rather than imported to avoid coupling routes together, same
// convention already established at both of those call sites.
function assetRowToOut(row: AssetRow): AssetOut {
  const tags: string[] = JSON.parse(row.tags_json || '[]');
  const encodedName = encodeURIComponent(row.filename);
  let thumbStatus = row.thumb_status;
  if (thumbStatus === 'done' && !thumbExists(row.id)) thumbStatus = 'failed';
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    folderId: row.folder_id,
    tags,
    notes: row.notes,
    thumbStatus,
    thumbUrl: thumbStatus === 'done' ? `/thumb/${row.id}.jpg` : null,
    url: `/file/${row.id}/${encodedName}`,
    meta: JSON.parse(row.meta_json || '{}'),
    createdAt: row.created_at,
    category: row.category ?? null,
    deletedAt: row.deleted_at ?? null,
    rating: row.rating ?? null,
    isFavorite: Boolean(row.is_favorite),
  };
}

// Parses and validates the two body fields both endpoints share:
// pathSegments and parentSubAssemblyId (the modal's targetParentId — null
// for project root, a specific node id when drilled in). Returns null and
// writes the error response itself on failure, so callers can
// `if (!parsed) return;`.
//
// pathSegments arrives in two different wire shapes depending on the
// caller's content-type, and both are valid here: upload-file is
// multipart/form-data (a real file to attach), where every field is a
// string, so the client JSON-encodes the array; link-existing is a plain
// JSON body, where express.json() has already parsed it into a real array
// by the time this runs. Accept either rather than forcing link-existing
// to double-encode just to match upload-file's constraint.
function parseImportTarget(
  req: Request, res: Response, projectId: string,
): { pathSegments: string[]; parentSubAssemblyId: string | null } | null {
  const db = getDb();
  const rawField = req.body.pathSegments as unknown;
  let pathSegments: unknown;
  if (rawField === undefined) {
    pathSegments = [];
  } else if (typeof rawField === 'string') {
    try {
      pathSegments = JSON.parse(rawField);
    } catch {
      res.status(400).json({ error: 'pathSegments must be a JSON-encoded array of strings' });
      return null;
    }
  } else {
    pathSegments = rawField;
  }
  if (!Array.isArray(pathSegments) || !pathSegments.every((s) => typeof s === 'string')) {
    res.status(400).json({ error: 'pathSegments must be an array of strings' });
    return null;
  }

  const parentSubAssemblyId = (req.body.parentSubAssemblyId as string | undefined) || null;
  if (parentSubAssemblyId) {
    const parent = db.prepare('SELECT id, project_id FROM sub_assemblies WHERE id = ?').get(parentSubAssemblyId) as
      | { id: string; project_id: string } | undefined;
    if (!parent || parent.project_id !== projectId) {
      res.status(400).json({ error: 'parentSubAssemblyId not found in this project' });
      return null;
    }
  }

  return { pathSegments: pathSegments as string[], parentSubAssemblyId };
}

// ─── POST /project/:id/import/upload-file ─────────────────────────────────────

router.post('/project/:id/import/upload-file', requireAuth, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  // Whole-body try/catch — Remy's review found that deleting the target
  // project mid-import (a real scenario for a large, long-running batch)
  // throws an FK-violation out of resolveAndPlace with nothing to catch
  // it. This local try/catch still gives a specific "Import failed"
  // message; the asyncHandler wrapper (#2044) plus the app-wide
  // errorMiddleware in index.ts is the backstop underneath it for
  // anything this catch doesn't cover, not a replacement for it. The
  // client's per-file processOne() in importStore.ts already handles an
  // arbitrary HTTP error gracefully (marks that one file as 'error' and
  // moves on), so a 500 here degrades to "this file failed" instead of
  // "every open tab is down."
  try {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }

    const target = parseImportTarget(req, res, req.params.id);
    if (!target) return;

    // Server-side hash check — see file header comment. findAssetByHash only
    // matches non-deleted assets: linking a fresh import to a trashed asset
    // would silently resurrect it into the manifest, which isn't what
    // "already in the vault" should mean here.
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const existing = findAssetByHash(db, fileHash);

    if (existing) {
      const { subAssemblyId, createdSubAssemblyIds } = resolveAndPlace(
        db, req.params.id, target.parentSubAssemblyId, target.pathSegments, existing.id,
      );
      res.status(200).json({ asset: assetRowToOut(existing), linked: true, subAssemblyId, createdSubAssemblyIds });
      return;
    }

    const originalName = req.file.originalname || 'upload';
    const filename = sanitizeFilename(originalName);
    const mimeType = req.file.mimetype || mime.lookup(filename) || 'application/octet-stream';
    const id = uuidv4();
    const row = await saveUploadedFile(req.file.buffer, id, filename, mimeType, null, [], null, originalName);
    if (needsThumbnail(filename)) enqueueThumb(id);

    const { subAssemblyId, createdSubAssemblyIds } = resolveAndPlace(
      db, req.params.id, target.parentSubAssemblyId, target.pathSegments, row.id,
    );
    res.status(201).json({ asset: assetRowToOut(row), linked: false, subAssemblyId, createdSubAssemblyIds });
  } catch (err) {
    console.error('[import/upload-file]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Import failed' });
  }
}));

// ─── POST /project/:id/import/link-existing ───────────────────────────────────
// Used for: (1) a vault-wide dedup match the client already knows about
// from its scan-phase /check-hash call, and (2) the 2nd..Nth file in a
// same-batch duplicate group, pointed at the asset id the group's first
// file's upload-file call returned. Either way: no bytes sent, one
// placement created.

router.post('/project/:id/import/link-existing', requireAuth, (req: Request, res: Response) => {
  // See the whole-body try/catch note on upload-file above — same
  // FK-violation-on-mid-import-project-delete failure mode applies here
  // (resolveAndPlace is shared by both handlers).
  try {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const { assetId } = req.body as { assetId?: string };
    if (!assetId) { res.status(400).json({ error: 'assetId is required' }); return; }
    const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId) as
      | AssetRow | undefined;
    if (!asset) { res.status(404).json({ error: 'Asset not found' }); return; }

    const target = parseImportTarget(req, res, req.params.id);
    if (!target) return;

    const { subAssemblyId, createdSubAssemblyIds } = resolveAndPlace(
      db, req.params.id, target.parentSubAssemblyId, target.pathSegments, asset.id,
    );
    res.status(200).json({ asset: assetRowToOut(asset), linked: true, subAssemblyId, createdSubAssemblyIds });
  } catch (err) {
    console.error('[import/link-existing]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Import failed' });
  }
});

export default router;
