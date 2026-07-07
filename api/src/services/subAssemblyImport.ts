// Folder-tree import mapping — Bet 2 of the build manifest (migration v12
// tables already exist from Bet 1; no schema change needed here). See:
// Reports/sloane-prd-thefabvault-build-manifest-2026-07-06.md (folder-import
//   mapping section: ensureSubAssemblyPath, hash-check ordering, idempotency)
// Reports/reid-thefabvault-import-ux-2026-07-07.md (the screen this backs)
//
// ensureSubAssemblyPath is a direct port of mountImport.ts's
// ensureFolderPath — same shape (walk path segments, find-by-name-under-
// parent-or-create), scoped to a project's sub_assemblies tree instead of
// the global folders tree. Written once here so both the single-file
// import endpoint and any future caller share it, per the PRD's explicit
// "write it once, mirror the existing function's shape" instruction.

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';

// The ONE normalization rule for matching a folder-import path segment (or
// a manually-typed sub-assembly name) against an existing sub_assemblies
// row: trim only, case-sensitive otherwise. This mirrors the trim already
// applied to manually-created names (routes/subAssemblies.ts's
// `name.trim()` on POST /project/:id/sub-assemblies) and mountImport.ts's
// ensureFolderPath (which does no extra normalization beyond what a path
// segment already is).
//
// IMPORTANT — this rule is duplicated, not shared, on the client at
// web/src/lib/pathSegments.ts's normalizeSegmentName(). There is no
// monorepo/workspace linking api/ and web/ in this repo (they are two
// independent npm projects — see api/package.json vs web/package.json,
// no root package.json ties them together), so a literal shared import
// isn't available without introducing new build tooling for one trivial
// function. Both copies are intentionally kept to this exact one-line
// body and are pinned by mirrored unit tests on both sides
// (subAssemblyImport.test.ts here, pathSegments.test.ts in web/) — if this
// rule ever grows past a single trim(), move it into a real shared
// package instead of letting two copies drift.
export function normalizeSegmentName(name: string): string {
  return name.trim();
}

// Walks `segments` (already split, already trimmed of the picked folder's
// own root segment and the filename — see web/src/lib/pathSegments.ts)
// under `rootParentId`, finding-or-creating each level by
// (project_id, parent_id, name) exactly like ensureFolderPath.
//
// Returns the leaf sub_assembly id, OR `rootParentId` unchanged when
// `segments` is empty (a file with no subfolder lands directly on whatever
// node the import was targeted at), OR `null` when `rootParentId` is also
// null (a flat import at project root with no folder structure — the file
// belongs in the ungrouped project_assets pool, not the manifest; see
// placeAssetInManifest below).
//
// Idempotent: re-running the same import finds the existing node by
// name-under-parent instead of inserting a duplicate, same guarantee the
// PRD requires of ensureFolderPath today.
//
// `createdIds`, if passed, is mutated in place with the id of every node
// actually INSERTed by this call (0-N — a single call can create several
// levels of a brand-new branch at once). Optional out-param rather than a
// changed return shape so direct callers/tests that only care about the
// leaf id are unaffected; resolveAndPlace below is the one caller that
// needs it, to let the Commit UI show a live "N of M sub-assemblies
// created" count (Reid's UX spec, section 6.3) without the client having
// to guess which of its calls happened to be the one that created a node.
export function ensureSubAssemblyPath(
  db: Database.Database,
  projectId: string,
  rootParentId: string | null,
  segments: string[],
  createdIds?: string[],
): string | null {
  let parentId: string | null = rootParentId;

  for (const rawSegment of segments) {
    const name = normalizeSegmentName(rawSegment);
    if (!name) continue; // defensive — a blank segment never creates a blank-named node

    // `parent_id IS ?` (not `=`) so this matches top-level siblings
    // correctly when parentId is NULL — SQLite's `=` never matches NULL.
    const existing = db.prepare(
      'SELECT id FROM sub_assemblies WHERE project_id = ? AND name = ? AND parent_id IS ?'
    ).get(projectId, name, parentId) as { id: string } | undefined;

    if (existing) {
      parentId = existing.id;
    } else {
      const id = uuidv4();
      db.prepare(
        `INSERT INTO sub_assemblies (id, project_id, parent_id, name, sort_order)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sub_assemblies
                               WHERE project_id = ? AND parent_id IS ?))`
      ).run(id, projectId, parentId, name, projectId, parentId);
      parentId = id;
      createdIds?.push(id);
    }
  }

  return parentId;
}

// Places one asset at the resolved landing spot: a manifest placement when
// `subAssemblyId` is a real node, or the ungrouped project_assets pool when
// it's null (only reachable when a flat, no-subfolder import runs at
// project root — see ensureSubAssemblyPath's return contract above).
//
// Mirrors routes/subAssemblies.ts's POST /sub-assembly/:id/parts exactly
// for the manifest-placement branch (INSERT OR IGNORE against the
// (sub_assembly_id, asset_id) PK, quantity always 1 per Aaron's locked
// decision, remove any stray project_assets row for the same asset) so a
// second run of the same import is a no-op rather than a duplicate. The
// ungrouped branch mirrors routes/projects.ts's POST /project/:id/assets
// insert shape the same way.
export function placeAssetInManifest(
  db: Database.Database,
  projectId: string,
  subAssemblyId: string | null,
  assetId: string,
): void {
  if (subAssemblyId === null) {
    db.prepare(
      `INSERT OR IGNORE INTO project_assets (project_id, asset_id, sort_order, overrides_json)
       VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_assets WHERE project_id = ?), '{}')`
    ).run(projectId, assetId, projectId);
    return;
  }

  db.prepare(
    `INSERT OR IGNORE INTO sub_assembly_parts
       (sub_assembly_id, asset_id, quantity, printed_count, sort_order, overrides_json)
     VALUES (?, ?, 1, 0, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sub_assembly_parts
                          WHERE sub_assembly_id = ?), '{}')`
  ).run(subAssemblyId, assetId, subAssemblyId);

  // Placing a file into the manifest means it's no longer "ungrouped" —
  // same PRD boundary-rule enforcement as the manual add-parts route.
  db.prepare('DELETE FROM project_assets WHERE project_id = ? AND asset_id = ?').run(projectId, assetId);
}

// Resolves the folder-tree path AND places the asset in one transaction —
// used by both import endpoints (routes/manifestImport.ts) so a crash
// between "create the sub-assembly node" and "place the part in it" can
// never leave a phantom empty node with no way to reach the asset that was
// supposed to land there. (The asset row itself, for a genuinely-new
// upload, is written by saveUploadedFile just before this runs — that part
// is not wrapped in the same transaction, matching the existing upload
// path's tolerance for "asset exists in the vault but isn't yet placed
// anywhere" as a recoverable, re-scan-idempotent state rather than a
// stranded one. See routes/manifestImport.ts for the full reasoning.)
export interface ResolveAndPlaceResult {
  subAssemblyId: string | null;
  // Ids of any sub-assembly nodes newly created while resolving this
  // file's path — empty when every level along the path already existed
  // (the common case for the 2nd+ file landing in an already-created node).
  createdSubAssemblyIds: string[];
}

export function resolveAndPlace(
  db: Database.Database,
  projectId: string,
  rootParentId: string | null,
  segments: string[],
  assetId: string,
): ResolveAndPlaceResult {
  return db.transaction(() => {
    const createdSubAssemblyIds: string[] = [];
    const subAssemblyId = ensureSubAssemblyPath(db, projectId, rootParentId, segments, createdSubAssemblyIds);
    placeAssetInManifest(db, projectId, subAssemblyId, assetId);
    return { subAssemblyId, createdSubAssemblyIds };
  })();
}
