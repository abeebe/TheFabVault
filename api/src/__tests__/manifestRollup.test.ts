// Tests for the build-manifest recursive rollup (services/manifestRollup.ts)
// and the sub-assembly reparent cycle guard (routes/subAssemblies.ts).
//
// These are the two places Sage's QA note in the PRD specifically flags as
// most likely to have an off-by-one in a first pass: the rollup math against
// a constructed multi-level tree with a shared part across two branches, and
// the ungrouped/organized boundary rule on delete/remove.

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  getSubAssemblyRollups, getProjectRollupTotal, getAllProjectRollups,
  getSingleProjectManifestInfo, getSubtreeIds, returnAssetToUngroupedIfOrphaned,
  getUngroupedCount, getAllUngroupedCounts,
} from '../services/manifestRollup.js';

// Minimal in-memory schema — just the tables these tests touch, mirroring
// the real migration v12 SQL in db.ts exactly (same columns, same
// constraints) plus the handful of upstream tables it references.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE assets (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL
    );
    CREATE TABLE project_assets (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (project_id, asset_id)
    );
    CREATE TABLE sub_assemblies (
      id         TEXT    PRIMARY KEY,
      project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id  TEXT    REFERENCES sub_assemblies(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE sub_assembly_parts (
      sub_assembly_id TEXT    NOT NULL REFERENCES sub_assemblies(id) ON DELETE CASCADE,
      asset_id        TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      quantity        INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
      printed_count   INTEGER NOT NULL DEFAULT 0 CHECK(printed_count >= 0),
      sort_order      INTEGER NOT NULL DEFAULT 0,
      overrides_json  TEXT    NOT NULL DEFAULT '{}',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (sub_assembly_id, asset_id)
    );
  `);
  return db;
}

function makeProject(db: Database.Database, name = 'R2D2'): string {
  const id = uuidv4();
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
  return id;
}

function makeSubAssembly(db: Database.Database, projectId: string, name: string, parentId: string | null = null): string {
  const id = uuidv4();
  db.prepare('INSERT INTO sub_assemblies (id, project_id, parent_id, name) VALUES (?, ?, ?, ?)')
    .run(id, projectId, parentId, name);
  return id;
}

function makeAsset(db: Database.Database, filename = 'part.stl'): string {
  const id = uuidv4();
  db.prepare('INSERT INTO assets (id, filename) VALUES (?, ?)').run(id, filename);
  return id;
}

function placePart(
  db: Database.Database, subAssemblyId: string, assetId: string,
  quantity: number, printedCount: number,
): void {
  db.prepare(
    `INSERT INTO sub_assembly_parts (sub_assembly_id, asset_id, quantity, printed_count)
     VALUES (?, ?, ?, ?)`
  ).run(subAssemblyId, assetId, quantity, printedCount);
}

function trashAsset(db: Database.Database, assetId: string): void {
  db.prepare('UPDATE assets SET deleted_at = unixepoch() WHERE id = ?').run(assetId);
}

function placeUngrouped(db: Database.Database, projectId: string, assetId: string): void {
  db.prepare(
    `INSERT INTO project_assets (project_id, asset_id, sort_order, overrides_json)
     VALUES (?, ?, 0, '{}')`
  ).run(projectId, assetId);
}

describe('getSubAssemblyRollups — recursive bottom-up progress', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it('rolls up a single leaf node with its own direct parts', () => {
    const projectId = makeProject(db);
    const rightFoot = makeSubAssembly(db, projectId, 'Right Foot');
    const a1 = makeAsset(db);
    const a2 = makeAsset(db);
    placePart(db, rightFoot, a1, 3, 3);
    placePart(db, rightFoot, a2, 2, 1);

    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(rightFoot)).toEqual({ needed: 5, done: 4, percent: 80 });
  });

  it('folds a child sub-assembly\'s rollup into its parent (multi-level nesting)', () => {
    // R2D2 > Leg > Foot > (parts). Leg's own rollup should include Foot's
    // parts even though Leg itself has zero direct parts.
    const projectId = makeProject(db);
    const leg = makeSubAssembly(db, projectId, 'Leg');
    const foot = makeSubAssembly(db, projectId, 'Foot', leg);
    const ankle = makeSubAssembly(db, projectId, 'Ankle', foot);

    const legPart = makeAsset(db);
    const footPart = makeAsset(db);
    const anklePart = makeAsset(db);
    placePart(db, leg, legPart, 2, 2);       // direct on Leg
    placePart(db, foot, footPart, 4, 2);      // direct on Foot (child of Leg)
    placePart(db, ankle, anklePart, 1, 0);    // direct on Ankle (grandchild of Leg)

    const rollups = getSubAssemblyRollups(db, projectId);

    // Leaf-most node only sees its own parts.
    expect(rollups.get(ankle)).toEqual({ needed: 1, done: 0, percent: 0 });
    // Foot folds in Ankle's rollup plus its own direct parts.
    expect(rollups.get(foot)).toEqual({ needed: 5, done: 2, percent: 40 });
    // Leg folds in Foot's already-folded rollup (which itself includes
    // Ankle) plus Leg's own direct parts: 2+4+1=7 needed, 2+2+0=4 done.
    expect(rollups.get(leg)).toEqual({ needed: 7, done: 4, percent: 57 });
  });

  it('does not double- or cross-count a shared asset placed in two separate branches', () => {
    // The PRD's central case: one STL (a greeble), placed at quantity 6 in
    // both Right Foot and Left Foot. Printing the right foot's greebles
    // must not move the left foot's counter, and the project total must
    // show 12 needed (two independent physical print jobs), not 6.
    const projectId = makeProject(db);
    const rightFoot = makeSubAssembly(db, projectId, 'Right Foot');
    const leftFoot = makeSubAssembly(db, projectId, 'Left Foot');
    const greeble = makeAsset(db, 'greeble.stl');

    placePart(db, rightFoot, greeble, 6, 6); // right foot's greebles: all printed
    placePart(db, leftFoot, greeble, 6, 0);  // left foot's greebles: none printed yet

    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(rightFoot)).toEqual({ needed: 6, done: 6, percent: 100 });
    expect(rollups.get(leftFoot)).toEqual({ needed: 6, done: 0, percent: 0 });

    const total = getProjectRollupTotal(db, projectId);
    expect(total).toEqual({ needed: 12, done: 6, percent: 50 });
  });

  it('clamps a placement\'s contribution at 100% even when printed_count exceeds quantity (reprints)', () => {
    const projectId = makeProject(db);
    const sa = makeSubAssembly(db, projectId, 'Dome');
    const asset = makeAsset(db);
    // Printed 7 of a part that only needed 6 (a reprint after a failed print).
    placePart(db, sa, asset, 6, 7);

    const rollups = getSubAssemblyRollups(db, projectId);
    // done is clamped to quantity (6), not the raw printed_count (7) —
    // the rollup can never show over 100% for one placement.
    expect(rollups.get(sa)).toEqual({ needed: 6, done: 6, percent: 100 });
  });

  it('returns percent: null (not 0) for a node with zero parts placed anywhere in its subtree', () => {
    const projectId = makeProject(db);
    const empty = makeSubAssembly(db, projectId, 'Freshly Created');
    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(empty)).toEqual({ needed: 0, done: 0, percent: null });
  });

  it('rounds the percent to the nearest whole number', () => {
    const projectId = makeProject(db);
    const sa = makeSubAssembly(db, projectId, 'Odd Fraction');
    const asset = makeAsset(db);
    placePart(db, sa, asset, 3, 1); // 33.33...%
    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(sa)?.percent).toBe(33);
  });
});

describe('getAllProjectRollups / getSingleProjectManifestInfo — hasManifest signal', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('a project with zero sub_assemblies rows has no entry in the batched map (hasManifest === false)', () => {
    const projectId = makeProject(db);
    const rollups = getAllProjectRollups(db);
    expect(rollups.has(projectId)).toBe(false);

    const info = getSingleProjectManifestInfo(db, projectId);
    expect(info).toEqual({ hasManifest: false, manifestPercent: null });
  });

  it('a project with a sub-assembly but zero placed parts has hasManifest true and percent null', () => {
    const projectId = makeProject(db);
    makeSubAssembly(db, projectId, 'Right Foot');

    const info = getSingleProjectManifestInfo(db, projectId);
    expect(info).toEqual({ hasManifest: true, manifestPercent: null });

    const rollups = getAllProjectRollups(db);
    expect(rollups.get(projectId)).toEqual({ needed: 0, done: 0, percent: null });
  });

  it('sums across multiple top-level sub-assemblies for the project total', () => {
    const projectId = makeProject(db);
    const rightFoot = makeSubAssembly(db, projectId, 'Right Foot');
    const leftFoot = makeSubAssembly(db, projectId, 'Left Foot');
    placePart(db, rightFoot, makeAsset(db), 10, 5);
    placePart(db, leftFoot, makeAsset(db), 10, 10);

    const info = getSingleProjectManifestInfo(db, projectId);
    expect(info).toEqual({ hasManifest: true, manifestPercent: 75 });
  });
});

describe('getSubtreeIds', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('includes the root and every descendant at every depth', () => {
    const projectId = makeProject(db);
    const leg = makeSubAssembly(db, projectId, 'Leg');
    const foot = makeSubAssembly(db, projectId, 'Foot', leg);
    const ankle = makeSubAssembly(db, projectId, 'Ankle', foot);
    // Sibling branch that should NOT be included.
    const otherBranch = makeSubAssembly(db, projectId, 'Dome');

    const ids = getSubtreeIds(db, leg);
    expect(new Set(ids)).toEqual(new Set([leg, foot, ankle]));
    expect(ids).not.toContain(otherBranch);
  });

  it('a leaf node\'s subtree is just itself', () => {
    const projectId = makeProject(db);
    const leaf = makeSubAssembly(db, projectId, 'Leaf');
    expect(getSubtreeIds(db, leaf)).toEqual([leaf]);
  });

  // Defensive-depth-cap fold-in (#2175 closing-api review): same
  // unbounded-cycle risk as services/modelConvert.ts's
  // getRecursiveFolderIds (sub_assemblies.parent_id is structurally
  // identical to folders.parent_id, and validateReparent guards only the
  // normal reparent mutation path, not the schema). Hand-built cycle,
  // bypassing that guard entirely, same reproduction method as the
  // folders-side test — this is the regression guard: must terminate
  // fast with a bounded result, not hang the process.
  it('terminates fast and returns a bounded set on a cyclic parent_id, instead of hanging', () => {
    const projectId = makeProject(db);
    const a = makeSubAssembly(db, projectId, 'A');
    const b = makeSubAssembly(db, projectId, 'B', a);
    // Hand-built cycle: A's parent_id now points at B, so A -> B -> A.
    db.prepare('UPDATE sub_assemblies SET parent_id = ? WHERE id = ?').run(b, a);

    const start = Date.now();
    const ids = getSubtreeIds(db, a);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(ids.length).toBeLessThanOrEqual(101);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([a, b]));
  });
});

describe('returnAssetToUngroupedIfOrphaned — boundary rule on single-part removal (Remy review fix)', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('re-inserts a project_assets row when the asset has zero remaining placements', () => {
    const projectId = makeProject(db);
    makeSubAssembly(db, projectId, 'Right Foot');
    const asset = makeAsset(db);
    // Caller runs the placement DELETE first; by the time this is called
    // the asset has no rows left in sub_assembly_parts for this project.

    returnAssetToUngroupedIfOrphaned(db, projectId, asset);

    const row = db.prepare('SELECT * FROM project_assets WHERE project_id = ? AND asset_id = ?')
      .get(projectId, asset);
    expect(row).toBeTruthy();
  });

  it('does NOT re-insert when the asset is still placed in a sibling sub-assembly', () => {
    const projectId = makeProject(db);
    const leftFoot = makeSubAssembly(db, projectId, 'Left Foot');
    const greeble = makeAsset(db, 'greeble.stl');
    // The Right Foot placement was just removed by the caller, but the
    // same shared part is still placed in Left Foot.
    placePart(db, leftFoot, greeble, 6, 0);

    returnAssetToUngroupedIfOrphaned(db, projectId, greeble);

    const row = db.prepare('SELECT * FROM project_assets WHERE project_id = ? AND asset_id = ?')
      .get(projectId, greeble);
    expect(row).toBeUndefined();
  });

  it('is idempotent (INSERT OR IGNORE) when called twice for the same orphaned asset', () => {
    const projectId = makeProject(db);
    const asset = makeAsset(db);

    returnAssetToUngroupedIfOrphaned(db, projectId, asset);
    returnAssetToUngroupedIfOrphaned(db, projectId, asset);

    const rows = db.prepare('SELECT * FROM project_assets WHERE project_id = ? AND asset_id = ?')
      .all(projectId, asset);
    expect(rows.length).toBe(1);
  });
});

describe('#2027 — trashed-but-placed assets drop out of rollups and ungrouped counts', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('getSubAssemblyRollups excludes a placement whose asset was soft-deleted', () => {
    const projectId = makeProject(db);
    const sa = makeSubAssembly(db, projectId, 'Dome');
    const live = makeAsset(db, 'live.stl');
    const trashed = makeAsset(db, 'trashed.stl');
    placePart(db, sa, live, 3, 3);
    placePart(db, sa, trashed, 5, 5); // would double the total if counted

    trashAsset(db, trashed);

    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(sa)).toEqual({ needed: 3, done: 3, percent: 100 });
  });

  it('getSubAssemblyRollups still returns a zero row for a sub-assembly whose only placements are all trashed', () => {
    const projectId = makeProject(db);
    const sa = makeSubAssembly(db, projectId, 'Dome');
    const trashed = makeAsset(db);
    placePart(db, sa, trashed, 5, 5);
    trashAsset(db, trashed);

    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(sa)).toEqual({ needed: 0, done: 0, percent: null });
  });

  it('a trashed placement in a child sub-assembly does not leak into the parent rollup', () => {
    const projectId = makeProject(db);
    const leg = makeSubAssembly(db, projectId, 'Leg');
    const foot = makeSubAssembly(db, projectId, 'Foot', leg);
    const legPart = makeAsset(db);
    const trashedFootPart = makeAsset(db);
    placePart(db, leg, legPart, 2, 2);
    placePart(db, foot, trashedFootPart, 10, 0);
    trashAsset(db, trashedFootPart);

    const rollups = getSubAssemblyRollups(db, projectId);
    expect(rollups.get(foot)).toEqual({ needed: 0, done: 0, percent: null });
    expect(rollups.get(leg)).toEqual({ needed: 2, done: 2, percent: 100 });
  });

  it('getProjectRollupTotal excludes a trashed placement from the project-level total', () => {
    const projectId = makeProject(db);
    const sa = makeSubAssembly(db, projectId, 'Dome');
    const live = makeAsset(db);
    const trashed = makeAsset(db);
    placePart(db, sa, live, 4, 2);
    placePart(db, sa, trashed, 6, 6);
    trashAsset(db, trashed);

    expect(getProjectRollupTotal(db, projectId)).toEqual({ needed: 4, done: 2, percent: 50 });
  });

  it('getAllProjectRollups excludes a trashed placement from the batched map, but still lists the project', () => {
    const projectId = makeProject(db);
    const sa = makeSubAssembly(db, projectId, 'Dome');
    const trashed = makeAsset(db);
    placePart(db, sa, trashed, 6, 6);
    trashAsset(db, trashed);

    const rollups = getAllProjectRollups(db);
    // hasManifest is still true (a sub_assembly row exists) even though
    // every one of its placements is trashed.
    expect(rollups.get(projectId)).toEqual({ needed: 0, done: 0, percent: null });
  });

  it('getUngroupedCount excludes a trashed asset sitting in the ungrouped pool', () => {
    const projectId = makeProject(db);
    const live = makeAsset(db);
    const trashed = makeAsset(db);
    placeUngrouped(db, projectId, live);
    placeUngrouped(db, projectId, trashed);
    trashAsset(db, trashed);

    expect(getUngroupedCount(db, projectId)).toBe(1);
  });

  it('getAllUngroupedCounts excludes trashed assets across the batched map', () => {
    const projectId = makeProject(db);
    const otherProject = makeProject(db, 'Other');
    const live = makeAsset(db);
    const trashed = makeAsset(db);
    placeUngrouped(db, projectId, live);
    placeUngrouped(db, projectId, trashed);
    trashAsset(db, trashed);
    placeUngrouped(db, otherProject, makeAsset(db));

    const counts = getAllUngroupedCounts(db);
    expect(counts.get(projectId)).toBe(1);
    expect(counts.get(otherProject)).toBe(1);
  });

  it('a project whose only ungrouped asset is trashed has no entry in the batched map (not zero, absent)', () => {
    const projectId = makeProject(db);
    const trashed = makeAsset(db);
    placeUngrouped(db, projectId, trashed);
    trashAsset(db, trashed);

    const counts = getAllUngroupedCounts(db);
    expect(counts.has(projectId)).toBe(false);
  });
});
