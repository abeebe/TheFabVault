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
// models/model_files, never touches folders or assets.

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

function modelToOut(db: Database.Database, row: ModelRow, fileCount: number): ModelOut {
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
function loadModelDetail(db: Database.Database, modelId: string): ModelDetailOut | undefined {
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
    ...modelToOut(db, row, files.length),
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

const MODEL_SORT_MAP: Record<string, string> = {
  date_desc: 'created_at DESC',
  date_asc: 'created_at ASC',
  name_asc: 'LOWER(title) ASC',
  name_desc: 'LOWER(title) DESC',
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
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const countRows = db.prepare(
      `SELECT mf.model_id, COUNT(*) as cnt FROM model_files mf
       JOIN assets a ON a.id = mf.asset_id
       WHERE mf.model_id IN (${placeholders}) AND a.deleted_at IS NULL
       GROUP BY mf.model_id`
    ).all(...rows.map((r) => r.id)) as { model_id: string; cnt: number }[];
    for (const c of countRows) counts.set(c.model_id, c.cnt);
  }

  res.json({ items: rows.map((r) => modelToOut(db, r, counts.get(r.id) ?? 0)), total });
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
  res.status(201).json(modelToOut(db, row, 0));
});

// ─── GET /model/:id — detail (files by role, profiles) ────────────────────────

router.get('/model/:id', requireAuth, (req: Request, res: Response) => {
  const detail = loadModelDetail(getDb(), req.params.id);
  if (!detail) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(detail);
});

// ─── PATCH /model/:id ───────────────────────────────────────────────────────────

router.patch('/model/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as ModelRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

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
  res.json(modelToOut(db, updated, fileCountFor(db, row.id)));
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
  const row = db.prepare('SELECT id FROM models WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

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

  const detail = loadModelDetail(db, modelId)!;
  res.status(201).json(detail);
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
  const model = db.prepare('SELECT id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!model) { res.status(404).json({ error: 'Not found' }); return; }

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

  const detail = loadModelDetail(db, model.id)!;
  res.status(201).json({ attached: attachedAssetIds.length, model: detail });
}));

// ─── DELETE /model/:id/file/:assetId — detach (never deletes the asset) ───────

router.delete('/model/:id/file/:assetId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id, cover_asset_id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as
    | { id: string; cover_asset_id: string | null } | undefined;
  if (!model) { res.status(404).json({ error: 'Not found' }); return; }

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
  const model = db.prepare('SELECT id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!model) { res.status(404).json({ error: 'Not found' }); return; }

  const { assetIds } = req.body as { assetIds?: string[] };
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    res.status(400).json({ error: 'assetIds must be a non-empty ordered array' });
    return;
  }

  const update = db.prepare('UPDATE model_files SET sort_order = ? WHERE model_id = ? AND asset_id = ?');
  db.transaction(() => {
    assetIds.forEach((aid, i) => update.run(i, model.id, aid));
  })();

  res.json(loadModelDetail(db, model.id));
});

// ─── PATCH /model/:id/cover ─────────────────────────────────────────────────────

router.patch('/model/:id/cover', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!model) { res.status(404).json({ error: 'Not found' }); return; }

  const { assetId } = req.body as { assetId?: string | null };
  if (assetId) {
    const linked = db.prepare('SELECT 1 FROM model_files WHERE model_id = ? AND asset_id = ?').get(model.id, assetId);
    if (!linked) { res.status(400).json({ error: 'Cover asset must be attached to the model' }); return; }
  }
  db.prepare('UPDATE models SET cover_asset_id = ?, updated_at = unixepoch() WHERE id = ?').run(assetId || null, model.id);

  res.json(loadModelDetail(db, model.id));
});

// ─── GET /model/:id/download — zip of role='part' files ──────────────────────
// Copies the archiver pattern from routes/assets.ts's GET
// /folder/:id/download (~line 634).

router.get('/model/:id/download', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT * FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as ModelRow | undefined;
  if (!model) { res.status(404).json({ error: 'Model not found' }); return; }

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

router.get('/model/:id/profiles', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!model) { res.status(404).json({ error: 'Not found' }); return; }
  const rows = db.prepare(
    'SELECT * FROM print_profiles WHERE model_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(model.id) as PrintProfileRow[];
  res.json(rows.map(profileToOut));
});

router.post('/model/:id/profiles', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const model = db.prepare('SELECT id FROM models WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!model) { res.status(404).json({ error: 'Not found' }); return; }

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
  const info = db.prepare('DELETE FROM print_profiles WHERE id = ?').run(req.params.id);
  if (info.changes === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).end();
});

export default router;
