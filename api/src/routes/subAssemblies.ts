// Build Manifest routes — sub-assemblies (hierarchical, project-scoped) and
// their part placements. See:
// Reports/sloane-prd-thefabvault-build-manifest-2026-07-06.md (data model,
//   progress-rollup semantics, ungrouped-pool boundary rule)
// Reports/reid-thefabvault-manifest-ux-2026-07-06.md (UI/IA this API backs)
//
// project_assets (the existing flat project/asset join) is untouched and
// becomes the "ungrouped" pool: files attached to a project that haven't
// been organized into the manifest yet. The boundary between the two pools
// is an application-layer invariant, not a DB constraint (SQLite can't
// cheaply express "exactly one of these two tables" across independent
// tables) — enforced here:
//   - adding a placement removes any existing project_assets row for that
//     asset in this project (organize a file -> it leaves Ungrouped)
//   - removing a placement (or deleting a sub-assembly, which cascades
//     through its whole subtree) re-inserts a project_assets row for any
//     affected asset that has zero remaining placements anywhere in the
//     project's manifest (a shared part still placed in a sibling branch
//     stays organized; only a fully-orphaned asset returns to Ungrouped)

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import {
  getSubAssemblyRollups, getProjectRollupTotal, getSubtreeIds,
} from '../services/manifestRollup.js';
import { validateReparent } from '../services/subAssemblyTree.js';
import { thumbExists } from '../services/fileStore.js';
import type {
  SubAssemblyRow, SubAssemblyPartRow, SubAssemblyOut, SubAssemblyPartOut,
  SubAssemblyRollup, ManifestOut, AssetRow, AssetOut, ProjectOverrides,
} from '../types/index.js';

const router = Router();

const EMPTY_ROLLUP: SubAssemblyRollup = { needed: 0, done: 0, percent: null };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function subAssemblyToOut(row: SubAssemblyRow, rollup: SubAssemblyRollup): SubAssemblyOut {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    rollup,
  };
}

// Mirrors routes/projects.ts#assetRowToOut / routes/sets.ts#assetRowToOut.
// Kept inline to avoid coupling — same convention already established in
// this codebase (see the comment on sets.ts's copy).
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

function partRowToOut(part: SubAssemblyPartRow, asset: AssetRow): SubAssemblyPartOut {
  return {
    subAssemblyId: part.sub_assembly_id,
    quantity: part.quantity,
    printedCount: part.printed_count,
    sortOrder: part.sort_order,
    overrides: JSON.parse(part.overrides_json || '{}') as ProjectOverrides,
    asset: assetRowToOut(asset),
  };
}

// ─── GET /project/:id/manifest — whole tree, once per project load ───────────

router.get('/project/:id/manifest', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const rollupMap = getSubAssemblyRollups(db, req.params.id);

  const saRows = db.prepare(
    'SELECT * FROM sub_assemblies WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(req.params.id) as SubAssemblyRow[];
  const subAssemblies: SubAssemblyOut[] = saRows.map((r) =>
    subAssemblyToOut(r, rollupMap.get(r.id) ?? EMPTY_ROLLUP)
  );

  // Two flat queries (parts, then their assets in one batch) instead of a
  // single joined query — avoids a column-name collision between
  // sub_assembly_parts.created_at and assets.created_at in a `p.*, a.*`
  // select, and keeps the asset fetch batched (no N+1).
  const partRows = db.prepare(
    `SELECT p.* FROM sub_assembly_parts p
     JOIN sub_assemblies sa ON sa.id = p.sub_assembly_id
     WHERE sa.project_id = ?
     ORDER BY p.sort_order ASC, p.created_at ASC`
  ).all(req.params.id) as SubAssemblyPartRow[];

  const assetIds = [...new Set(partRows.map((p) => p.asset_id))];
  const assetMap = new Map<string, AssetRow>();
  if (assetIds.length > 0) {
    const placeholders = assetIds.map(() => '?').join(',');
    const assetRows = db.prepare(
      `SELECT * FROM assets WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...assetIds) as AssetRow[];
    for (const a of assetRows) assetMap.set(a.id, a);
  }

  const parts: SubAssemblyPartOut[] = partRows
    .filter((p) => assetMap.has(p.asset_id))
    .map((p) => partRowToOut(p, assetMap.get(p.asset_id)!));

  const ungroupedCount = (db.prepare(
    'SELECT COUNT(*) as cnt FROM project_assets WHERE project_id = ?'
  ).get(req.params.id) as { cnt: number }).cnt;

  const manifest: ManifestOut = {
    subAssemblies,
    parts,
    projectRollup: getProjectRollupTotal(db, req.params.id),
    ungroupedCount,
  };
  res.json(manifest);
});

// ─── POST /project/:id/sub-assemblies — create ───────────────────────────────

router.post('/project/:id/sub-assemblies', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const { name, parentId } = req.body as { name?: string; parentId?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  if (parentId) {
    const parent = db.prepare('SELECT id, project_id FROM sub_assemblies WHERE id = ?').get(parentId) as
      | { id: string; project_id: string } | undefined;
    if (!parent) { res.status(400).json({ error: 'Parent sub-assembly not found' }); return; }
    if (parent.project_id !== req.params.id) {
      res.status(400).json({ error: 'Parent sub-assembly belongs to a different project' });
      return;
    }
  }

  const id = uuidv4();
  // `parent_id IS ?` (not `=`) so the sibling-scoped MAX(sort_order) lookup
  // correctly matches top-level siblings when parentId is NULL — SQLite's
  // `=` never matches NULL, `IS` is the NULL-safe comparison.
  db.prepare(
    `INSERT INTO sub_assemblies (id, project_id, parent_id, name, sort_order)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sub_assemblies
                           WHERE project_id = ? AND parent_id IS ?))`
  ).run(id, req.params.id, parentId ?? null, name.trim(), req.params.id, parentId ?? null);

  const row = db.prepare('SELECT * FROM sub_assemblies WHERE id = ?').get(id) as SubAssemblyRow;
  res.status(201).json(subAssemblyToOut(row, EMPTY_ROLLUP));
});

// ─── PATCH /sub-assembly/:id — rename / reparent / reorder ───────────────────

router.patch('/sub-assembly/:id', requireAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, parentId, sortOrder } = req.body as {
    name?: string; parentId?: string | null; sortOrder?: number;
  };
  const db = getDb();

  const row = db.prepare('SELECT * FROM sub_assemblies WHERE id = ?').get(id) as SubAssemblyRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  if (parentId) {
    // Ported from routes/folders.ts's PATCH /folder/:id cycle guard
    // (sub_assemblies is structurally identical: self-referential
    // parent_id, same infinite-nesting shape) — extracted to
    // services/subAssemblyTree.ts so it's unit-testable directly.
    const validation = validateReparent(db, id, row.project_id, parentId);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
  }

  const newName = name?.trim() ?? row.name;
  const newParentId = parentId === undefined ? row.parent_id : (parentId ?? null);
  const newSortOrder = sortOrder === undefined ? row.sort_order : sortOrder;

  db.prepare('UPDATE sub_assemblies SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?')
    .run(newName, newParentId, newSortOrder, id);

  const updated = db.prepare('SELECT * FROM sub_assemblies WHERE id = ?').get(id) as SubAssemblyRow;
  const rollupMap = getSubAssemblyRollups(db, updated.project_id);
  res.json(subAssemblyToOut(updated, rollupMap.get(updated.id) ?? EMPTY_ROLLUP));
});

// ─── DELETE /sub-assembly/:id — cascades subtree, returns orphaned assets ────
// ─── to the ungrouped pool ────────────────────────────────────────────────────

router.delete('/sub-assembly/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sub_assemblies WHERE id = ?').get(req.params.id) as
    | SubAssemblyRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  // Gather the full subtree (self + every descendant) and every distinct
  // asset placed anywhere in it BEFORE deleting — once the DELETE fires,
  // ON DELETE CASCADE wipes sub_assembly_parts for the whole subtree and
  // there's nothing left to inspect.
  const subtreeIds = getSubtreeIds(db, row.id);
  const placeholders = subtreeIds.map(() => '?').join(',');
  const affectedAssetIds = subtreeIds.length > 0
    ? (db.prepare(
        `SELECT DISTINCT asset_id FROM sub_assembly_parts WHERE sub_assembly_id IN (${placeholders})`
      ).all(...subtreeIds) as { asset_id: string }[]).map((r) => r.asset_id)
    : [];

  const stillPlacedStmt = db.prepare(
    `SELECT 1 FROM sub_assembly_parts p JOIN sub_assemblies sa ON sa.id = p.sub_assembly_id
     WHERE sa.project_id = ? AND p.asset_id = ?`
  );
  const insertUngrouped = db.prepare(
    `INSERT OR IGNORE INTO project_assets (project_id, asset_id, sort_order, overrides_json)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_assets WHERE project_id = ?), '{}')`
  );

  db.transaction(() => {
    db.prepare('DELETE FROM sub_assemblies WHERE id = ?').run(row.id); // cascades children + parts

    for (const assetId of affectedAssetIds) {
      // Only re-insert if this asset has zero remaining placements anywhere
      // else in the project's manifest — a shared part still placed in a
      // sibling branch (e.g. the same greeble also in Left Foot while we
      // deleted Right Foot) stays organized, not ungrouped.
      if (!stillPlacedStmt.get(row.project_id, assetId)) {
        insertUngrouped.run(row.project_id, assetId, row.project_id);
      }
    }
  })();

  res.status(204).send();
});

// ─── POST /sub-assembly/:id/parts — place asset(s), quantity defaults to 1 ───

router.post('/sub-assembly/:id/parts', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const sa = db.prepare('SELECT * FROM sub_assemblies WHERE id = ?').get(req.params.id) as
    | SubAssemblyRow | undefined;
  if (!sa) { res.status(404).json({ error: 'Sub-assembly not found' }); return; }

  const { assetIds } = req.body as { assetIds?: string[] };
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    res.status(400).json({ error: 'assetIds array is required' });
    return;
  }

  // Quantity is always 1 at placement time — no filename parsing, no
  // quantity field in the add flow (Aaron's locked decision 3). Correction
  // is the fast inline-pill edit on the resulting part row.
  const insertPart = db.prepare(
    `INSERT OR IGNORE INTO sub_assembly_parts
       (sub_assembly_id, asset_id, quantity, printed_count, sort_order, overrides_json)
     VALUES (?, ?, 1, 0, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sub_assembly_parts
                          WHERE sub_assembly_id = ?), '{}')`
  );
  // Placing a file into the manifest means it's no longer "ungrouped" —
  // remove any project_assets row for it in this project (PRD boundary
  // rule). No-op if it wasn't there.
  const removeUngrouped = db.prepare('DELETE FROM project_assets WHERE project_id = ? AND asset_id = ?');
  const assetExists = db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL');

  let added = 0;
  db.transaction(() => {
    for (const assetId of assetIds) {
      if (!assetExists.get(assetId)) continue;
      const info = insertPart.run(sa.id, assetId, sa.id);
      if (info.changes > 0) added++;
      removeUngrouped.run(sa.project_id, assetId);
    }
  })();

  res.json({ added });
});

// ─── PATCH /sub-assembly/:id/part/:assetId — quantity / printed-count ────────

router.patch('/sub-assembly/:id/part/:assetId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const part = db.prepare(
    'SELECT * FROM sub_assembly_parts WHERE sub_assembly_id = ? AND asset_id = ?'
  ).get(req.params.id, req.params.assetId) as SubAssemblyPartRow | undefined;
  if (!part) { res.status(404).json({ error: 'Part not found' }); return; }

  const { quantity, printedCount } = req.body as { quantity?: number; printedCount?: number };

  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      res.status(400).json({ error: 'quantity must be an integer >= 1' });
      return;
    }
    db.prepare('UPDATE sub_assembly_parts SET quantity = ? WHERE sub_assembly_id = ? AND asset_id = ?')
      .run(quantity, req.params.id, req.params.assetId);
  }
  if (printedCount !== undefined) {
    // No upper cap against quantity — reprints/spares are real (PRD: the
    // rollup clamps its own contribution at 100%, the raw counter doesn't).
    if (!Number.isInteger(printedCount) || printedCount < 0) {
      res.status(400).json({ error: 'printedCount must be an integer >= 0' });
      return;
    }
    db.prepare('UPDATE sub_assembly_parts SET printed_count = ? WHERE sub_assembly_id = ? AND asset_id = ?')
      .run(printedCount, req.params.id, req.params.assetId);
  }

  const updated = db.prepare(
    'SELECT * FROM sub_assembly_parts WHERE sub_assembly_id = ? AND asset_id = ?'
  ).get(req.params.id, req.params.assetId) as SubAssemblyPartRow;
  const assetRow = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.assetId) as AssetRow;
  res.json(partRowToOut(updated, assetRow));
});

// ─── PATCH /sub-assembly/:id/part/:assetId/overrides ─────────────────────────
// Mirrors PATCH /project/:id/asset/:assetId/overrides exactly — same
// AssetOverridesModal component on the frontend, pointed at a different
// overrides_json column.

router.patch('/sub-assembly/:id/part/:assetId/overrides', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const part = db.prepare(
    'SELECT * FROM sub_assembly_parts WHERE sub_assembly_id = ? AND asset_id = ?'
  ).get(req.params.id, req.params.assetId) as SubAssemblyPartRow | undefined;
  if (!part) { res.status(404).json({ error: 'Part not found' }); return; }

  const overrides = req.body as ProjectOverrides;
  db.prepare('UPDATE sub_assembly_parts SET overrides_json = ? WHERE sub_assembly_id = ? AND asset_id = ?')
    .run(JSON.stringify(overrides), req.params.id, req.params.assetId);

  res.status(204).send();
});

// ─── DELETE /sub-assembly/:id/part/:assetId — remove one placement ───────────

router.delete('/sub-assembly/:id/part/:assetId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const sa = db.prepare('SELECT * FROM sub_assemblies WHERE id = ?').get(req.params.id) as
    | SubAssemblyRow | undefined;
  if (!sa) { res.status(404).json({ error: 'Sub-assembly not found' }); return; }

  const info = db.prepare('DELETE FROM sub_assembly_parts WHERE sub_assembly_id = ? AND asset_id = ?')
    .run(req.params.id, req.params.assetId);
  if (info.changes === 0) { res.status(404).json({ error: 'Part not found' }); return; }

  // If this asset has no other placements left anywhere in this project's
  // manifest, it falls out of "organized" — return it to the ungrouped pool
  // so it never disappears from both (PRD invariant; Reid's UX spec, open
  // question #1). If it's still placed elsewhere (a shared part), leave it.
  const stillPlaced = db.prepare(
    `SELECT 1 FROM sub_assembly_parts p JOIN sub_assemblies s ON s.id = p.sub_assembly_id
     WHERE s.project_id = ? AND p.asset_id = ?`
  ).get(sa.project_id, req.params.assetId);

  if (!stillPlaced) {
    db.prepare(
      `INSERT OR IGNORE INTO project_assets (project_id, asset_id, sort_order, overrides_json)
       VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_assets WHERE project_id = ?), '{}')`
    ).run(sa.project_id, req.params.assetId, sa.project_id);
  }

  res.status(204).send();
});

export default router;
