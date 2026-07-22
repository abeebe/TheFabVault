// Zip import — draft/commit routes (#2172, Phase C of the "Local
// MakerWorld" restructure; see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md).
//
// Three moves: upload a zip and get back an editable draft plan (POST
// /import/zip), commit an edited plan into a real model (POST
// /import/zip/:draftId/commit), or abandon a draft (DELETE
// /import/zip/:draftId). All filesystem/zip-slip mechanics live in
// services/zipImportDraft.ts; classification is C1's pure
// services/zipImportClassify.ts; this file is HTTP glue + the commit
// endpoint's re-validation and DB writes.
//
// Multer here uses diskStorage targeting scratchRootDir() (config.dataDir,
// local ext4) — deliberately NOT the memoryStorage every other upload
// route in this codebase uses (routes/assets.ts, routes/models.ts). A
// zip can be far larger than the single files those routes accept, and
// buffering an entire multipart upload in memory before ever touching
// disk is exactly the risk diskStorage avoids. Read this as "don't copy
// the memoryStorage pattern here," not as a knock on those routes — a
// single asset file is a different sizing problem than a whole zip.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import { requireAuth } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getDb } from '../db.js';
import { sanitizeFilename } from '../services/fileStore.js';
import { saveUploadedFile, findAssetByHash, needsThumbnail } from '../services/assetUpload.js';
import { enqueueThumb } from '../services/thumbGen.js';
import { classifyZipEntries, type ZipImportPlan } from '../services/zipImportClassify.js';
import {
  scratchRootDir, draftDirFor, resolveContainedPath, extractZip, writeDraftMeta, readDraftMeta,
  deleteDraftDir, sweepExpiredDrafts, MAX_ZIP_UPLOAD_BYTES, DRAFT_TTL_MS, ZipTooLargeError,
} from '../services/zipImportDraft.js';
import {
  MODEL_FILE_ROLES, isModelFileRole, MODEL_VISIBILITY, isModelVisibility,
} from '../services/enumValidators.js';
import { isValidSourceUrl } from '../services/urlValidators.js';
import { loadModelDetail } from './models.js';
import type { ModelFileRole } from '../services/enumValidators.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, scratchRootDir()),
    filename: (_req, _file, cb) => cb(null, `${uuidv4()}.zip`),
  }),
  limits: { fileSize: MAX_ZIP_UPLOAD_BYTES },
});

// multer calls next(err) for a limit violation before our async handler
// ever runs -- left uncaught, that reaches errorMiddleware.ts's generic
// 500, which is the wrong status for what's actually a client error
// ("your zip is too big"). This wrapper is the one place that
// distinction gets made.
function handleUpload(req: Request, res: Response, next: (err?: unknown) => void): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `Zip file exceeds the ${MAX_ZIP_UPLOAD_BYTES}-byte upload limit` });
      return;
    }
    next(err);
  });
}

// ─── POST /import/zip — upload, extract, classify ─────────────────────────────

router.post('/import/zip', requireAuth, handleUpload, asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Provide a zip file (multipart field "file")' }); return; }

  // Sweep-on-new-draft-creation, per the hard "no background scanning"
  // rule (#2078) -- this call site plus index.ts's boot-time call are
  // the ONLY two places sweepExpiredDrafts ever runs.
  sweepExpiredDrafts();

  const draftId = uuidv4();
  const draftDir = draftDirFor(draftId);
  const zipFilename = req.file.originalname || 'import.zip';
  const scratchZipPath = req.file.path;

  try {
    const rawEntries = await extractZip(scratchZipPath, draftDir);
    const plan: ZipImportPlan = classifyZipEntries(
      rawEntries.map((e) => ({ path: e.path, size: e.size })),
      zipFilename,
    );

    const createdAt = Date.now();
    writeDraftMeta({
      draftId, zipFilename, createdAt, plan,
    });

    res.status(201).json({
      draftId,
      zipFilename,
      plan,
      expiresAt: Math.floor((createdAt + DRAFT_TTL_MS) / 1000),
    });
  } catch (err) {
    // Extraction failed (corrupt zip, size cap, disk error) -- clean up
    // whatever partial draft dir exists so a bad upload doesn't leave
    // scratch garbage behind for the TTL sweep to find later.
    fs.rmSync(draftDir, { recursive: true, force: true });
    const message = err instanceof ZipTooLargeError
      ? err.message
      : 'Could not read zip file — it may be corrupt or not a valid zip archive';
    res.status(400).json({ error: message });
  } finally {
    fs.rm(scratchZipPath, { force: true }, () => {});
  }
}));

// ─── DELETE /import/zip/:draftId — abandon a draft ────────────────────────────

router.delete('/import/zip/:draftId', requireAuth, (req: Request, res: Response) => {
  const meta = readDraftMeta(req.params.draftId);
  if (!meta) { res.status(404).json({ error: 'Draft not found or already expired' }); return; }
  deleteDraftDir(req.params.draftId);
  res.status(204).end();
});

// ─── POST /import/zip/:draftId/commit — create the model ─────────────────────
//
// Every file path the client submits is re-validated against THIS
// draft's ORIGINAL server-side plan (from its sidecar), never against
// whatever role/invalid values the client echoes back — the classifier's
// `invalid` flag is informational for the wizard; this is the actual
// gate. resolveContainedPath is re-run here too (independent of the
// extraction-time check) before any file is read off disk, so a
// tampered or replayed path can't reach fs.readFileSync no matter what
// the original plan said.
//
// Asset creation (saveUploadedFile, hash-dedup via findAssetByHash) is
// async file I/O and deliberately happens OUTSIDE any db.transaction —
// better-sqlite3 transactions must be synchronous, same constraint
// routes/models.ts's POST /model/:id/files already lives with. Model +
// model_files + print_profiles are all synchronous SQL, so THOSE are
// wrapped in one transaction, matching POST /models/from-folder's
// existing shape. If that transaction throws, any assets already
// created in the preceding loop are left as ordinary unattached assets
// (a normal, supported state throughout this app, per models.ts's own
// header comment) — not rolled back, and not duplicated on a retry
// either, since a second commit attempt would dedup straight onto them
// via findAssetByHash.

interface CommitFileInput {
  path?: string;
  role?: string;
  label?: string | null;
}

interface CommitProfileInput {
  path?: string;
  name?: string;
}

router.post('/import/zip/:draftId/commit', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { draftId } = req.params;
  const meta = readDraftMeta(draftId);
  if (!meta) { res.status(404).json({ error: 'Draft not found or expired' }); return; }

  const {
    title, description, categoryId, tags, visibility,
    sourceUrl, sourceSite, sourceAuthor, license,
    files: fileSelections, coverPath, profiles: profileSelections,
  } = req.body as {
    title?: string;
    description?: string | null;
    categoryId?: string | null;
    tags?: string[];
    visibility?: string;
    sourceUrl?: string | null;
    sourceSite?: string | null;
    sourceAuthor?: string | null;
    license?: string | null;
    files?: CommitFileInput[];
    coverPath?: string | null;
    profiles?: CommitProfileInput[];
  };

  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }

  const vis = visibility ?? 'public';
  if (!isModelVisibility(vis)) {
    res.status(400).json({ error: `visibility must be one of: ${MODEL_VISIBILITY.join(', ')}` });
    return;
  }
  if (!isValidSourceUrl(sourceUrl)) {
    res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL' });
    return;
  }
  if (!Array.isArray(fileSelections) || fileSelections.length === 0) {
    res.status(400).json({ error: 'files must be a non-empty array' });
    return;
  }

  const db = getDb();

  if (categoryId) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!cat) { res.status(400).json({ error: 'Category not found' }); return; }
  }

  const draftDir = draftDirFor(draftId);
  const originalByPath = new Map(meta.plan.files.map((f) => [f.path, f]));

  const resolvedFiles: Array<{ path: string; role: ModelFileRole; label: string | null; absPath: string }> = [];
  for (const sel of fileSelections) {
    if (!sel?.path) { res.status(400).json({ error: 'Each file selection needs a path' }); return; }

    const original = originalByPath.get(sel.path);
    if (!original) { res.status(400).json({ error: `Unknown file path in commit: ${sel.path}` }); return; }
    if (original.invalid) { res.status(400).json({ error: `Cannot commit an unsafe path: ${sel.path}` }); return; }
    if (original.role === 'ignore') { res.status(400).json({ error: `Cannot commit an ignored file: ${sel.path}` }); return; }

    const role = sel.role ?? original.role;
    if (!isModelFileRole(role)) {
      res.status(400).json({ error: `role must be one of: ${MODEL_FILE_ROLES.join(', ')}` });
      return;
    }

    const absPath = resolveContainedPath(draftDir, sel.path);
    if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      res.status(400).json({ error: `File not found in draft: ${sel.path}` });
      return;
    }

    resolvedFiles.push({
      path: sel.path, role, label: sel.label ?? null, absPath,
    });
  }

  if (coverPath && !resolvedFiles.some((f) => f.path === coverPath && f.role === 'image')) {
    res.status(400).json({ error: 'coverPath must be one of the committed files with role=image' });
    return;
  }

  const profiles = profileSelections ?? [];
  for (const p of profiles) {
    if (!p?.path || !resolvedFiles.some((f) => f.path === p.path)) {
      res.status(400).json({ error: `Profile path must be one of the committed files: ${p?.path}` });
      return;
    }
  }

  // ─── Create assets (hash-dedup) ─────────────────────────────────────────────
  const assetIdByPath = new Map<string, string>();
  for (const f of resolvedFiles) {
    const buffer = fs.readFileSync(f.absPath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = findAssetByHash(db, hash);
    let assetId: string;
    if (existing) {
      assetId = existing.id;
    } else {
      const originalName = path.posix.basename(f.path.replace(/\\/g, '/'));
      const filename = sanitizeFilename(originalName);
      const mimeType = mime.lookup(filename) || 'application/octet-stream';
      assetId = uuidv4();
      // sourcePath deliberately left null: that column means "reconciled
      // against a live mount-scan location" (see db.ts's comment on
      // idx_assets_source) -- a zip's internal relative path isn't a
      // filesystem location that will ever be rescanned, so it isn't
      // that. This is closest to a plain upload, just batched.
      // eslint-disable-next-line no-await-in-loop
      await saveUploadedFile(buffer, assetId, filename, mimeType, null, [], null, originalName);
      if (needsThumbnail(filename)) enqueueThumb(assetId);
    }
    assetIdByPath.set(f.path, assetId);
  }

  // ─── Model + model_files + print_profiles (one transaction) ────────────────
  const modelId = uuidv4();
  const coverAssetId = coverPath ? assetIdByPath.get(coverPath) ?? null : null;
  // Explicit `sourceSite` (even '' to clear it) wins; otherwise fall back
  // to the classifier's guess so provenance isn't lost just because the
  // wizard didn't override it.
  const resolvedSourceSite = sourceSite !== undefined ? sourceSite : meta.plan.guessedSourceSite;

  const commitTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO models (id, title, description, category_id, tags_json, owner_id, visibility, source_url, source_site, source_author, license, cover_asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      modelId, title.trim(), description?.trim() || null, categoryId || null,
      JSON.stringify(tags ?? []), req.user!.id, vis,
      sourceUrl?.trim() || null, resolvedSourceSite?.trim() || null,
      sourceAuthor?.trim() || null, license?.trim() || null, coverAssetId,
    );

    // INSERT OR IGNORE: two selected paths can legitimately dedup onto
    // the SAME existing asset (e.g. the "duplicate filenames in
    // different directories" fixture, if byte-identical) — model_files'
    // PK is (model_id, asset_id), so a second link attempt for the same
    // resolved asset is a no-op rather than a constraint violation.
    const insertFile = db.prepare(
      'INSERT OR IGNORE INTO model_files (model_id, asset_id, role, sort_order, label) VALUES (?, ?, ?, ?, ?)'
    );
    resolvedFiles.forEach((f, i) => {
      insertFile.run(modelId, assetIdByPath.get(f.path), f.role, i, f.label);
    });

    const insertProfile = db.prepare(
      `INSERT INTO print_profiles (id, model_id, name, sliced_asset_id, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    );
    profiles.forEach((p, i) => {
      insertProfile.run(
        uuidv4(), modelId, p.name?.trim() || path.posix.basename(p.path!), assetIdByPath.get(p.path!), i,
      );
    });
  });
  commitTx();

  deleteDraftDir(draftId);

  const detail = loadModelDetail(db, modelId, req.user!.id)!;
  res.status(201).json({ model: detail });
}));

export default router;
