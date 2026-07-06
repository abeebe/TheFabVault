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
       )
       SELECT c.ancestor_id AS sub_assembly_id,
              COALESCE(SUM(p.quantity), 0) AS needed,
              COALESCE(SUM(MIN(p.printed_count, p.quantity)), 0) AS done
       FROM closure c
       LEFT JOIN sub_assembly_parts p ON p.sub_assembly_id = c.descendant_id
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
       WHERE sa.project_id = ?`
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
              COALESCE(SUM(p.quantity), 0) AS needed,
              COALESCE(SUM(MIN(p.printed_count, p.quantity)), 0) AS done
       FROM sub_assemblies sa
       LEFT JOIN sub_assembly_parts p ON p.sub_assembly_id = sa.id
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

// All sub_assembly ids in a subtree, self included — used by the delete
// path to know which placements are about to be cascade-deleted before
// they're gone, so the affected assets can be evaluated for return to the
// ungrouped pool.
export function getSubtreeIds(db: Database.Database, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION ALL
         SELECT sa.id FROM subtree s JOIN sub_assemblies sa ON sa.parent_id = s.id
       )
       SELECT id FROM subtree`
    )
    .all(rootId) as { id: string }[];
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
