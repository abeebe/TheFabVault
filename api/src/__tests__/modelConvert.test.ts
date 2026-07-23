// Tests for the folder->model conversion planner (services/modelConvert.ts,
// #2155) and its #2175 recursive-tree helpers. Two halves, two testing
// shapes: the classifier is a pure function, no DB/filesystem — same
// shape as subAssemblyTree.test.ts's validateReparent. The recursive
// helpers touch the DB, so they get a minimal in-memory sqlite schema —
// same convention as manifestRollup.test.ts's makeDb (folders.parent_id
// is structurally identical to sub_assemblies.parent_id, the thing that
// file's WITH RECURSIVE tests already established this pattern for).

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  classifyExt, planFolderConversion, isBareGuidName,
  getRecursiveFolderIds, getRecursiveConvertibleAssets, getImmediateChildFolders,
  planEachChildConversion, type ConvertibleAsset,
} from '../services/modelConvert.js';

function asset(filename: string, thumbStatus: ConvertibleAsset['thumbStatus'] = 'none', id?: string): ConvertibleAsset {
  return { assetId: id ?? filename, filename, thumbStatus };
}

describe('classifyExt', () => {
  it.each([
    ['skull.stl', 'part'],
    ['base.STL', 'part'], // case-insensitive
    ['model.3mf', 'part'],
    ['part.obj', 'part'],
    ['resin.lys', 'part'],
    ['plate.ctb', 'part'],
    ['plate.photon', 'part'],
    ['photo.png', 'image'],
    ['photo.JPG', 'image'],
    ['photo.jpeg', 'image'],
    ['photo.webp', 'image'],
    ['readme.pdf', 'doc'],
    ['readme.txt', 'doc'],
    ['readme.md', 'doc'],
    ['unknown.zip', 'other'],
    ['no-extension', 'other'],
  ])('classifies %s as %s', (filename, expected) => {
    expect(classifyExt(filename)).toBe(expected);
  });
});

describe('planFolderConversion', () => {
  it('assigns roles per extension and sortOrder matching input order', () => {
    const assets = [
      asset('body.stl'),
      asset('cover.png'),
      asset('instructions.pdf'),
      asset('mystery.xyz'),
    ];
    const plan = planFolderConversion(assets);

    expect(plan.files).toEqual([
      { assetId: 'body.stl', role: 'part', sortOrder: 0 },
      { assetId: 'cover.png', role: 'image', sortOrder: 1 },
      { assetId: 'instructions.pdf', role: 'doc', sortOrder: 2 },
      { assetId: 'mystery.xyz', role: 'other', sortOrder: 3 },
    ]);
  });

  it('picks the first image asset as cover, even if it is not first in the folder', () => {
    const assets = [
      asset('body.stl'),
      asset('gallery-1.jpg'),
      asset('gallery-2.png'),
    ];
    const plan = planFolderConversion(assets);
    expect(plan.coverAssetId).toBe('gallery-1.jpg');
  });

  it('falls back to the first asset with thumb_status done when there is no image', () => {
    const assets = [
      asset('part-a.stl', 'pending'),
      asset('part-b.stl', 'done'),
      asset('part-c.stl', 'done'),
    ];
    const plan = planFolderConversion(assets);
    expect(plan.coverAssetId).toBe('part-b.stl');
  });

  it('cover is null when there is no image and nothing has a finished thumbnail', () => {
    const assets = [
      asset('part-a.stl', 'pending'),
      asset('part-b.stl', 'failed'),
      asset('notes.txt', 'none'),
    ];
    const plan = planFolderConversion(assets);
    expect(plan.coverAssetId).toBeNull();
  });

  it('returns an empty plan for an empty folder', () => {
    const plan = planFolderConversion([]);
    expect(plan.files).toEqual([]);
    expect(plan.coverAssetId).toBeNull();
  });

  it('is a pure function — the same input always produces the same output', () => {
    const assets = [asset('a.stl'), asset('b.png', 'done')];
    const first = planFolderConversion(assets);
    const second = planFolderConversion(assets);
    expect(first).toEqual(second);
  });
});

describe('isBareGuidName', () => {
  it.each([
    ['3f2a9c10-4b1e-4d9a-8c7f-1a2b3c4d5e6f', true],
    ['3F2A9C10-4B1E-4D9A-8C7F-1A2B3C4D5E6F', true], // case-insensitive
    ['  3f2a9c10-4b1e-4d9a-8c7f-1a2b3c4d5e6f  ', true], // trimmed
    ['Droidkyn', false],
    ['Circuit Master', false],
    ['3f2a9c10-4b1e-4d9a-8c7f-1a2b3c4d5e6f-extra', false], // trailing garbage
    ['not-a-guid-at-all', false],
    ['', false],
  ])('%s -> %s', (name, expected) => {
    expect(isBareGuidName(name)).toBe(expected);
  });
});

// ─── #2175 recursive-tree helpers — in-memory DB, same convention as
// manifestRollup.test.ts's makeDb (folders.parent_id mirrors
// sub_assemblies.parent_id structurally).
describe('recursive folder-tree helpers (#2175)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id)
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, folder_id TEXT REFERENCES folders(id),
        thumb_status TEXT NOT NULL DEFAULT 'none', deleted_at INTEGER
      );
    `);
  });

  function mkFolder(name: string, parentId: string | null = null): string {
    const id = uuidv4();
    db.prepare('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)').run(id, name, parentId);
    return id;
  }

  function mkAsset(folderId: string, filename: string, deleted = false): string {
    const id = uuidv4();
    db.prepare('INSERT INTO assets (id, filename, folder_id, deleted_at) VALUES (?, ?, ?, ?)')
      .run(id, filename, folderId, deleted ? 1 : null);
    return id;
  }

  it('getRecursiveFolderIds includes the root and every descendant, at any depth', () => {
    const root = mkFolder('Droidkyn');
    const child = mkFolder(uuidv4(), root); // bare-GUID leaf, one level down
    const grandchild = mkFolder(uuidv4(), child); // two levels down

    const ids = getRecursiveFolderIds(db, root);
    expect(new Set(ids)).toEqual(new Set([root, child, grandchild]));
  });

  it('getRecursiveFolderIds on a flat (childless) folder returns just itself', () => {
    const root = mkFolder('Flat');
    expect(getRecursiveFolderIds(db, root)).toEqual([root]);
  });

  it('getRecursiveConvertibleAssets pulls assets from every depth, root\'s own direct assets included', () => {
    const root = mkFolder('Droidkyn');
    const leaf1 = mkFolder(uuidv4(), root);
    const leaf2 = mkFolder(uuidv4(), leaf1);
    mkAsset(root, 'readme.pdf');
    mkAsset(leaf1, 'arm.stl');
    const deep = mkAsset(leaf2, 'leg.stl');

    const assets = getRecursiveConvertibleAssets(db, root);
    expect(assets.map((a) => a.filename).sort()).toEqual(['arm.stl', 'leg.stl', 'readme.pdf']);
    expect(assets.some((a) => a.id === deep)).toBe(true);
  });

  it('getRecursiveConvertibleAssets excludes soft-deleted assets', () => {
    const root = mkFolder('Droidkyn');
    mkAsset(root, 'live.stl');
    mkAsset(root, 'trashed.stl', true);

    const assets = getRecursiveConvertibleAssets(db, root);
    expect(assets.map((a) => a.filename)).toEqual(['live.stl']);
  });

  it('getRecursiveConvertibleAssets on a flat folder matches the old direct-children-only behavior exactly', () => {
    const root = mkFolder('Flat');
    mkAsset(root, 'a.stl');
    mkAsset(root, 'b.stl');
    const assets = getRecursiveConvertibleAssets(db, root);
    expect(assets.map((a) => a.filename)).toEqual(['a.stl', 'b.stl']);
  });

  it('getImmediateChildFolders returns only one level down, not grandchildren', () => {
    const root = mkFolder('Minis');
    const droidkyn = mkFolder('Droidkyn', root);
    mkFolder('Circuit Master', root);
    const grandchild = mkFolder('grandchild', droidkyn); // must NOT appear

    const children = getImmediateChildFolders(db, root);
    expect(children.map((c) => c.name).sort()).toEqual(['Circuit Master', 'Droidkyn']);
    expect(children.map((c) => c.id)).not.toContain(grandchild);
  });

  it('planEachChildConversion splits named children from bare-GUID children (Aaron\'s Minis example)', () => {
    const root = mkFolder('Minis');
    mkFolder('Droidkyn', root);
    mkFolder('Circuit Master', root);
    mkFolder('Heavy Weapons', root);
    mkFolder(uuidv4(), root); // bare-GUID leaf directly under the container — skipped

    const children = getImmediateChildFolders(db, root);
    const { eligible, skipped } = planEachChildConversion(children);

    expect(eligible.map((f) => f.name).sort()).toEqual(['Circuit Master', 'Droidkyn', 'Heavy Weapons']);
    expect(skipped).toHaveLength(1);
    expect(isBareGuidName(skipped[0].name)).toBe(true);
  });

  // Defensive-depth-cap fold-in (Remy's review): folders.parent_id has no
  // DB-level cycle constraint — routes/folders.ts's PATCH cycle guard is
  // an application-layer check on the reparent mutation path, not a
  // schema guarantee, so a cyclic parent_id can still exist via a
  // hand-edited row (exactly what this fixture builds directly against
  // the DB, bypassing every app-level check, same reproduction method
  // Remy used). Before the depth cap, this hung the WITH RECURSIVE query
  // — and the whole synchronous better-sqlite3 process with it —
  // indefinitely, since UNION ALL never dedupes and just re-adds the
  // cycle's ids forever. This test is the regression guard: it must
  // complete fast and return a bounded set, not hang.
  it('terminates fast and returns a bounded set on a cyclic parent_id, instead of hanging', () => {
    const a = mkFolder('A');
    const b = mkFolder('B', a);
    // Hand-built cycle: A's parent_id now points at B, so A -> B -> A.
    // Bypasses the app layer entirely — this is a DB-level fixture, not
    // something reachable through routes/folders.ts's PATCH endpoint.
    db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(b, a);

    const start = Date.now();
    const ids = getRecursiveFolderIds(db, a);
    const elapsedMs = Date.now() - start;

    // Fast, not hung — this is the actual regression guard. Generous
    // threshold (a real freeze is >15s per Remy's report; this asserts
    // two orders of magnitude under that) so the assertion is about
    // "did it hang" not "is it micro-optimized".
    expect(elapsedMs).toBeLessThan(2000);
    // Bounded: capped at MAX_FOLDER_TREE_DEPTH (100) + 1 rows, not an
    // ever-growing set. The exact count doesn't matter as much as "it
    // stopped at all" — both ids alternate into the result until the cap.
    expect(ids.length).toBeLessThanOrEqual(101);
    expect(ids.length).toBeGreaterThan(0);
    // Both cycle members are present — the cap didn't just return the
    // root and bail before doing any real traversal.
    expect(new Set(ids)).toEqual(new Set([a, b]));
  });

  it('a legitimately deep (but non-cyclic) chain well under the cap returns every level, unaffected', () => {
    let parent: string | null = null;
    const chain: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = mkFolder(`Level ${i}`, parent);
      chain.push(id);
      parent = id;
    }
    const ids = getRecursiveFolderIds(db, chain[0]);
    expect(new Set(ids)).toEqual(new Set(chain));
  });
});
