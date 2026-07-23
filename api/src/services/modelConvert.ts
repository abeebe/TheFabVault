// Folder->model conversion (#2155 Phase A; reworked #2175 — see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md and
// the #2175 closing-API ticket for the recursive/bulk rework).
//
// Two sections:
//   1. Pure classification (planFolderConversion et al.) — no DB access,
//      no filesystem I/O, same shape as services/subAssemblyTree.ts's
//      validateReparent: a plain function over plain data so it's
//      directly unit-testable without booting a DB or an HTTP server.
//   2. DB-touching folder-tree helpers (added #2175) — the recursive
//      "collect this folder + every descendant" queries both grouping
//      modes need. Kept in this file rather than split out to a second
//      service module: they're the DB-facing half of the same
//      folder->model conversion domain, same as
//      services/manifestRollup.ts mixing pure math (toPercent) with
//      WITH RECURSIVE queries (getSubAssemblyRollups) for one cohesive
//      concern rather than splitting pure/impure across files.
//
// Ext-to-role mapping reuses THREE_D_EXTS from routes/assets.ts (the
// existing 3dmodel/2d auto-category split) rather than a second,
// divergent extension list for "which files are 3D parts" — see that
// export's comment. Image and doc lists are new; assets.ts has no
// equivalent grouping for either (TWO_D_EXTS there covers vector/laser
// formats, not "picture of the finished print", and includes .pdf,
// which for a model is a doc, not an image — the two lists serve
// different questions and are allowed to overlap on .pdf without
// conflict).

import path from 'path';
import type Database from 'better-sqlite3';
import { THREE_D_EXTS } from '../routes/assets.js';
import type { ModelFileRole } from './enumValidators.js';
import type { AssetRow, FolderRow } from '../types/index.js';

export const MODEL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const MODEL_DOC_EXTS = new Set(['.pdf', '.txt', '.md']);

// Minimal shape needed to classify + pick a cover — a subset of AssetRow
// so callers don't need to construct a full row for tests/fixtures.
export interface ConvertibleAsset {
  assetId: string;
  filename: string;
  thumbStatus: 'none' | 'pending' | 'done' | 'failed';
}

export interface ClassifiedFile {
  assetId: string;
  role: ModelFileRole;
  sortOrder: number;
}

export interface FolderConversionPlan {
  files: ClassifiedFile[];
  // First image asset if one exists, else the first asset (in input
  // order) whose thumbnail has finished rendering, else null (nothing
  // usable yet — the model is created with no cover, same as any other
  // model with cover_asset_id unset).
  coverAssetId: string | null;
}

// Extension classification alone, exported separately from the
// full-folder planner so a single filename can be classified in
// isolation (e.g. by routes/models.ts's attach endpoint, which needs the
// same role inference for a single newly-uploaded file, not a whole
// folder).
export function classifyExt(filename: string): ModelFileRole {
  const ext = path.extname(filename).toLowerCase();
  if (MODEL_IMAGE_EXTS.has(ext)) return 'image';
  if (THREE_D_EXTS.has(ext)) return 'part';
  if (MODEL_DOC_EXTS.has(ext)) return 'doc';
  return 'other';
}

export function planFolderConversion(assets: ConvertibleAsset[]): FolderConversionPlan {
  const files: ClassifiedFile[] = assets.map((a, i) => ({
    assetId: a.assetId,
    role: classifyExt(a.filename),
    sortOrder: i,
  }));

  const firstImage = assets.find((a) => classifyExt(a.filename) === 'image');
  const coverAssetId = firstImage
    ? firstImage.assetId
    : (assets.find((a) => a.thumbStatus === 'done')?.assetId ?? null);

  return { files, coverAssetId };
}

// ─── #2175 — recursive folder-tree helpers ─────────────────────────────────────
//
// Root cause this section fixes: the original POST /models/from-folder
// only ever looked at a folder's DIRECT assets. Pointing it at a
// meaningfully-named parent folder ("Droidkyn") grabbed near nothing,
// because real parts live several levels down in bare-GUID-named leaf
// folders left behind by bulk/manifest import. Every query below walks
// the full subtree instead of one level.

// Bare-GUID folder name detector — matches a standalone 8-4-4-4-12 hex
// UUID (any version/variant, case-insensitive), nothing else in the
// name. Bulk/manifest/zip imports name leaf folders after their source
// GUID when no better name is available (see manifestImport.ts), and
// that's exactly the "meaningless leaf" this helper flags for two
// consumers: Mode B's per-child iteration below (a bare-GUID immediate
// child is never modeled on its own — see planEachChildConversion) and
// the wizard's folder-tree filtering (routes/folders.ts threads this
// onto FolderOut.isBareGuid so the UI can grey/hide these without
// duplicating the regex).
const BARE_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isBareGuidName(name: string): boolean {
  return BARE_GUID_RE.test(name.trim());
}

// Defensive recursion cap (fold-in, Remy's review of this ticket):
// folders.parent_id has no DB-level cycle constraint — routes/folders.ts's
// PATCH /folder/:id guards against CREATING a cycle through normal use,
// but that's an application-layer check on ONE mutation path, not a
// schema guarantee, so it doesn't retroactively protect against a
// cyclic parent_id arriving some other way (a hand-edited row, a bad
// migration/import). Confirmed unreachable through this endpoint today,
// but the CTE below has no bound of its own: UNION ALL never dedupes,
// so a genuine cycle makes it re-add the same ids forever. Because
// better-sqlite3 is synchronous, that hangs the entire Node process
// (Remy reproduced >15s with no termination on a hand-built cyclic
// fixture) — not a query timeout, a frozen server. depth caps the walk
// at MAX_FOLDER_TREE_DEPTH levels: Aaron's real tree is ~5 levels deep,
// so this is enormous headroom for any legitimate tree while
// guaranteeing the query always terminates. Same fix applied to the
// structurally identical services/manifestRollup.ts#getSubtreeIds
// (sub_assemblies.parent_id, same unbounded UNION ALL pattern).
const MAX_FOLDER_TREE_DEPTH = 100;

// Every folder id in rootFolderId's subtree, root included — same
// WITH RECURSIVE closure shape as services/manifestRollup.ts's
// getSubtreeIds (sub_assemblies.parent_id is structurally identical to
// folders.parent_id).
export function getRecursiveFolderIds(db: Database.Database, rootFolderId: string): string[] {
  const rows = db.prepare(
    `WITH RECURSIVE folder_tree(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT f.id, folder_tree.depth + 1
       FROM folders f JOIN folder_tree ON f.parent_id = folder_tree.id
       WHERE folder_tree.depth < ?
     )
     SELECT id, depth FROM folder_tree`
  ).all(rootFolderId, MAX_FOLDER_TREE_DEPTH) as { id: string; depth: number }[];

  // A row AT the cap means the walk was still finding new children right
  // up to the boundary — either a cycle (would otherwise run forever) or
  // a genuinely unusual tree deeper than any real vault has. Either way,
  // terminate gracefully with whatever was collected rather than
  // throwing a 500 on what might be a legitimate (if extreme) deep tree
  // — this is a safety valve, not a validation error.
  if (rows.some((r) => r.depth === MAX_FOLDER_TREE_DEPTH)) {
    console.warn(
      `[modelConvert] getRecursiveFolderIds hit the ${MAX_FOLDER_TREE_DEPTH}-level depth cap under `
      + `folder ${rootFolderId} — likely a cyclic parent_id. Returning the truncated set instead of hanging.`
    );
  }

  return rows.map((r) => r.id);
}

// Every live (non-deleted) asset anywhere under rootFolderId, root's own
// direct assets included — the "Mode A: this folder -> 1 model" data
// source. For a folder with no subfolders this is identical to the old
// direct-children-only query (the recursive CTE's closure is just the
// root id), so it's a strict superset behavior, not a breaking change,
// for every already-flat folder.
export function getRecursiveConvertibleAssets(db: Database.Database, rootFolderId: string): AssetRow[] {
  const folderIds = getRecursiveFolderIds(db, rootFolderId);
  const placeholders = folderIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM assets WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY filename ASC`
  ).all(...folderIds) as AssetRow[];
}

// Immediate (one-level) child folders of parentFolderId — Mode B walks
// only this list, never the full subtree at this level (each eligible
// child then recurses independently via getRecursiveConvertibleAssets).
export function getImmediateChildFolders(db: Database.Database, parentFolderId: string): FolderRow[] {
  return db.prepare('SELECT * FROM folders WHERE parent_id = ? ORDER BY name ASC').all(parentFolderId) as FolderRow[];
}

export interface EachChildClassification {
  eligible: FolderRow[];
  skipped: FolderRow[];
}

// Mode B's "named vs bare-GUID" split, per Aaron's spec: iterate
// IMMEDIATE children of the selected (container) folder; a child whose
// name is NOT a bare GUID becomes its own recursive model, a bare-GUID
// child is skipped entirely (never modeled, never silently folded into
// anything else). Loose direct assets sitting in the container folder
// itself (not under any child) are likewise never converted by Mode B —
// callers surface that count separately (see routes/models.ts's
// looseAssetCount) rather than inventing a catch-all model nobody asked
// for. This is a deliberate "skip and surface, don't guess" choice over
// the alternative (rolling bare-GUID children + loose assets into one
// extra model titled after the container) — see the #2175 closing report
// for the full rationale; both options were explicitly on the table.
export function planEachChildConversion(children: FolderRow[]): EachChildClassification {
  const eligible: FolderRow[] = [];
  const skipped: FolderRow[] = [];
  for (const child of children) {
    if (isBareGuidName(child.name)) skipped.push(child);
    else eligible.push(child);
  }
  return { eligible, skipped };
}
