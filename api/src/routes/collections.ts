// Collections — the model-level analog of sets.ts's asset grouping
// (v11), for the "Local MakerWorld" restructure's Phase B (#2167). See
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md.
//
// A collection is: name, optional description, optional cover model,
// owner, visibility, and a membership list of models (collection_models,
// migration v16). A model can belong to many collections. Same
// relationship shape as sets/set_assets, but for models instead of
// assets, and — like models themselves (v15) — carrying owner_id and a
// visibility column that is stored now but not yet enforced on read
// (that's Phase D3, once services/visibility.ts gets threaded in here
// and into routes/models.ts).
//
// Deletion semantics (judgment call, stated per the routing brief for
// #2167): DELETE /collection/:id is a plain, unconditional delete — no
// guard. collection_models cascades off collection_id (`ON DELETE
// CASCADE`), so deleting a collection removes the collection row and
// its membership links only; it never touches models or model_files or
// assets rows (those are owned elsewhere and untouched by design, same
// invariant models.ts's own delete path documents). There's no
// meaningful "in-use" state a collection can be in that would justify a
// confirmation guard the way categories.ts's parent/child guard does —
// a collection with models in it is just... a collection with models in
// it, deleting it doesn't orphan anything the way reparenting a
// category subtree would.

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import { thumbExists } from '../services/fileStore.js';
import { MODEL_VISIBILITY, isModelVisibility } from '../services/enumValidators.js';
import { visibilityFragment, isVisible, type VisibilityContext } from '../services/visibility.js';
import type {
  CollectionRow, CollectionOut, CollectionDetailOut,
  ModelRow, ModelOut,
} from '../types/index.js';

const router = Router();

// ─── Visibility / ownership helpers (Phase D3, #2179) ──────────────────────────
// Same split as routes/models.ts's identical helpers — see that file's
// comment for the read-vs-write rationale. Duplicated rather than
// imported across route files, matching this codebase's established
// convention (see models.ts's own toOut-helpers comment on why).
function visCtx(req: Request): VisibilityContext {
  return { userId: req.user!.id, isAdmin: req.user!.role === 'admin' };
}

function isOwnerOrAdmin(row: { owner_id: string | null }, req: Request): boolean {
  return row.owner_id === req.user!.id || req.user!.role === 'admin';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Mirrors routes/models.ts#modelToOut's cover-thumb resolution, but
// takes fileCount/likeCount/likedByMe as params rather than recomputing
// them — this file always has them in hand already (either batched for
// a list, or freshly queried for a detail/mutation response).
function resolveModelCoverThumb(coverAssetId: string | null, modelId: string): string | null {
  const db = getDb();
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

function modelRowToOut(db: ReturnType<typeof getDb>, row: ModelRow, userId: string): ModelOut {
  const fileCount = (
    db.prepare(
      `SELECT COUNT(*) as cnt FROM model_files mf
       JOIN assets a ON a.id = mf.asset_id
       WHERE mf.model_id = ? AND a.deleted_at IS NULL`
    ).get(row.id) as { cnt: number }
  ).cnt;
  const likeCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM model_likes WHERE model_id = ?').get(row.id) as { cnt: number }
  ).cnt;
  const likedByMe = Boolean(
    db.prepare('SELECT 1 FROM model_likes WHERE model_id = ? AND user_id = ?').get(row.id, userId)
  );
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    categoryId: row.category_id,
    tags: JSON.parse(row.tags_json || '[]'),
    ownerId: row.owner_id,
    visibility: row.visibility,
    coverAssetId: row.cover_asset_id,
    coverThumbUrl: resolveModelCoverThumb(row.cover_asset_id, row.id),
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

// Resolves a collection's cover thumb: the explicit cover_model_id's own
// coverThumbUrl if it resolves to one, else the first member model
// (by sort_order) that has a usable one, else null. Same fallback shape
// as models.ts#resolveCoverThumb / sets.ts#resolveCoverThumb.
function resolveCollectionCoverThumb(coverModelId: string | null, collectionId: string): string | null {
  const db = getDb();
  if (coverModelId) {
    const row = db.prepare('SELECT id, cover_asset_id FROM models WHERE id = ? AND deleted_at IS NULL')
      .get(coverModelId) as { id: string; cover_asset_id: string | null } | undefined;
    if (row) {
      const thumb = resolveModelCoverThumb(row.cover_asset_id, row.id);
      if (thumb) return thumb;
    }
  }
  const memberRows = db.prepare(
    `SELECT m.id, m.cover_asset_id FROM collection_models cm
     JOIN models m ON m.id = cm.model_id
     WHERE cm.collection_id = ? AND m.deleted_at IS NULL
     ORDER BY cm.sort_order ASC, cm.added_at DESC`
  ).all(collectionId) as Array<{ id: string; cover_asset_id: string | null }>;
  for (const m of memberRows) {
    const thumb = resolveModelCoverThumb(m.cover_asset_id, m.id);
    if (thumb) return thumb;
  }
  return null;
}

function collectionToOut(row: CollectionRow, modelCount: number): CollectionOut {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.owner_id,
    visibility: row.visibility,
    coverModelId: row.cover_model_id,
    coverThumbUrl: resolveCollectionCoverThumb(row.cover_model_id, row.id),
    modelCount,
    createdAt: row.created_at,
  };
}

function modelCountFor(db: ReturnType<typeof getDb>, collectionId: string): number {
  return (
    db.prepare(
      `SELECT COUNT(*) as cnt FROM collection_models cm
       JOIN models m ON m.id = cm.model_id
       WHERE cm.collection_id = ? AND m.deleted_at IS NULL`
    ).get(collectionId) as { cnt: number }
  ).cnt;
}

// ─── GET /collections ─────────────────────────────────────────────────────────
//
// Visibility filtering (#2179): both queries below apply the same
// visibilityFragment, called once per query rather than once and reused
// as a single object — each query binds its own params in its own
// positional order, so a fresh SqlFragment per call site keeps the two
// independent instead of one query's param list silently drifting if
// either query's shape changes later. Two DIFFERENT tables get the rule
// applied: the top-level `collections` row itself (is this collection
// visible to the caller at all), and separately the joined `models` row
// per membership (is this MEMBER model visible to the caller) — a
// visible public collection can still contain another owner's private
// model, which must not inflate this caller's modelCount (see
// GET /collection/:id below for the fuller rationale on that call).

router.get('/collections', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const ctx = visCtx(req);

  const collectionFrag = visibilityFragment(ctx);
  const rows = db.prepare(
    `SELECT * FROM collections WHERE ${collectionFrag.sql} ORDER BY name COLLATE NOCASE ASC`
  ).all(...collectionFrag.params) as CollectionRow[];

  const modelFrag = visibilityFragment(ctx);
  const counts = db.prepare(
    `SELECT cm.collection_id, COUNT(*) AS cnt
     FROM collection_models cm
     JOIN models m ON m.id = cm.model_id
     WHERE m.deleted_at IS NULL AND (${modelFrag.sql})
     GROUP BY cm.collection_id`
  ).all(...modelFrag.params) as { collection_id: string; cnt: number }[];
  const countMap = new Map(counts.map((c) => [c.collection_id, c.cnt]));
  res.json(rows.map((r) => collectionToOut(r, countMap.get(r.id) ?? 0)));
});

// ─── POST /collections ────────────────────────────────────────────────────────

router.post('/collections', requireAuth, (req: Request, res: Response) => {
  const { name, description, visibility, modelIds } = req.body as {
    name?: string;
    description?: string;
    visibility?: string;
    modelIds?: string[];
  };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const vis = visibility ?? 'public';
  if (!isModelVisibility(vis)) {
    res.status(400).json({ error: `visibility must be one of: ${MODEL_VISIBILITY.join(', ')}` });
    return;
  }

  const db = getDb();
  const id = uuidv4();
  // owner_id is set from req.user, never trusted from the request body
  // — same convention as POST /models.
  db.prepare('INSERT INTO collections (id, name, description, owner_id, visibility) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim(), description?.trim() || null, req.user!.id, vis);

  if (modelIds?.length) {
    const insertMember = db.prepare(
      `INSERT OR IGNORE INTO collection_models (collection_id, model_id, sort_order)
       VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collection_models WHERE collection_id = ?))`
    );
    const validId = db.prepare('SELECT 1 FROM models WHERE id = ? AND deleted_at IS NULL');
    db.transaction(() => {
      for (const mid of modelIds) {
        if (validId.get(mid)) insertMember.run(id, mid, id);
      }
    })();
  }

  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow;
  res.status(201).json(collectionToOut(row, modelCountFor(db, id)));
});

// ─── GET /collection/:id ───────────────────────────────────────────────────────

// Private-model-in-a-public-collection decision (#2179, per routing
// brief default): FILTER the row out of a non-owner's view rather than
// include it with a redacted/placeholder title. A member model this
// caller can't see (private, not theirs, caller not admin) simply
// doesn't appear in `models` below, and `modelCount` on the returned
// detail reflects that filtered length — so the same collection can
// legitimately report a different modelCount to different viewers (the
// owner/admin sees the true total, everyone else sees only what's
// visible to them). This is the same choice GET /collections' list-view
// modelCount above already makes for consistency between list and
// detail. Accepted trade-off, stated explicitly per the ticket.
router.get('/collection/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const ctx = visCtx(req);
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id) as CollectionRow | undefined;
  if (!row || !isVisible(row, ctx)) { res.status(404).json({ error: 'Not found' }); return; }

  const modelFrag = visibilityFragment(ctx);
  const modelRows = db.prepare(
    `SELECT m.* FROM collection_models cm
     JOIN models m ON m.id = cm.model_id
     WHERE cm.collection_id = ? AND m.deleted_at IS NULL AND (${modelFrag.sql})
     ORDER BY cm.sort_order ASC, cm.added_at DESC`
  ).all(row.id, ...modelFrag.params) as ModelRow[];

  const models = modelRows.map((m) => modelRowToOut(db, m, req.user!.id));
  const detail: CollectionDetailOut = {
    ...collectionToOut(row, models.length),
    models,
  };
  res.json(detail);
});

// ─── PATCH /collection/:id ──────────────────────────────────────────────────────

router.patch('/collection/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id) as CollectionRow | undefined;
  if (!row || !isOwnerOrAdmin(row, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, description, visibility } = req.body as {
    name?: string;
    description?: string | null;
    visibility?: string;
  };

  if (name !== undefined) {
    if (!name.trim()) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name.trim(), row.id);
  }
  if (description !== undefined) {
    db.prepare('UPDATE collections SET description = ? WHERE id = ?').run(description?.trim() || null, row.id);
  }
  if (visibility !== undefined) {
    if (!isModelVisibility(visibility)) {
      res.status(400).json({ error: `visibility must be one of: ${MODEL_VISIBILITY.join(', ')}` });
      return;
    }
    db.prepare('UPDATE collections SET visibility = ? WHERE id = ?').run(visibility, row.id);
  }

  const updated = db.prepare('SELECT * FROM collections WHERE id = ?').get(row.id) as CollectionRow;
  res.json(collectionToOut(updated, modelCountFor(db, row.id)));
});

// ─── DELETE /collection/:id ─────────────────────────────────────────────────────
//
// Plain delete, no guard (see file header). collection_models cascades
// off collection_id — models/model_files/assets are never touched.

router.delete('/collection/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id, owner_id FROM collections WHERE id = ?').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!row || !isOwnerOrAdmin(row, req)) { res.status(404).json({ error: 'Not found' }); return; }

  db.prepare('DELETE FROM collections WHERE id = ?').run(row.id);
  res.status(204).end();
});

// ─── POST /collection/:id/models — add members ─────────────────────────────────

router.post('/collection/:id/models', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const collection = db.prepare('SELECT id, owner_id FROM collections WHERE id = ?').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!collection || !isOwnerOrAdmin(collection, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const { modelIds } = req.body as { modelIds?: string[] };
  if (!modelIds?.length) { res.status(400).json({ error: 'modelIds required' }); return; }

  const insertMember = db.prepare(
    `INSERT OR IGNORE INTO collection_models (collection_id, model_id, sort_order)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collection_models WHERE collection_id = ?))`
  );
  const validId = db.prepare('SELECT 1 FROM models WHERE id = ? AND deleted_at IS NULL');
  let added = 0;
  db.transaction(() => {
    for (const mid of modelIds) {
      if (validId.get(mid)) {
        const r = insertMember.run(collection.id, mid, collection.id);
        if (r.changes > 0) added++;
      }
    }
  })();
  res.json({ added });
});

// ─── DELETE /collection/:id/model/:modelId — remove member ────────────────────

router.delete('/collection/:id/model/:modelId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const collection = db.prepare('SELECT id, owner_id, cover_model_id FROM collections WHERE id = ?').get(req.params.id) as
    | { id: string; owner_id: string | null; cover_model_id: string | null } | undefined;
  if (!collection || !isOwnerOrAdmin(collection, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const r = db.prepare('DELETE FROM collection_models WHERE collection_id = ? AND model_id = ?')
    .run(collection.id, req.params.modelId);
  if (r.changes === 0) { res.status(404).json({ error: 'Not in collection' }); return; }

  // Never leave cover_model_id pointing at a model no longer a member —
  // same invariant models.ts's DELETE /model/:id/file/:assetId keeps for
  // cover_asset_id.
  if (collection.cover_model_id === req.params.modelId) {
    db.prepare('UPDATE collections SET cover_model_id = NULL WHERE id = ?').run(collection.id);
  }

  res.status(204).end();
});

// ─── PATCH /collection/:id/models/reorder ──────────────────────────────────────
// Body: { modelIds: string[] } — full desired order; sort_order is
// assigned as each id's array index. Mirrors PATCH
// /model/:id/files/reorder's contract exactly.

router.patch('/collection/:id/models/reorder', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const collection = db.prepare('SELECT id, owner_id FROM collections WHERE id = ?').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!collection || !isOwnerOrAdmin(collection, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const { modelIds } = req.body as { modelIds?: string[] };
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    res.status(400).json({ error: 'modelIds must be a non-empty ordered array' });
    return;
  }

  const update = db.prepare('UPDATE collection_models SET sort_order = ? WHERE collection_id = ? AND model_id = ?');
  db.transaction(() => {
    modelIds.forEach((mid, i) => update.run(i, collection.id, mid));
  })();

  // Response shape mirrors GET /collection/:id's own visibility-filtered
  // detail (same modelFrag treatment, same "modelCount may differ per
  // viewer" acceptance) rather than an unfiltered rebuild — this caller
  // just proved owner-or-admin on the COLLECTION, which says nothing
  // about whether every member model is THEIRS too (an admin could be
  // reordering a collection containing other users' public models).
  const ctx = visCtx(req);
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id) as CollectionRow;
  const modelFrag = visibilityFragment(ctx);
  const modelRows = db.prepare(
    `SELECT m.* FROM collection_models cm
     JOIN models m ON m.id = cm.model_id
     WHERE cm.collection_id = ? AND m.deleted_at IS NULL AND (${modelFrag.sql})
     ORDER BY cm.sort_order ASC, cm.added_at DESC`
  ).all(collection.id, ...modelFrag.params) as ModelRow[];
  const detail: CollectionDetailOut = {
    ...collectionToOut(row, modelRows.length),
    models: modelRows.map((m) => modelRowToOut(db, m, req.user!.id)),
  };
  res.json(detail);
});

// ─── PATCH /collection/:id/cover ───────────────────────────────────────────────
// Mirrors PATCH /model/:id/cover exactly: modelId must already be a
// member; null clears the cover (falls back to the first member model
// with a usable thumb, server-side — see resolveCollectionCoverThumb).

router.patch('/collection/:id/cover', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const collection = db.prepare('SELECT id, owner_id FROM collections WHERE id = ?').get(req.params.id) as
    { id: string; owner_id: string | null } | undefined;
  if (!collection || !isOwnerOrAdmin(collection, req)) { res.status(404).json({ error: 'Not found' }); return; }

  const { modelId } = req.body as { modelId?: string | null };
  if (modelId) {
    const linked = db.prepare('SELECT 1 FROM collection_models WHERE collection_id = ? AND model_id = ?').get(collection.id, modelId);
    if (!linked) { res.status(400).json({ error: 'Cover model must be a member of the collection' }); return; }
  }
  db.prepare('UPDATE collections SET cover_model_id = ? WHERE id = ?').run(modelId || null, collection.id);

  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id) as CollectionRow;
  res.json(collectionToOut(row, modelCountFor(db, collection.id)));
});

export default router;
