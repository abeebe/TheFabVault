// Tests for the folder-tree import mapping (services/subAssemblyImport.ts)
// — Bet 2 of the build manifest. Covers the three cases Reid's UX spec and
// Sloane's PRD flag as most likely to break in a first pass:
//   1. nested-path idempotency (ensureSubAssemblyPath creates each node
//      once, reuses it on a second import of the same tree)
//   2. the ungrouped/organized boundary rule holds for placements created
//      by import, same as the manual add-parts route
//   3. same-batch dedup — two files with the same hash resolve to one
//      asset, two placements (never two assets)

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  normalizeSegmentName, ensureSubAssemblyPath, placeAssetInManifest, resolveAndPlace,
} from '../services/subAssemblyImport.js';

// Minimal in-memory schema mirroring migration v12 + the tables it
// references, same pattern as manifestRollup.test.ts / subAssemblyTree.test.ts.
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

function makeAsset(db: Database.Database, filename = 'part.stl'): string {
  const id = uuidv4();
  db.prepare('INSERT INTO assets (id, filename) VALUES (?, ?)').run(id, filename);
  return id;
}

function subAssembly(db: Database.Database, id: string): { name: string; parent_id: string | null } {
  return db.prepare('SELECT name, parent_id FROM sub_assemblies WHERE id = ?').get(id) as
    { name: string; parent_id: string | null };
}

function countSubAssemblies(db: Database.Database, projectId: string): number {
  return (db.prepare('SELECT COUNT(*) as n FROM sub_assemblies WHERE project_id = ?').get(projectId) as { n: number }).n;
}

describe('normalizeSegmentName', () => {
  it('trims leading/trailing whitespace and nothing else', () => {
    expect(normalizeSegmentName('  Right Foot  ')).toBe('Right Foot');
    expect(normalizeSegmentName('Right Foot')).toBe('Right Foot');
    // Case-sensitive by design — mirrors mountImport.ts's ensureFolderPath,
    // which does no case normalization either.
    expect(normalizeSegmentName('right foot')).toBe('right foot');
  });
});

describe('ensureSubAssemblyPath', () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    db = makeDb();
    projectId = makeProject(db);
  });

  it('creates a single-level path under project root', () => {
    const leafId = ensureSubAssemblyPath(db, projectId, null, ['Right Foot']);
    expect(leafId).toBeTruthy();
    expect(subAssembly(db, leafId!)).toEqual({ name: 'Right Foot', parent_id: null });
    expect(countSubAssemblies(db, projectId)).toBe(1);
  });

  it('creates a multi-level nested path in one call (Dome/Dome Ring)', () => {
    const leafId = ensureSubAssemblyPath(db, projectId, null, ['Dome', 'Dome Ring']);
    expect(leafId).toBeTruthy();
    const leaf = subAssembly(db, leafId!);
    expect(leaf.name).toBe('Dome Ring');
    const parent = subAssembly(db, leaf.parent_id!);
    expect(parent).toEqual({ name: 'Dome', parent_id: null });
    expect(countSubAssemblies(db, projectId)).toBe(2);
  });

  it('is idempotent — re-running the same path reuses existing nodes instead of duplicating them', () => {
    const first = ensureSubAssemblyPath(db, projectId, null, ['Dome', 'Dome Ring']);
    const second = ensureSubAssemblyPath(db, projectId, null, ['Dome', 'Dome Ring']);
    expect(second).toBe(first);
    expect(countSubAssemblies(db, projectId)).toBe(2); // still just Dome + Dome Ring, not 4
  });

  it('two different leaves sharing a common ancestor reuse that ancestor once', () => {
    // Right Foot/Greeble and Left Foot/Greeble share no ancestor, but
    // Dome/Ring and Dome/Vents do — confirms the find-or-create per level
    // doesn't re-create "Dome" a second time for the second path.
    const ring = ensureSubAssemblyPath(db, projectId, null, ['Dome', 'Ring']);
    const vents = ensureSubAssemblyPath(db, projectId, null, ['Dome', 'Vents']);
    expect(ring).not.toBe(vents);
    const ringParent = subAssembly(db, ring!).parent_id;
    const ventsParent = subAssembly(db, vents!).parent_id;
    expect(ringParent).toBe(ventsParent);
    expect(countSubAssemblies(db, projectId)).toBe(3); // Dome, Ring, Vents
  });

  it('an empty segments array returns rootParentId unchanged (file lands directly on the target node)', () => {
    expect(ensureSubAssemblyPath(db, projectId, null, [])).toBeNull();
    const existingNode = ensureSubAssemblyPath(db, projectId, null, ['Dome']);
    expect(ensureSubAssemblyPath(db, projectId, existingNode, [])).toBe(existingNode);
    expect(countSubAssemblies(db, projectId)).toBe(1); // no phantom node created for the empty path
  });

  it('scopes an import under a specific rootParentId (drilled-in import target) rather than project root', () => {
    const dome = ensureSubAssemblyPath(db, projectId, null, ['Dome']);
    const ring = ensureSubAssemblyPath(db, projectId, dome, ['Dome Ring']);
    expect(subAssembly(db, ring!)).toEqual({ name: 'Dome Ring', parent_id: dome });
  });

  it('trims whitespace on incoming segments before matching/creating', () => {
    const a = ensureSubAssemblyPath(db, projectId, null, ['Right Foot']);
    const b = ensureSubAssemblyPath(db, projectId, null, ['  Right Foot  ']);
    expect(b).toBe(a); // same node, not a second "  Right Foot  " sibling
  });

  it('merges a re-import into an already-existing manually-created sub-assembly by name+parent', () => {
    // Simulates Aaron manually creating "Right Foot" first (same insert
    // shape routes/subAssemblies.ts's POST uses — name.trim()), then
    // importing a folder tree that also has a Right Foot/ directory.
    const manualId = uuidv4();
    db.prepare(
      `INSERT INTO sub_assemblies (id, project_id, parent_id, name) VALUES (?, ?, NULL, ?)`
    ).run(manualId, projectId, 'Right Foot');

    const importedId = ensureSubAssemblyPath(db, projectId, null, ['Right Foot']);
    expect(importedId).toBe(manualId);
    expect(countSubAssemblies(db, projectId)).toBe(1);
  });
});

describe('placeAssetInManifest', () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    db = makeDb();
    projectId = makeProject(db);
  });

  it('creates a placement and removes any existing ungrouped row for the same asset', () => {
    const sa = ensureSubAssemblyPath(db, projectId, null, ['Right Foot'])!;
    const asset = makeAsset(db);
    db.prepare(
      `INSERT INTO project_assets (project_id, asset_id) VALUES (?, ?)`
    ).run(projectId, asset);

    placeAssetInManifest(db, projectId, sa, asset);

    const placement = db.prepare(
      'SELECT * FROM sub_assembly_parts WHERE sub_assembly_id = ? AND asset_id = ?'
    ).get(sa, asset) as { quantity: number; printed_count: number } | undefined;
    expect(placement).toEqual(expect.objectContaining({ quantity: 1, printed_count: 0 }));

    const ungrouped = db.prepare(
      'SELECT * FROM project_assets WHERE project_id = ? AND asset_id = ?'
    ).get(projectId, asset);
    expect(ungrouped).toBeUndefined();
  });

  it('lands a file with no target sub-assembly in the ungrouped pool (flat root import)', () => {
    const asset = makeAsset(db);
    placeAssetInManifest(db, projectId, null, asset);

    const ungrouped = db.prepare(
      'SELECT * FROM project_assets WHERE project_id = ? AND asset_id = ?'
    ).get(projectId, asset);
    expect(ungrouped).toBeTruthy();
    const placementCount = (db.prepare('SELECT COUNT(*) as n FROM sub_assembly_parts').get() as { n: number }).n;
    expect(placementCount).toBe(0);
  });

  it('is idempotent — placing the same asset in the same node twice does not duplicate the placement', () => {
    const sa = ensureSubAssemblyPath(db, projectId, null, ['Dome'])!;
    const asset = makeAsset(db);
    placeAssetInManifest(db, projectId, sa, asset);
    placeAssetInManifest(db, projectId, sa, asset);

    const rows = db.prepare(
      'SELECT * FROM sub_assembly_parts WHERE sub_assembly_id = ? AND asset_id = ?'
    ).all(sa, asset);
    expect(rows.length).toBe(1);
  });

  it('a shared asset can be placed in two different sub-assemblies (links, not copies)', () => {
    const rightFoot = ensureSubAssemblyPath(db, projectId, null, ['Right Foot'])!;
    const leftFoot = ensureSubAssemblyPath(db, projectId, null, ['Left Foot'])!;
    const greeble = makeAsset(db, 'greeble.stl');

    placeAssetInManifest(db, projectId, rightFoot, greeble);
    placeAssetInManifest(db, projectId, leftFoot, greeble);

    const placements = db.prepare('SELECT sub_assembly_id FROM sub_assembly_parts WHERE asset_id = ?').all(greeble);
    expect(placements.length).toBe(2); // one physical asset row, two independent placements

    const assetCount = (db.prepare('SELECT COUNT(*) as n FROM assets').get() as { n: number }).n;
    expect(assetCount).toBe(1); // never duplicated as a second asset row
  });
});

describe('resolveAndPlace — same-batch dedup end-to-end (the core Bet 2 behavioral delta)', () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    db = makeDb();
    projectId = makeProject(db);
  });

  it('two files with an identical hash resolve to ONE asset and TWO placements, not two assets', () => {
    // Simulates the PRD's own example: a greeble physically duplicated in
    // Right Foot/ and Left Foot/, neither copy in the vault yet at scan
    // time. The client uploads the first occurrence once (creating the
    // asset), then calls link-existing for the second occurrence against
    // that same asset id — this test exercises exactly that server-side
    // sequence via resolveAndPlace, without going through HTTP.
    const sharedAsset = makeAsset(db, 'greeble.stl');

    const first = resolveAndPlace(db, projectId, null, ['Right Foot'], sharedAsset);
    const second = resolveAndPlace(db, projectId, null, ['Left Foot'], sharedAsset);

    expect(first.subAssemblyId).not.toBe(second.subAssemblyId);
    // Both calls created a brand-new node — Right Foot didn't exist before
    // the first call, Left Foot didn't exist before the second.
    expect(first.createdSubAssemblyIds).toEqual([first.subAssemblyId]);
    expect(second.createdSubAssemblyIds).toEqual([second.subAssemblyId]);

    const assetCount = (db.prepare('SELECT COUNT(*) as n FROM assets').get() as { n: number }).n;
    expect(assetCount).toBe(1);

    const placementCount = (db.prepare('SELECT COUNT(*) as n FROM sub_assembly_parts WHERE asset_id = ?').get(sharedAsset) as { n: number }).n;
    expect(placementCount).toBe(2);

    expect(countSubAssemblies(db, projectId)).toBe(2); // Right Foot + Left Foot, both real nodes
  });

  it('a full re-import of the same tree is a no-op beyond the first run (idempotency across the whole path+place sequence)', () => {
    const asset = makeAsset(db);
    const run1 = resolveAndPlace(db, projectId, null, ['Dome', 'Dome Ring'], asset);
    const run2 = resolveAndPlace(db, projectId, null, ['Dome', 'Dome Ring'], asset);
    const run3 = resolveAndPlace(db, projectId, null, ['Dome', 'Dome Ring'], asset);

    expect(countSubAssemblies(db, projectId)).toBe(2); // Dome, Dome Ring — not 6
    const placementCount = (db.prepare('SELECT COUNT(*) as n FROM sub_assembly_parts').get() as { n: number }).n;
    expect(placementCount).toBe(1);

    // Only the FIRST run created anything — Dome + Dome Ring, both new.
    // Re-running (idempotent re-import) creates nothing further.
    expect(run1.createdSubAssemblyIds.length).toBe(2);
    expect(run2.createdSubAssemblyIds).toEqual([]);
    expect(run3.createdSubAssemblyIds).toEqual([]);
  });

  it('reports only the newly-created levels when a path partially overlaps an existing branch', () => {
    // Dome already exists (created by an earlier file); this file adds a
    // brand-new "Vents" child under it. createdSubAssemblyIds should list
    // only Vents, not Dome (Dome already existed).
    const domeOnly = resolveAndPlace(db, projectId, null, ['Dome'], makeAsset(db));
    expect(domeOnly.createdSubAssemblyIds.length).toBe(1);

    const domeVents = resolveAndPlace(db, projectId, null, ['Dome', 'Vents'], makeAsset(db));
    expect(domeVents.createdSubAssemblyIds.length).toBe(1);
    expect(domeVents.createdSubAssemblyIds[0]).toBe(domeVents.subAssemblyId);
  });
});
