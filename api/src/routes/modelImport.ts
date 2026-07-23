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
import { classifyZipEntries, isPreviewableTextPath, type ZipImportPlan } from '../services/zipImportClassify.js';
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

// Validated at the top of every route that takes :draftId as a URL
// param, BEFORE it ever reaches draftDirFor/readDraftMeta/deleteDraftDir
// (Vera's security review, #2172 follow-up, HIGH finding). draftIds are
// always server-generated uuidv4()s (POST /import/zip), so a
// non-UUID-shaped value can only be a client trying something --
// confirmed exploitable: Express decodes %2f in a route param AFTER
// matching, so `DELETE /import/zip/..%2Fvictim-dir` arrives at the
// handler with req.params.draftId === '../victim-dir', which
// draftDirFor's plain path.join happily turns into a real path outside
// import-drafts/ (resolveContainedPath is never in that call chain at
// all -- draftDirFor has no base to contain against, it's just building
// the base). This regex closes the class regardless of any future
// Express/routing quirk, independent of that root cause.
const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDraftId(value: string): boolean {
  return DRAFT_ID_RE.test(value);
}

// Ownership gate (Vera's security review, #2172 follow-up, HIGH finding,
// explicit Phase D blocker closed now while it's still a design decision
// rather than a migration): requireAuth only proves SOME valid session
// exists, not that the caller created THIS draft. 404, not 403, on a
// mismatch -- deliberately indistinguishable from "draft doesn't exist"
// so a caller can't use the response to enumerate other users' draft
// ids (Derek's routing note; matches this app's existing not-found-vs-
// forbidden convention elsewhere, e.g. auth.ts never distinguishing
// "wrong password" from "no such user").
function isOwnDraftOrAdmin(meta: { ownerId: string }, user: { id: string; role: string }): boolean {
  return meta.ownerId === user.id || user.role === 'admin';
}

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
      draftId, zipFilename, createdAt, plan, ownerId: req.user!.id,
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
  if (!isValidDraftId(req.params.draftId)) { res.status(400).json({ error: 'Invalid draft id' }); return; }

  const meta = readDraftMeta(req.params.draftId);
  if (!meta || !isOwnDraftOrAdmin(meta, req.user!)) {
    res.status(404).json({ error: 'Draft not found or already expired' });
    return;
  }
  deleteDraftDir(req.params.draftId);
  res.status(204).end();
});

// ─── GET /import/zip/:draftId/file?path=... — draft content preview (#2176) ──
//
// Lets the wizard show the actual contents of a README/LICENSE/text file
// already sitting in the draft's extracted directory, instead of just the
// path hint — used to prefill the model description textarea from a
// zip's README. Same security posture as commit's per-path re-validation
// (C2, above), not a new pattern:
//   - draftId is regex-gated (isValidDraftId) before it ever reaches
//     draftDirFor/readDraftMeta, same as every other :draftId route.
//   - ownership is re-checked here independently (isOwnDraftOrAdmin),
//     never inherited from a prior request — 404, not 403, on a mismatch,
//     same not-found-vs-forbidden convention as every other draft route.
//   - the `path` query param is re-run through resolveContainedPath
//     (never trusted from the plan alone) before any read, exactly like
//     commit's per-file resolution.
//   - text files only: isPreviewableTextPath allowlists README/LICENSE/
//     .txt/.md by name — a caller cannot use this to read an arbitrary
//     3D model, image, or binary blob out of the draft even though it
//     sits in the same directory tree the caller does own.
//   - size-capped (MAX_PREVIEW_BYTES) so a maliciously huge file renamed
//     to .txt can't be read fully into memory just because its name
//     passes the allowlist.
const MAX_PREVIEW_BYTES = 256 * 1024; // 256 KiB — generous for a README/LICENSE, not for arbitrary content

router.get('/import/zip/:draftId/file', requireAuth, (req: Request, res: Response) => {
  const { draftId } = req.params;
  if (!isValidDraftId(draftId)) { res.status(400).json({ error: 'Invalid draft id' }); return; }

  const meta = readDraftMeta(draftId);
  if (!meta || !isOwnDraftOrAdmin(meta, req.user!)) {
    res.status(404).json({ error: 'Draft not found or expired' });
    return;
  }

  const rawPath = req.query.path;
  if (typeof rawPath !== 'string' || !rawPath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }

  if (!isPreviewableTextPath(rawPath)) {
    res.status(400).json({ error: 'Only README/LICENSE/text/markdown files can be previewed' });
    return;
  }

  const draftDir = draftDirFor(draftId);
  const absPath = resolveContainedPath(draftDir, rawPath);
  if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    res.status(404).json({ error: 'File not found in draft' });
    return;
  }

  const { size } = fs.statSync(absPath);
  if (size > MAX_PREVIEW_BYTES) {
    res.status(400).json({ error: `File exceeds the ${MAX_PREVIEW_BYTES}-byte preview limit` });
    return;
  }

  const content = fs.readFileSync(absPath, 'utf8');
  res.json({ path: rawPath, content });
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
  if (!isValidDraftId(draftId)) { res.status(400).json({ error: 'Invalid draft id' }); return; }

  const meta = readDraftMeta(draftId);
  if (!meta || !isOwnDraftOrAdmin(meta, req.user!)) {
    res.status(404).json({ error: 'Draft not found or expired' });
    return;
  }

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

  // ─── Create assets (hash-dedup + per-file outcome reporting) ────────────────
  //
  // assetIdByHash is scoped to THIS request only -- distinct from
  // findAssetByHash's DB-wide lookup -- so a SECOND selected path that
  // hashes identically to an EARLIER one in the same commit is
  // recognized without a redundant DB round-trip, and so its outcome can
  // be reported as 'merged-duplicate' rather than indistinguishable from
  // an ordinary 'created'/'linked-existing' (Remy's C3-consumer finding,
  // #2172 follow-up: the wizard is promised a dedup summary, including
  // when its own selection collapses two paths onto one asset). Whichever
  // path was processed first (submission order) is the one whose
  // role/label actually lands in model_files below -- INSERT OR IGNORE
  // keeps the first insert for a given (model_id, asset_id) pair, so a
  // 'merged-duplicate' entry's role/label is reported here but never
  // takes effect.
  const assetIdByPath = new Map<string, string>();
  const assetIdByHash = new Map<string, string>();
  const fileOutcomes: Array<{ path: string; assetId: string; outcome: 'created' | 'linked-existing' | 'merged-duplicate' }> = [];

  for (const f of resolvedFiles) {
    const buffer = fs.readFileSync(f.absPath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    let assetId: string;
    let outcome: 'created' | 'linked-existing' | 'merged-duplicate';

    const seenThisCommit = assetIdByHash.get(hash);
    if (seenThisCommit) {
      assetId = seenThisCommit;
      outcome = 'merged-duplicate';
    } else {
      const existing = findAssetByHash(db, hash);
      if (existing) {
        assetId = existing.id;
        outcome = 'linked-existing';
      } else {
        const originalName = path.posix.basename(f.path.replace(/\\/g, '/'));
        const filename = sanitizeFilename(originalName);
        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        assetId = uuidv4();
        // sourcePath deliberately left null: that column means
        // "reconciled against a live mount-scan location" (see db.ts's
        // comment on idx_assets_source) -- a zip's internal relative
        // path isn't a filesystem location that will ever be rescanned,
        // so it isn't that. This is closest to a plain upload, just
        // batched.
        // eslint-disable-next-line no-await-in-loop
        await saveUploadedFile(buffer, assetId, filename, mimeType, null, [], null, originalName);
        if (needsThumbnail(filename)) enqueueThumb(assetId);
        outcome = 'created';
      }
      assetIdByHash.set(hash, assetId);
    }

    assetIdByPath.set(f.path, assetId);
    fileOutcomes.push({ path: f.path, assetId, outcome });
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
  res.status(201).json({ model: detail, files: fileOutcomes });
}));

export default router;
