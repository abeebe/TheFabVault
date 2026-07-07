import { describe, expect, it } from 'vitest';
import {
  buildPreviewTree, flattenTree, isExcluded, isIndeterminate, computeIncludedTotals,
} from '../lib/importPreviewTree.js';
import type { SubAssemblyOut } from '../types/index.js';

function sa(id: string, name: string, parentId: string | null = null): SubAssemblyOut {
  return { id, projectId: 'p1', parentId, name, sortOrder: 0, createdAt: 0, rollup: { needed: 0, done: 0, percent: null } };
}

describe('buildPreviewTree', () => {
  it('builds a single-level tree with a direct file count', () => {
    const roots = buildPreviewTree([['Right Foot'], ['Right Foot']], [], null);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ name: 'Right Foot', depth: 0, directFileCount: 2, willMerge: false });
  });

  it('builds nested levels correctly (Dome > Dome Ring)', () => {
    const roots = buildPreviewTree([['Dome', 'Dome Ring']], [], null);
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('Dome');
    expect(roots[0].directFileCount).toBe(0); // no file lands directly on Dome
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0]).toMatchObject({ name: 'Dome Ring', depth: 1, directFileCount: 1 });
  });

  it('ignores flat files (empty segments) — they contribute no tree node', () => {
    const roots = buildPreviewTree([[], ['Right Foot']], [], null);
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('Right Foot');
  });

  it('two branches sharing a common ancestor produce one shared parent node', () => {
    const roots = buildPreviewTree([['Dome', 'Ring'], ['Dome', 'Vents']], [], null);
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.name).sort()).toEqual(['Ring', 'Vents']);
  });

  it('tags a node "will merge" when its full path matches an existing sub-assembly chain', () => {
    const existing = [sa('id-dome', 'Dome', null)];
    const roots = buildPreviewTree([['Dome']], existing, null);
    expect(roots[0].willMerge).toBe(true);
    expect(roots[0].existingId).toBe('id-dome');
  });

  it('does NOT tag a node "will merge" when only a partial ancestor chain matches', () => {
    const existing = [sa('id-dome', 'Dome', null)]; // Dome exists, Dome/Vents does not
    const roots = buildPreviewTree([['Dome', 'Vents']], existing, null);
    const dome = roots[0];
    const vents = dome.children[0];
    expect(dome.willMerge).toBe(true);
    expect(vents.willMerge).toBe(false);
    expect(vents.existingId).toBeNull();
  });

  it('applies the shared normalization rule — trims whitespace before matching', () => {
    const existing = [sa('id-dome', '  Dome  ', null)];
    const roots = buildPreviewTree([['Dome']], existing, null);
    expect(roots[0].willMerge).toBe(true);
  });

  it('is case-sensitive, matching the server rule exactly (no accidental case-insensitive merge)', () => {
    const existing = [sa('id-dome', 'dome', null)]; // lowercase
    const roots = buildPreviewTree([['Dome']], existing, null); // uppercase D
    expect(roots[0].willMerge).toBe(false);
  });

  it('scopes matching under a specific rootParentId (drilled-in import target)', () => {
    // Two projects' worth of nodes named "Ring" exist at different
    // parents; only the one under the actual target parent should match.
    const existing = [
      sa('ring-under-dome', 'Ring', 'dome-id'),
      sa('ring-under-other', 'Ring', 'other-id'),
    ];
    const rootsUnderDome = buildPreviewTree([['Ring']], existing, 'dome-id');
    expect(rootsUnderDome[0].willMerge).toBe(true);
    expect(rootsUnderDome[0].existingId).toBe('ring-under-dome');

    const rootsUnderNeither = buildPreviewTree([['Ring']], existing, 'some-other-node');
    expect(rootsUnderNeither[0].willMerge).toBe(false);
  });
});

describe('flattenTree / isExcluded / isIndeterminate', () => {
  it('flattenTree visits every node depth-first', () => {
    const roots = buildPreviewTree([['Dome', 'Ring'], ['Dome', 'Vents'], ['Right Foot']], [], null);
    const flat = flattenTree(roots);
    expect(flat.map((n) => n.name).sort()).toEqual(['Dome', 'Right Foot', 'Ring', 'Vents']);
  });

  it('isExcluded is true for a directly-excluded node', () => {
    const roots = buildPreviewTree([['Dome']], [], null);
    const excluded = new Set([roots[0].key]);
    expect(isExcluded(roots[0], excluded)).toBe(true);
  });

  it('isExcluded is true for a descendant of an excluded ancestor, even if not itself excluded', () => {
    const roots = buildPreviewTree([['Dome', 'Ring']], [], null);
    const dome = roots[0];
    const ring = dome.children[0];
    const excluded = new Set([dome.key]);
    expect(isExcluded(ring, excluded)).toBe(true);
  });

  it('isIndeterminate is true for an included parent with an excluded descendant', () => {
    const roots = buildPreviewTree([['Dome', 'Ring'], ['Dome', 'Vents']], [], null);
    const dome = roots[0];
    const ring = dome.children.find((c) => c.name === 'Ring')!;
    const excluded = new Set([ring.key]);
    expect(isIndeterminate(dome, excluded)).toBe(true);
    expect(isExcluded(dome, excluded)).toBe(false);
  });

  it('isIndeterminate is false once the parent itself is excluded (excluded, not indeterminate)', () => {
    const roots = buildPreviewTree([['Dome', 'Ring']], [], null);
    const dome = roots[0];
    const excluded = new Set([dome.key]);
    expect(isIndeterminate(dome, excluded)).toBe(false);
    expect(isExcluded(dome, excluded)).toBe(true);
  });
});

describe('computeIncludedTotals', () => {
  it('counts every file when nothing is excluded', () => {
    const roots = buildPreviewTree([['Right Foot'], ['Right Foot'], ['Left Foot']], [], null);
    const totals = computeIncludedTotals(roots, new Set());
    expect(totals.includedFileCount).toBe(3);
    expect(totals.includedNewCount).toBe(2); // Right Foot, Left Foot
  });

  it('drops an excluded branch and all its descendants from the totals', () => {
    const roots = buildPreviewTree([['Dome', 'Ring'], ['Dome', 'Vents'], ['Right Foot']], [], null);
    const dome = roots.find((n) => n.name === 'Dome')!;
    const totals = computeIncludedTotals(roots, new Set([dome.key]));
    // Only Right Foot's single file remains; Dome/Ring + Dome/Vents both excluded.
    expect(totals.includedFileCount).toBe(1);
    expect(totals.includedNewCount).toBe(1);
  });

  it('separates new vs merge counts', () => {
    const existing = [sa('id-dome', 'Dome', null)];
    const roots = buildPreviewTree([['Dome', 'Ring'], ['Right Foot']], existing, null);
    const totals = computeIncludedTotals(roots, new Set());
    expect(totals.includedMergeCount).toBe(1); // Dome merges
    expect(totals.includedNewCount).toBe(2); // Ring + Right Foot are new
  });

  it('reports maxDepth as the deepest included level (1-indexed)', () => {
    const roots = buildPreviewTree([['Dome', 'Ring', 'Screw']], [], null);
    const totals = computeIncludedTotals(roots, new Set());
    expect(totals.maxDepth).toBe(3);
  });
});
