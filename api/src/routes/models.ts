// Models — the "Local MakerWorld" restructure's model-centric core unit
// (#2155, Phase A of the plan; see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md).
//
// A model does not own file bytes. It references existing assets via the
// model_files join table (role: part/image/doc/other — see
// services/enumValidators.ts), same relationship shape as sets.ts's
// set_assets. Gallery images are just assets with role='image' riding
// the existing thumbnail pipeline for free.
//
// Deletion semantics (load-bearing, see plan + PR checklist): model
// soft-delete only hides the model; hard delete (?permanent=true)
// removes the model row and, via `ON DELETE CASCADE` on model_id,
// its model_files and print_profiles rows — it NEVER deletes an asset
// row. Every query below that lists linked files filters
// `a.deleted_at IS NULL` on the assets side so a trashed asset silently
// drops out of a model's file list instead of 404ing the whole model.
// from-folder conversion is purely additive: it only INSERTs into
// models/model_files, never touches folders or assets. Its preview
// counterpart (GET /models/from-folder/preview, #2170) goes one step
// further and writes nothing at all — see that handler's own comment.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import crypto from 'crypto';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import type Database from 'better-sqlite3';
import { requireAuth } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getDb } from '../db.js';
import { assetFilePath, thumbExists, sanitizeFilename } from '../services/fileStore.js';
import { enqueueThumb } from '../services/thumbGen.js';
import { saveUploadedFile, needsThumbnail, findAssetByHash } from '../services/assetUpload.js';
import { planFolderConversion } from '../services/modelConvert.js';
import {
  MODEL_FILE_ROLES, isModelFileRole, MODEL_VISIBILITY, isModelVisibility,
} from '../services/enumValidators.js';
import { isValidSourceUrl } from '../services/urlValidators.js';
import { visibilityFragment, isVisible, type VisibilityContext } from '../services/visibility.js';
import type {
  AssetOut, AssetRow, FolderRow,
  ModelRow, ModelOut, ModelDetailOut, ModelFileOut,
  PrintProfileRow, PrintProfileOut,
} from '../types/index.js';

const router = Router();

// Matches routes/assets.ts's /upload limit — a model-attach upload is
// the same kind of file a plain /upload accepts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// ─── Visibility / ownership helpers (Phase D3, #2179) ──────────────────────────
//
// Two distinct rules thread through this file, per the restructure plan's
// §8-D authz matrix — don't conflate them:
//
//   - READ (visibility): can this caller see the row at all? public rows
//     to everyone, private rows to their owner + admin. Governs list/
//     detail/download/like — every place a model that isn't yours but IS
//     public should still show up. Backed by services/visibility.ts.
//   - WRITE (ownership): can this caller mutate the row? owner + admin
//     only, regardless of visibility — a public model is still not
//     everyone's to edit. Governs PATCH/DELETE on the model itself, file
//     attach/detach/reorder/cover, and print_profiles CRUD (see that
//     section's own comment for why profiles get the stricter rule even
//     on their GET).
//
// Both deny with 404, never 403 — existence-hiding, same convention as
// modelImport.ts's isOwnDraftOrAdmin (C2 precedent): a caller can't tell
// "not yours" apart from "doesn't exist" from the response.
function visCtx(req: Request): VisibilityContext {
  return { userId: req.user!.id, isAdmin: req.user!.role === 'admin' };
}

function isOwnerOrAdmin(row: { owner_id: string | null }, req: Request): boolean {
  return row.owner_id === req.user!.id || req.user!.role === 'admin';
}

// ─── toOut helpers ─────────────────────────────────────────────────────────────

// Mirrors routes/assets.ts#toOut / routes/sets.ts's inline copy. Kept
// inline rather than imported — established convention at every other
// call site (sets.ts, manifestImport.ts) to avoid coupling routes
// together over a shape that's cheap to duplicate.
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

// Resolves the cover thumb URL: the explicit cover_asset_id if it has a
// usable thumbnail, else the first role='image' file (by sort_order),
// else null. Same fallback shape as routes/sets.ts#resolveCoverThumb.
function resolveCoverThumb(db: Database.Database, coverAssetId: string | null, modelId: string): string | null {
  if (coverAssetId) {
    const row = db.prepare('SELECT id, thumb_status FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(coverAssetId) as { id: string; thumb_status: string } | undefined;
    if (row && row.thumb_status === 'done' && thumbExists(row.id)) {
      return `/thumb/${row.id}.jpg`;
    }
  }
  const fallback = db.prepare(
    `SELECT a.id FROM model_files mf
     JOIN assets a ON a.id = mf.asset_id
     WHERE mf.model_id = ? AND mf.role = 'image' AND a.deleted_at IS NULL AND a.thumb_status = 'done'
     ORDER BY mf.sort_order ASC, a.created_at DESC
     LIMIT 1`
  ).get(modelId) as { id: string } | undefined;
  if (fallback && thumbExists(fallback.id)) return `/thumb/${fallback.id}.jpg`;
  return null;
}

// likeCount/likedByMe (migration v16, #2167) are required params, not
// re-queried inside modelToOut itself — every call site already has (or
// can cheaply batch) both, same rationale as fileCount already being a
// param here rather than computed inline.
function modelToOut(
  db: Database.Database, row: ModelRow, fileCount: number, likeCount: number, likedByMe: boolean,
): ModelOut {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    categoryId: row.category_id,
    tags: JSON.parse(row.tags_json || '[]'),
    ownerId: row.owner_id,
    visibility: row.visibility,
    coverAssetId: row.cover_asset_id,
    coverThumbUrl: resolveCoverThumb(db, row.cover_asset_id, row.id),
    sourceUrl: row.source_url,
    sourceSite: row.source_site,
    sourceAuthor: row.source_author,
    license: row.license,
    sourceFolderId: row.source_folder_id,
    fileCount,
    likeCount,
    likedByMe,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function fileCountFor(db: Database.Database, modelId: string): number {
  return (
    db.prepare(
      `SELECT COUNT(*) as cnt FROM model_files mf
       JOIN assets a ON a.id = mf.asset_id
       WHERE mf.model_id = ? AND a.deleted_at IS NULL`
    ).get(modelId) as { cnt: number }
  ).cnt;
}

function likeCountFor(db: Database.Database, modelId: string): number {
  return (
    db.prepare('SELECT COUNT(*) as cnt FROM model_likes WHERE model_id = ?').get(modelId) as { cnt: number }
  ).cnt;
}

function likedByUser(db: Database.Database, modelId: string, userId: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM model_likes WHERE model_id = ? AND user_id = ?').get(modelId, userId)
  );
}

function profileToOut(row: PrintProfileRow): PrintProfileOut {
  return {
    id: row.id,
    modelId: row.model_id,
    name: row.name,
    printer: row.printer,
    material: row.material,
    nozzle: row.nozzle,
    layerHeight: row.layer_height,
    infill: row.infill,
    supports: Boolean(row.supports),
    notes: row.notes,
    settings: JSON.parse(row.settings_json || '{}'),
    slicedAssetId: row.sliced_asset_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

// Shared by GET /model/:id, POST /models/from-folder, and the
// files/profile mutation endpoints below — one place builds the full
// detail payload so every mutation returns the same shape the detail GET
// does, instead of each handler assembling its own partial view.
//
// userId is required (every call site sits behind requireAuth) so
// likedByMe can be resolved — same reason modelToOut takes it as a
// param rather than computing it internally.
//
// Exported (#2172) so routes/modelImport.ts's commit endpoint can return
// the exact same detail shape a normal model create/fetch does, rather
// than a divergent partial payload — the only cross-file use so far, so
// this stays a plain named export rather than moving to its own service
// module.
export function loadModelDetail(db: Database.Database, modelId: string, userId: string): ModelDetailOut | undefined {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId) as ModelRow | undefined;
  if (!row) return undefined;

  const fileRows = db.prepare(
    `SELECT mf.asset_id, mf.role, mf.sort_order, mf.label, a.*
     FROM model_files mf
     JOIN assets a ON a.id = mf.asset_id
     WHERE mf.model_id = ? AND a.deleted_at IS NULL
     ORDER BY mf.role ASC, mf.sort_order ASC, a.created_at DESC`
  ).all(row.id) as Array<AssetRow & { asset_id: string; role: 'part' | 'image' | 'doc' | 'other'; sort_order: number; label: string | null }>;

  const files: ModelFileOut[] = fileRows.map((r) => ({
    assetId: r.asset_id,
    role: r.role,
    sortOrder: r.sort_order,
    label: r.label,
    asset: assetRowToOut(r),
  }));

  const profileRows = db.prepare(
    'SELECT * FROM print_profiles WHERE model_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(row.id) as PrintProfileRow[];

  return {
    ...modelToOut(db, row, files.length, likeCountFor(db, row.id), likedByUser(db, row.id, userId)),
    files,
    profiles: profileRows.map(profileToOut),
  };
}

// ─── GET /models — list, mirroring /assets' query shape ───────────────────────
//
// `category` here filters models.category_id (the curated categories
// tree, migration v15) — a direct FK match, unlike /assets' `category`
// param, which infers a computed 3dmodel/2d/uncategorized bucket from
// filename extension because assets have no real category table. Same
// param name, different underlying concept, because models actually
// have the table assets don't.

// sort=likes (migration v16, #2167): a correlated subquery in ORDER BY
// is the right tool here specifically because it's or­dering, not
// display — SQLite only has to evaluate it per row it's actually
// comparing during the sort, and there's no way to express "order by an
// aggregate over a different table" as a plain column-name entry in
// this map otherwise. Ties break by created_at DESC (newest first among
// equally-liked models), matching every other sort's implicit
// most-recent-first bias.
//
// This is deliberately a different mechanism than the batched-IN-query
// approach used for the like COUNTS returned in each list row below
// (see the `likeCounts` map) — that batch happens once per page
// regardless of row count, while this subquery only runs during the
// sort comparison itself. Reusing the batch map for ordering would mean
// materializing it before the LIMIT/OFFSET page is even known, i.e. for
// every model in the filtered set rather than just the page — worse for
// large libraries, which is exactly the case sorting matters for.
const MODEL_SORT_MAP: Record<string, string> = {
  date_desc: 'created_at DESC',
  date_asc: 'created_at ASC',
  name_asc: 'LOWER(title) ASC',
  name_desc: 'LOWER(title) DESC',
  likes: '(SELECT COUNT(*) FROM model_likes ml WHERE ml.model_id = models.id) DESC, created_at DESC',
};

router.get('/models', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const {
    q, category, tags: tagsParam, owner, sort = 'date_desc',
    limit = '100', offset = '0',
  } = req.query as Record<string, string>;

  const orderBy = MODEL_SORT_MAP[sort] ?? MODEL_SORT_MAP['date_desc'];

  let whereClause = ' WHERE deleted_at IS NULL';
  const whereParams: unknown[] = [];

  // Visibility filter (#2179): spliced into the SQL WHERE clause, not
  // applied as a post-query JS filter — the total/limit/offset below all
  // need to reflect the same filtered set, and a JS filter after LIMIT
  // would silently return fewer than `limit` visible rows on a page that
  // mixes visible and hidden models.
  const visFrag = visibilityFragment(visCtx(req));
  whereClause += ` AND (${visFrag.sql})`;
  whereParams.push(...visFrag.params);

  if (q) {
    whereClause += ' AND (title LIKE ? OR description LIKE ?)';
    const like = `%${q}%`;
    whereParams.push(like, like);
  }

  if (category) {
    whereClause += ' AND category_id = ?';
    whereParams.push(category);
  }

  // Only the literal 'me' is meaningful — no arbitrary-owner-id
  // filtering yet (that's not a query need this ticket has, and adding
  // it would be premature ahead of Phase B/D visibility rules).
  if (owner === 'me') {
    whereClause += ' AND owner_id = ?';
    whereParams.push(req.user!.id);
  }

  if (tagsParam) {
    const filterTags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
    for (const tag of filterTags) {
      whereClause += ' AND tags_json LIKE ?';
      whereParams.push(`%"${tag}"%`);
    }
  }

  const total = (db.prepare(`SELECT COUNT(*) as count FROM models${whereClause}`).get(...whereParams) as { count: number }).count;

  const sql = `SELECT * FROM models${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const params = [...whereParams, parseInt(limit, 10), parseInt(offset, 10)];
  const rows = db.prepare(sql).all(...params) as ModelRow[];

  // Batch file counts for the page rather than one query per row.
  const counts = new Map<string, number>();
  // Batch like counts + this user's liked set for the page, same
  // one-query-per-page shape as file counts just above — a subquery per
  // row (like the ORDER BY case does) would be N extra queries for a
  // page of N models purely to render a count that's already sitting in
  // model_likes; a single IN(...) GROUP BY does the whole page at once.
  const likeCounts = new Map<string, number>();
  const likedSet = new Set<string>();
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const countRows = db.prepare(
      `SELECT mf.model_id, COUNT(*) as cnt FROM model_files mf
       JOIN assets a ON a.id = mf.asset_id
       WHERE mf.model_id IN (${placeholders}) AND a.deleted_at IS NULL
       GROUP BY mf.model_id`
    ).all(...rows.map((r) => r.id)) as { model_id: string; cnt: number }[];
    for (const c of countRows) counts.set(c.model_id, c.cnt);

    const likeCountRows = db.prepare(
      `SELECT model_id, COUNT(*) as cnt FROM model_likes
       WHERE model_id IN (${placeholders})
       GROUP BY model_id`
    ).all(...rows.map((r) => r.id)) as { model_id: string; cnt: number }[];
    for (const c of likeCountRows) likeCounts.set(c.model_id, c.cnt);

    const likedRows = db.prepare(
      `SELECT model_id FROM model_likes WHERE user_id = ? AND model_id IN (${placeholders})`
    ).all(req.user!.id, ...rows.map((r) => r.id)) as { model_id: string }[];
    for (const l of likedRows) likedSet.add(l.model_id);
  }

  res.json({
    items: rows.map((r) => modelToOut(
      db, r, counts.get(r.id) ?? 0, likeCounts.get(r.id) ?? 0, likedSet.has(r.id),
    )),
    total,
  });
});

// ─── POST /models ──────────────────────────────────────────────────────────────

router.post('/models', requireAuth, (req: Request, res: Response) => {
  const {
    title, description, categoryId, tags, visibility,
    sourceUrl, sourceSite, sourceAuthor, license,
  } = req.body as {
    title?: string;
    description?: string;
    categoryId?: string | null;
    tags?: string[];
    visibility?: string;
    sourceUrl?: string;
    sourceSite?: string;
    sourceAuthor?: string;
    license?: string;
  };

  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }

  const vis = visibility ?? 'public';
  if (!isModelVisibility(vis)) {
    res.status(400).json({ error: `visibility must be one of: ${MODEL_VISIBILITY.join(', ')}` });
    return;
  }

  const db = getDb();

  if (categoryId) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!cat) { res.status(400).json({ error: 'Category not found' }); return; }
  }

  if (tags !== undefined && !Array.isArray(tags)) {
    res.status(400).json({ error: 'tags must be an array' });
    return;
  }

  if (!isValidSourceUrl(sourceUrl)) {
    res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL' });
    return;
  }

  const id = uuidv4();
  // owner_id is set from req.user, never trusted from the request body —
  // this route sits behind requireAuth so req.user is always populated.
  // No visibility filtering is applied on read yet (Phase B); the column
  // is stored now purely so it never needs a second migration later.
  db.prepare(
    `INSERT INTO models (id, title, description, category_id, tags_json, owner_id, visibility, source_url, source_site, source_author, license)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, title.trim(), description?.trim() || null, categoryId || null,
    JSON.stringify(tags ?? []), req.user!.id, vis,
    sourceUrl?.trim() || null, sourceSite?.trim() || null, sourceAuthor?.trim() || null, license?.trim() || null,
  );

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow;
  res.status(201).json(modelToOut(db, row, 0, 0, false));
});

// ─── GET /model/:id — detail (files by role, profiles) ────────────────────────

router.get('/model/:id', requireAuth, (req: Request, res: Response) => {
  const detail = loadModelDetail(getDb(), req.params.id, req.user!.id);
  if (!detail || !isVisible({ visibility: detail.visibility, owner_id: detail.ownerId }, visCtx(req))) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(detail);
});

// ─── PATCH /model/:id ───────────────────────────────────────────────────────────

router.patch('/model/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as ModelRow | undefined;
  if (!row || !isOwnerOrAdmin(row, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const {
    title, description, categoryId, tags, visibility,
    sourceUrl, sourceSite, sourceAuthor, license,
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
  };

  if (title !== undefined) {
    if (!title.trim()) { res.status(400).json({ error: 'title cannot be empty' }); return; }
    db.prepare('UPDATE models SET title = ?, updated_at = unixepoch() WHERE id = ?').run(title.trim(), row.id);
  }
  if (description !== undefined) {
    db.prepare('UPDATE models SET description = ?, updated_at = unixepoch() WHERE id = ?').run(description?.trim() || null, row.id);
  }
  if (categoryId !== undefined) {
    if (categoryId) {
      const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
      if (!cat) { res.status(400).json({ error: 'Category not found' }); return; }
    }
    db.prepare('UPDATE models SET category_id = ?, updated_at = unixepoch() WHERE id = ?').run(categoryId || null, row.id);
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) { res.status(400).json({ error: 'tags must be an array' }); return; }
    db.prepare('UPDATE models SET tags_json = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(tags), row.id);
  }
  if (visibility !== undefined) {
    if (!isModelVisibility(visibility)) {
      res.status(400).json({ error: `visibility must be one of: ${MODEL_VISIBILITY.join(', ')}` });
      return;
    }
    db.prepare('UPDATE models SET visibility = ?, updated_at = unixepoch() WHERE id = ?').run(visibility, row.id);
  }
  if (sourceUrl !== undefined) {
    if (!isValidSourceUrl(sourceUrl)) {
      res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL' });
      return;
    }
    db.prepare('UPDATE models SET source_url = ?, updated_at = unixepoch() WHERE id = ?').run(sourceUrl?.trim() || null, row.id);
  }
  if (sourceSite !== undefined) {
    db.prepare('UPDATE models SET source_site = ?, updated_at = unixepoch() WHERE id = ?').run(sourceSite?.trim() || null, row.id);
  }
  if (sourceAuthor !== undefined) {
    db.prepare('UPDATE models SET source_author = ?, updated_at = unixepoch() WHERE id = ?').run(sourceAuthor?.trim() || null, row.id);
  }
  if (license !== undefined) {
    db.prepare('UPDATE models SET license = ?, updated_at = unixepoch() WHERE id = ?').run(license?.trim() || null, row.id);
  }

  const updated = db.prepare('SELECT * FROM models WHERE id = ?').get(row.id) as ModelRow;
  res.json(modelToOut(db, updated, fileCountFor(db, row.id), likeCountFor(db, row.id), likedByUser(db, row.id, req.user!.id)));
});

// ─── DELETE /model/:id — soft by default, ?permanent=true hard ────────────────
//
// Hard delete removes the models row only. model_files and
// print_profiles cascade off model_id (`ON DELETE CASCADE`, foreign_keys
// pragma is ON — see db.ts getDb()) — neither of those tables' rows
// reference an asset in a way that cascades onto assets itself, so this
// path can never delete an asset row. PR checklist: confirmed no path
// here (or anywhere in this file) issues `DELETE FROM assets`.

router.delete('/model/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id, owner_id FROM models WHERE id = ?').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!row || !isOwnerOrAdmin(row, req)) { res.status(404).json({ error: 'Not found' }); return; }

  if (req.query.permanent === 'true') {
    db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
  } else {
    db.prepare('UPDATE models SET deleted_at = unixepoch() WHERE id = ?').run(row.id);
  }
  res.json({ ok: true });
});

// ─── POST /models/from-folder — explicit folder→model conversion ─────────────
//
// Purely additive: only INSERTs a new models row + model_files rows.
// Never writes to folders or assets — the folder and its assets are
// left exactly as they were (plan §Key design decisions #7, "never
// silent auto-conversion" — this endpoint IS the explicit user action).

router.post('/models/from-folder', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { folderId, title } = req.body as { folderId?: string; title?: string };
  if (!folderId) { res.status(400).json({ error: 'folderId is required' }); return; }

  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const assetRows = db.prepare(
    'SELECT * FROM assets WHERE folder_id = ? AND deleted_at IS NULL ORDER BY filename ASC'
  ).all(folderId) as AssetRow[];

  if (assetRows.length === 0) { res.status(400).json({ error: 'Folder has no assets to convert' }); return; }

  const plan = planFolderConversion(
    assetRows.map((a) => ({ assetId: a.id, filename: a.filename, thumbStatus: a.thumb_status }))
  );

  const modelId = uuidv4();
  const modelTitle = title?.trim() || folder.name;

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO models (id, title, owner_id, source_folder_id, cover_asset_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(modelId, modelTitle, req.user!.id, folderId, plan.coverAssetId);

    const insertFile = db.prepare(
      'INSERT INTO model_files (model_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)'
    );
    for (const f of plan.files) insertFile.run(modelId, f.assetId, f.role, f.sortOrder);
  });
  create();

  const detail = loadModelDetail(db, modelId, req.user!.id)!;
  res.status(201).json(detail);
}));

// ─── GET /models/from-folder/preview — dry-run classification, no writes ──────
//
// Bulk convert wizard (#2170) needs to show what conversion WOULD produce
// before the user confirms, per-folder, without ever creating a model
// just to preview it. This calls the exact same planFolderConversion()
// pure function as the POST above and returns its plan directly — no
// INSERT anywhere, no transaction, nothing under this handler touches
// the models or model_files tables. (Verified by the paired test: asserts
// row counts on both tables are identical before and after the call.)
//
// Deliberately does NOT 400 on a folder with zero assets the way the real
// POST does — "nothing to convert" is itself a useful preview result for
// an admin browsing many folders (assetCount: 0, empty files/counts), and
// the wizard uses that to grey out the folder's checkbox rather than
// making the user click in to discover the same 400 the POST would give.
//
// Query param is snake_case `folder_id`, matching every other list
// endpoint's folder filter (AssetListParams.folder_id) — not the camelCase
// `folderId` the POST body above uses. Deliberate: this is a query string
// (GET), that's a JSON body (POST), and the rest of this file already
// uses different casing conventions for the two surfaces (route params/
// query strings stay snake_case or plain; JSON bodies are camelCase).
router.get('/models/from-folder/preview', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { folder_id: folderId } = req.query as { folder_id?: string };
  if (!folderId) { res.status(400).json({ error: 'folder_id is required' }); return; }

  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const assetRows = db.prepare(
    'SELECT * FROM assets WHERE folder_id = ? AND deleted_at IS NULL ORDER BY filename ASC'
  ).all(folderId) as AssetRow[];

  const plan = planFolderConversion(
    assetRows.map((a) => ({ assetId: a.id, filename: a.filename, thumbStatus: a.thumb_status }))
  );

  const assetsById = new Map(assetRows.map((a) => [a.id, a]));
  const countsByRole: Record<'part' | 'image' | 'doc' | 'other', number> = {
    part: 0, image: 0, doc: 0, other: 0,
  };
  const files = plan.files.map((f) => {
    countsByRole[f.role] += 1;
    return {
      assetId: f.assetId,
      filename: assetsById.get(f.assetId)!.filename,
      role: f.role,
      sortOrder: f.sortOrder,
    };
  });

  // Already-converted marker: any non-deleted model whose source_folder_id
  // points at this folder. A folder can only be walked into a model via
  // this same explicit action, and there's deliberately no uniqueness
  // constraint stopping a second from-folder conversion of the same
  // folder (a wizard re-check is the explicit override), so this can
  // legitimately be more than one.
  const existing = db.prepare(
    'SELECT id FROM models WHERE source_folder_id = ? AND deleted_at IS NULL'
  ).all(folderId) as Array<{ id: string }>;

  res.json({
    folderId,
    folderName: folder.name,
    suggestedTitle: folder.name,
    assetCount: assetRows.length,
    countsByRole,
    files,
    coverAssetId: plan.coverAssetId,
    alreadyConverted: existing.length > 0,
    existingModelIds: existing.map((m) => m.id),
  });
}));

// ─── POST /model/:id/files — attach existing asset ids OR multipart upload ────
//
// One endpoint, two input shapes: a JSON body with `assetIds` links
// files already in the vault; a multipart body with `files` uploads new
// bytes via the same saveUploadedFile mechanics as POST /upload. Multer
// no-ops on a non-multipart request (checks Content-Type internally), so
// wiring `upload.array('files')` unconditionally is safe for the
// JSON-body path.
//
// Upload path checks findAssetByHash first — dedup for free, same as
// POST /check-hash / the folder-import batch endpoint: a byte-identical
// file already in the vault gets linked, not re-stored as a second copy.

router.post('/model/:id/files', requireAuth, upload.array('files'), asyncHandler(async (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!model || !isOwnerOrAdmin(model, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const roleBody = (req.body.role as string | undefined) ?? 'part';
  if (!isModelFileRole(roleBody)) {
    res.status(400).json({ error: `role must be one of: ${MODEL_FILE_ROLES.join(', ')}` });
    return;
  }

  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM model_files WHERE model_id = ?').get(model.id) as { m: number }).m;
  let nextSort = maxSort + 1;
  const attach = db.prepare(
    'INSERT OR IGNORE INTO model_files (model_id, asset_id, role, sort_order, label) VALUES (?, ?, ?, ?, NULL)'
  );

  const attachedAssetIds: string[] = [];
  const files = req.files as Express.Multer.File[] | undefined;

  if (files?.length) {
    for (const file of files) {
      const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const existing = findAssetByHash(db, hash);
      let assetId: string;
      if (existing) {
        assetId = existing.id;
      } else {
        const originalName = file.originalname || 'upload';
        const filename = sanitizeFilename(originalName);
        const mimeType = file.mimetype || mime.lookup(filename) || 'application/octet-stream';
        assetId = uuidv4();
        // eslint-disable-next-line no-await-in-loop
        await saveUploadedFile(file.buffer, assetId, filename, mimeType, null, [], null, originalName);
        if (needsThumbnail(filename)) enqueueThumb(assetId);
      }
      attach.run(model.id, assetId, roleBody, nextSort);
      nextSort += 1;
      attachedAssetIds.push(assetId);
    }
  } else {
    const { assetIds } = req.body as { assetIds?: string[] };
    if (!assetIds?.length) {
      res.status(400).json({ error: 'Provide files (multipart) or assetIds (JSON body)' });
      return;
    }
    const validId = db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL');
    for (const aid of assetIds) {
      if (validId.get(aid)) {
        attach.run(model.id, aid, roleBody, nextSort);
        nextSort += 1;
        attachedAssetIds.push(aid);
      }
    }
  }

  const detail = loadModelDetail(db, model.id, req.user!.id)!;
  res.status(201).json({ attached: attachedAssetIds.length, model: detail });
}));

// ─── DELETE /model/:id/file/:assetId — detach (never deletes the asset) ───────

router.delete('/model/:id/file/:assetId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id, cover_asset_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    | { id: string; owner_id: string | null; cover_asset_id: string | null } | undefined;
  if (!model || !isOwnerOrAdmin(model, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const r = db.prepare('DELETE FROM model_files WHERE model_id = ? AND asset_id = ?').run(model.id, req.params.assetId);
  if (r.changes === 0) { res.status(404).json({ error: 'File not attached to this model' }); return; }

  // Never leave cover_asset_id pointing at a file no longer linked.
  if (model.cover_asset_id === req.params.assetId) {
    db.prepare('UPDATE models SET cover_asset_id = NULL WHERE id = ?').run(model.id);
  }

  res.status(204).end();
});

// ─── PATCH /model/:id/files/reorder ────────────────────────────────────────────
// Body: { assetIds: string[] } — the full desired order for this
// model's linked files; sort_order is assigned as each id's array index.

router.patch('/model/:id/files/reorder', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!model || !isOwnerOrAdmin(model, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const { assetIds } = req.body as { assetIds?: string[] };
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    res.status(400).json({ error: 'assetIds must be a non-empty ordered array' });
    return;
  }

  const update = db.prepare('UPDATE model_files SET sort_order = ? WHERE model_id = ? AND asset_id = ?');
  db.transaction(() => {
    assetIds.forEach((aid, i) => update.run(i, model.id, aid));
  })();

  res.json(loadModelDetail(db, model.id, req.user!.id));
});

// ─── PATCH /model/:id/cover ─────────────────────────────────────────────────────

router.patch('/model/:id/cover', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!model || !isOwnerOrAdmin(model, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const { assetId } = req.body as { assetId?: string | null };
  if (assetId) {
    const linked = db.prepare('SELECT 1 FROM model_files WHERE model_id = ? AND asset_id = ?').get(model.id, assetId);
    if (!linked) { res.status(400).json({ error: 'Cover asset must be attached to the model' }); return; }
  }
  db.prepare('UPDATE models SET cover_asset_id = ?, updated_at = unixepoch() WHERE id = ?').run(assetId || null, model.id);

  res.json(loadModelDetail(db, model.id, req.user!.id));
});

// ─── GET /model/:id/download — zip of role='part' files ──────────────────────
// Copies the archiver pattern from routes/assets.ts's GET
// /folder/:id/download (~line 634).

router.get('/model/:id/download', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as ModelRow | undefined;
  if (!model || !isVisible(model, visCtx(req))) { res.status(404).json({ error: 'Model not found' }); return; }

  const parts = db.prepare(
    `SELECT a.* FROM model_files mf
     JOIN assets a ON a.id = mf.asset_id
     WHERE mf.model_id = ? AND mf.role = 'part' AND a.deleted_at IS NULL
     ORDER BY mf.sort_order ASC`
  ).all(model.id) as AssetRow[];

  const zipName = `${model.title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50) || 'model'}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => { console.error('[model-zip]', err); res.end(); });
  archive.pipe(res);

  for (const asset of parts) {
    const filePath = assetFilePath(asset.id, asset.filename);
    if (fs.existsSync(filePath)) archive.file(filePath, { name: asset.filename });
  }

  archive.finalize();
});

// ─── print_profiles CRUD ───────────────────────────────────────────────────────
//
// Deliberately gated on the OWNERSHIP (write) rule, not visibility, for
// all four operations — including this section's GET, unlike every other
// GET in this file. Print profiles are per-owner printer configuration
// (nozzle/layer-height/infill/slicer settings), not gallery content;
// unlike files/likes, there's no product reason a non-owner browsing a
// public model needs its owner's slicer settings. This is narrower than
// GET /model/:id itself: that detail payload still embeds `profiles`
// for a public model (loadModelDetail doesn't filter them out — this
// ticket didn't ask for that split), so a non-owner viewing a public
// model's detail sees its profiles embedded but cannot hit this
// standalone list endpoint directly. Stated explicitly per the ticket's
// "decide + state the choice" instruction — see #2179 report.
router.get('/model/:id/profiles', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!model || !isOwnerOrAdmin(model, req)) { res.status(404).json({ error: 'Not found' }); return; }
  const rows = db.prepare(
    'SELECT * FROM print_profiles WHERE model_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(model.id) as PrintProfileRow[];
  res.json(rows.map(profileToOut));
});

router.post('/model/:id/profiles', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!model || !isOwnerOrAdmin(model, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const {
    name, printer, material, nozzle, layerHeight, infill, supports, notes, settings, slicedAssetId,
  } = req.body as {
    name?: string;
    printer?: string;
    material?: string;
    nozzle?: string;
    layerHeight?: number;
    infill?: number;
    supports?: boolean;
    notes?: string;
    settings?: Record<string, unknown>;
    slicedAssetId?: string | null;
  };

  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  if (slicedAssetId) {
    const ok = db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL').get(slicedAssetId);
    if (!ok) { res.status(400).json({ error: 'Sliced asset not found' }); return; }
  }

  const id = uuidv4();
  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM print_profiles WHERE model_id = ?').get(model.id) as { m: number }).m;

  db.prepare(
    `INSERT INTO print_profiles (id, model_id, name, printer, material, nozzle, layer_height, infill, supports, notes, settings_json, sliced_asset_id, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, model.id, name.trim(), printer?.trim() || null, material?.trim() || null, nozzle?.trim() || null,
    layerHeight ?? null, infill ?? null, supports ? 1 : 0, notes?.trim() || null,
    JSON.stringify(settings ?? {}), slicedAssetId || null, maxSort + 1,
  );

  const row = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(id) as PrintProfileRow;
  res.status(201).json(profileToOut(row));
});

router.patch('/profile/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(req.params.id) as PrintProfileRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  // Ownership lives on the PARENT model — print_profiles itself has no
  // owner_id column (it's a child row, same shape as model_files).
  const parent = db.prepare('SELECT owner_id FROM models WHERE id = ?').get(row.model_id) as { owner_id: string | null } | undefined;
  if (!parent || !isOwnerOrAdmin(parent, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const body = req.body as Partial<{
    name: string;
    printer: string | null;
    material: string | null;
    nozzle: string | null;
    layerHeight: number | null;
    infill: number | null;
    supports: boolean;
    notes: string | null;
    settings: Record<string, unknown>;
    slicedAssetId: string | null;
    sortOrder: number;
  }>;

  if (body.name !== undefined && !body.name.trim()) {
    res.status(400).json({ error: 'name cannot be empty' });
    return;
  }
  if (body.slicedAssetId) {
    const ok = db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL').get(body.slicedAssetId);
    if (!ok) { res.status(400).json({ error: 'Sliced asset not found' }); return; }
  }

  db.prepare(
    `UPDATE print_profiles SET
       name = ?, printer = ?, material = ?, nozzle = ?, layer_height = ?, infill = ?,
       supports = ?, notes = ?, settings_json = ?, sliced_asset_id = ?, sort_order = ?
     WHERE id = ?`
  ).run(
    body.name !== undefined ? body.name.trim() : row.name,
    body.printer !== undefined ? (body.printer?.trim() || null) : row.printer,
    body.material !== undefined ? (body.material?.trim() || null) : row.material,
    body.nozzle !== undefined ? (body.nozzle?.trim() || null) : row.nozzle,
    body.layerHeight !== undefined ? body.layerHeight : row.layer_height,
    body.infill !== undefined ? body.infill : row.infill,
    body.supports !== undefined ? (body.supports ? 1 : 0) : row.supports,
    body.notes !== undefined ? (body.notes?.trim() || null) : row.notes,
    body.settings !== undefined ? JSON.stringify(body.settings) : row.settings_json,
    body.slicedAssetId !== undefined ? (body.slicedAssetId || null) : row.sliced_asset_id,
    body.sortOrder !== undefined ? body.sortOrder : row.sort_order,
    row.id,
  );

  const updated = db.prepare('SELECT * FROM print_profiles WHERE id = ?').get(row.id) as PrintProfileRow;
  res.json(profileToOut(updated));
});

router.delete('/profile/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT model_id FROM print_profiles WHERE id = ?').get(req.params.id) as { model_id: string } | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const parent = db.prepare('SELECT owner_id FROM models WHERE id = ?').get(row.model_id) as { owner_id: string | null } | undefined;
  if (!parent || !isOwnerOrAdmin(parent, req)) { res.status(404).json({ error: 'Not found' }); return; }

  db.prepare('DELETE FROM print_profiles WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ─── PUT/DELETE /model/:id/like — like/unlike (migration v16, #2167) ──────────
//
// Idempotent by construction via the model_likes PK (model_id, user_id):
// PUT uses INSERT OR IGNORE (already-liked is a no-op, not a 409/error),
// DELETE just deletes whatever row is there (not-liked is a no-op, not a
// 404) — a client can PUT/DELETE the same like state repeatedly without
// checking first, same idempotency contract as models.ts elsewhere
// (attach uses INSERT OR IGNORE too). Both return the same small shape
// rather than a full model/detail payload — liking is a lightweight,
// frequent action and the caller (a like button) only ever needs the
// resulting count + its own state back, not the whole model re-fetched.
//
// Gated on VISIBILITY (read), not ownership (#2179) — the whole point of
// a like is another user liking YOUR public model, so owner-or-admin
// would be wrong here. A model you can't see (private, not yours) 404s;
// a public model anyone can like/unlike regardless of who owns it.
// likeCountFor stays a plain COUNT(*) — it already never reveals WHO
// liked a model, only how many did, so nothing else needed changing
// here for the "must not leak" side of the ticket.

router.put('/model/:id/like', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id, visibility FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null; visibility: string } | undefined;
  if (!model || !isVisible(model, visCtx(req))) { res.status(404).json({ error: 'Not found' }); return; }

  db.prepare('INSERT OR IGNORE INTO model_likes (model_id, user_id) VALUES (?, ?)').run(model.id, req.user!.id);

  res.json({ likeCount: likeCountFor(db, model.id), likedByMe: true });
});

router.delete('/model/:id/like', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, owner_id, visibility FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    { id: string; owner_id: string | null; visibility: string } | undefined;
  if (!model || !isVisible(model, visCtx(req))) { res.status(404).json({ error: 'Not found' }); return; }

  db.prepare('DELETE FROM model_likes WHERE model_id = ? AND user_id = ?').run(model.id, req.user!.id);

  res.json({ likeCount: likeCountFor(db, model.id), likedByMe: false });
});

export default router;
