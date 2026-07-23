// Progress-rollup math for the build manifest (sub_assemblies /
// sub_assembly_parts, migration v12). See:
// Reports/sloane-prd-thefabvault-build-manifest-2026-07-06.md
//
// Rule: progress lives on the placement (sub_assembly_parts), never on the
// asset. A shared part placed in two sub-assemblies is two independent
// counters. Rollup for any node = its own direct parts (quantity/printed,
// clamped so one placement can never contribute more than 100% of itself)
// plus the same rollup recursively summed over every descendant. Computed
// with a single WITH RECURSIVE closure CTE per project/lookup, never N+1
// per-node recursive JS calls — a 500-part, multi-level tree is one query.

import type Database from 'better-sqlite3';
import type { SubAssemblyRollup } from '../types/index.js';

function toPercent(needed: number, done: number): number | null {
  if (needed === 0) return null;
  return Math.round((100 * done) / needed);
}

// Rollup for every sub_assembly in one project, keyed by sub_assembly id.
// The closure CTE expands each node to (itself + every descendant), then
// joins sub_assembly_parts and sums, clamping each placement's contribution
// to done at its own quantity (a placement can't count more than 100% of
// itself toward its ancestors even if printed_count logs a reprint past
// quantity — the raw printed_count is preserved elsewhere, only the rollup
// clamps).
export function getSubAssemblyRollups(
  db: Database.Database,
  projectId: string
): Map<string, SubAssemblyRollup> {
  const rows = db
    .prepare(
      `WITH RECURSIVE closure(ancestor_id, descendant_id) AS (
         SELECT id, id FROM sub_assemblies WHERE project_id = ?
         UNION ALL
         SELECT c.ancestor_id, sa.id
         FROM closure c
         JOIN sub_assemblies sa ON sa.parent_id = c.descendant_id
       ),
       -- #2027: a placement whose asset has been soft-deleted (trashed but
       -- still "placed") must drop out of the rollup entirely — it's not a
       -- physical part anyone can print anymore. Filtering here (inner join
       -- to assets, live rows only) rather than in the outer LEFT JOIN's ON
       -- clause keeps the closure's LEFT JOIN semantics intact: a
       -- sub-assembly with zero LIVE parts still gets its row (needed=0,
       -- done=0, percent=null), same as one with zero parts at all.
       live_parts AS (
         SELECT p.sub_assembly_id, p.quantity, p.printed_count
         FROM sub_assembly_parts p
         JOIN assets a ON a.id = p.asset_id
         WHERE a.deleted_at IS NULL
       )
       SELECT c.ancestor_id AS sub_assembly_id,
              COALESCE(SUM(lp.quantity), 0) AS needed,
              COALESCE(SUM(MIN(lp.printed_count, lp.quantity)), 0) AS done
       FROM closure c
       LEFT JOIN live_parts lp ON lp.sub_assembly_id = c.descendant_id
       GROUP BY c.ancestor_id`
    )
    .all(projectId) as { sub_assembly_id: string; needed: number; done: number }[];

  const map = new Map<string, SubAssemblyRollup>();
  for (const r of rows) {
    map.set(r.sub_assembly_id, { needed: r.needed, done: r.done, percent: toPercent(r.needed, r.done) });
  }
  return map;
}

// Project-level total. Every placement belongs to exactly one sub_assembly,
// so summing directly across all of a project's placements is equivalent
// to (and cheaper than) summing the rollup at each top-level root — no
// closure CTE needed here.
export function getProjectRollupTotal(db: Database.Database, projectId: string): SubAssemblyRollup {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.quantity), 0) AS needed,
              COALESCE(SUM(MIN(p.printed_count, p.quantity)), 0) AS done
       FROM sub_assembly_parts p
       JOIN sub_assemblies sa ON sa.id = p.sub_assembly_id
       JOIN assets a ON a.id = p.asset_id
       WHERE sa.project_id = ? AND a.deleted_at IS NULL`
    )
    .get(projectId) as { needed: number; done: number };
  return { needed: row.needed, done: row.done, percent: toPercent(row.needed, row.done) };
}

// Batched project-list rollup — one query for every project that has a
// manifest, keyed by project_id. A project with zero sub_assemblies rows
// simply has no entry (map.has(id) === false is exactly "hasManifest").
// Used by GET /projects so the sidebar's per-row percent badge never costs
// an extra request per row.
export function getAllProjectRollups(db: Database.Database): Map<string, SubAssemblyRollup> {
  const rows = db
    .prepare(
      `SELECT sa.project_id AS project_id,
              COALESCE(SUM(CASE WHEN a.deleted_at IS NULL THEN p.quantity END), 0) AS needed,
              COALESCE(SUM(CASE WHEN a.deleted_at IS NULL THEN MIN(p.printed_count, p.quantity) END), 0) AS done
       FROM sub_assemblies sa
       LEFT JOIN sub_assembly_parts p ON p.sub_assembly_id = sa.id
       LEFT JOIN assets a ON a.id = p.asset_id
       GROUP BY sa.project_id`
    )
    .all() as { project_id: string; needed: number; done: number }[];

  const map = new Map<string, SubAssemblyRollup>();
  for (const r of rows) {
    map.set(r.project_id, { needed: r.needed, done: r.done, percent: toPercent(r.needed, r.done) });
  }
  return map;
}

// hasManifest + manifestPercent for a single project — used by the
// single-project response paths (POST/PATCH/GET /project/:id) where a
// second small query is cheap and simpler than threading the batched map
// through every call site.
export function getSingleProjectManifestInfo(
  db: Database.Database,
  projectId: string
): { hasManifest: boolean; manifestPercent: number | null } {
  const has = db.prepare('SELECT 1 FROM sub_assemblies WHERE project_id = ? LIMIT 1').get(projectId);
  if (!has) return { hasManifest: false, manifestPercent: null };
  const total = getProjectRollupTotal(db, projectId);
  return { hasManifest: true, manifestPercent: total.percent };
}

// #2027: the ungrouped-pool count (project_assets), consistently excluding
// soft-deleted assets. Pulled out into one function rather than left as
// three copies of the same raw COUNT(*) inline in routes/projects.ts and
// routes/subAssemblies.ts — a trashed asset sitting in project_assets
// (soft-delete never removes the project_assets row, see routes/assets.ts's
// DELETE handler) must not inflate the "N ungrouped" badge shown next to
// the manifest and the project sidebar.
export function getUngroupedCount(db: Database.Database, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM project_assets pa
       JOIN assets a ON a.id = pa.asset_id
       WHERE pa.project_id = ? AND a.deleted_at IS NULL`
    )
    .get(projectId) as { cnt: number };
  return row.cnt;
}

// Same shape as getUngroupedCount but batched across every project in one
// query, mirroring getAllProjectRollups — used by GET /projects so the
// sidebar's ungrouped-count badge doesn't cost a query per row.
export function getAllUngroupedCounts(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT pa.project_id AS project_id, COUNT(*) AS cnt
       FROM project_assets pa
       JOIN assets a ON a.id = pa.asset_id
       WHERE a.deleted_at IS NULL
       GROUP BY pa.project_id`
    )
    .all() as { project_id: string; cnt: number }[];
  return new Map(rows.map((r) => [r.project_id, r.cnt]));
}

// Defensive recursion cap (fold-in, #2175 closing-api review): same
// unbounded WITH RECURSIVE pattern services/modelConvert.ts's
// getRecursiveFolderIds had before this fold-in, on the structurally
// identical parent_id shape (sub_assemblies vs folders). No DB-level
// cycle constraint backs sub_assemblies.parent_id either — services/
// subAssemblyTree.ts's validateReparent guards the one normal mutation
// path (reparenting), not a schema guarantee — so a cyclic parent_id
// arriving some other way would hang this synchronous, single-threaded
// better-sqlite3 query (and the whole Node process with it) forever,
// since UNION ALL never dedupes and just keeps re-adding the cycle's
// ids. depth caps the walk at MAX_SUBTREE_DEPTH levels — real build
// manifests are nowhere near this deep — guaranteeing termination
// instead of a freeze.
const MAX_SUBTREE_DEPTH = 100;

// All sub_assembly ids in a subtree, self included — used by the delete
// path to know which placements are about to be cascade-deleted before
// they're gone, so the affected assets can be evaluated for return to the
// ungrouped pool.
export function getSubtreeIds(db: Database.Database, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT sa.id, subtree.depth + 1
         FROM subtree JOIN sub_assemblies sa ON sa.parent_id = subtree.id
         WHERE subtree.depth < ?
       )
       SELECT id, depth FROM subtree`
    )
    .all(rootId, MAX_SUBTREE_DEPTH) as { id: string; depth: number }[];

  // Same graceful-termination rationale as getRecursiveFolderIds: a row
  // at the cap means either a cycle or a genuinely unusual depth — log
  // and return the truncated set, never throw on what might be a
  // legitimate (if extreme) deep tree.
  if (rows.some((r) => r.depth === MAX_SUBTREE_DEPTH)) {
    console.warn(
      `[manifestRollup] getSubtreeIds hit the ${MAX_SUBTREE_DEPTH}-level depth cap under sub_assembly `
      + `${rootId} — likely a cyclic parent_id. Returning the truncated set instead of hanging.`
    );
  }

  return rows.map((r) => r.id);
}

// The ungrouped/organized boundary rule, on the removal side: if `assetId`
// has zero remaining placements anywhere in `projectId`'s manifest, it
// falls out of "organized" and returns to the ungrouped pool
// (project_assets). If it's still placed elsewhere (a shared part in a
// sibling branch), it's left alone. Caller must run the placement DELETE
// first — this only looks at what's left.
//
// Pulled out of routes/subAssemblies.ts's single-part removal handler
// (DELETE /sub-assembly/:id/part/:assetId) so it's directly unit-testable
// against an in-memory DB rather than only reachable through an HTTP
// round-trip, same rationale as services/subAssemblyTree.ts's cycle guard.
export function returnAssetToUngroupedIfOrphaned(
  db: Database.Database,
  projectId: string,
  assetId: string,
): void {
  const stillPlaced = db.prepare(
    `SELECT 1 FROM sub_assembly_parts p JOIN sub_assemblies sa ON sa.id = p.sub_assembly_id
     WHERE sa.project_id = ? AND p.asset_id = ?`
  ).get(projectId, assetId);
  if (stillPlaced) return;

  db.prepare(
    `INSERT OR IGNORE INTO project_assets (project_id, asset_id, sort_order, overrides_json)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_assets WHERE project_id = ?), '{}')`
  ).run(projectId, assetId, projectId);
}
