import { describe, expect, it } from 'vitest';
import { buildResolutions, type ScannedFile } from '../lib/importPlan.js';

function makeFile(name: string): File {
  return new File([new Uint8Array(4)], name);
}

function sf(name: string, segments: string[], hash: string, vaultAssetId: string | null = null): ScannedFile {
  return { file: makeFile(name), segments, hash, vaultAssetId };
}

describe('buildResolutions', () => {
  it('a unique-hash file with no vault match becomes new-upload', () => {
    const resolutions = buildResolutions([sf('a.stl', ['Right Foot'], 'hash-a')]);
    expect(resolutions).toEqual([{ kind: 'new-upload', file: expect.any(File), segments: ['Right Foot'] }]);
  });

  it('a file whose hash exists in the vault becomes vault-link, never new-upload', () => {
    const resolutions = buildResolutions([sf('a.stl', ['Right Foot'], 'hash-a', 'existing-asset-1')]);
    expect(resolutions).toEqual([
      { kind: 'vault-link', file: expect.any(File), segments: ['Right Foot'], assetId: 'existing-asset-1' },
    ]);
  });

  it('same-batch duplicates: first occurrence uploads, the rest link to it by index', () => {
    const resolutions = buildResolutions([
      sf('greeble.stl', ['Right Foot'], 'shared-hash'),
      sf('greeble.stl', ['Left Foot'], 'shared-hash'),
      sf('greeble.stl', ['Dome'], 'shared-hash'),
    ]);

    expect(resolutions).toHaveLength(3);
    expect(resolutions[0]).toEqual({ kind: 'new-upload', file: expect.any(File), segments: ['Right Foot'] });
    expect(resolutions[1]).toEqual({ kind: 'batch-link', file: expect.any(File), segments: ['Left Foot'], representativeIndex: 0 });
    expect(resolutions[2]).toEqual({ kind: 'batch-link', file: expect.any(File), segments: ['Dome'], representativeIndex: 0 });
  });

  it('if ANY file in a same-hash group already matches the vault, every file in the group links (never uploads)', () => {
    // Realistic case: two sibling folders both contain a copy of a part
    // that's already in the vault from a previous import. All three
    // should link, none should upload.
    const resolutions = buildResolutions([
      sf('a.stl', ['Right Foot'], 'hash-x'),
      sf('a.stl', ['Left Foot'], 'hash-x', 'vault-asset-9'),
      sf('a.stl', ['Dome'], 'hash-x'),
    ]);

    expect(resolutions.every((r) => r.kind === 'vault-link')).toBe(true);
    expect(resolutions.map((r) => (r as { assetId: string }).assetId)).toEqual([
      'vault-asset-9', 'vault-asset-9', 'vault-asset-9',
    ]);
  });

  it('every batch-link representativeIndex points at an earlier array position (deadlock-free ordering invariant)', () => {
    const resolutions = buildResolutions([
      sf('a.stl', ['Group A', '1'], 'hash-A'),
      sf('b.stl', ['Group B', '1'], 'hash-B'),
      sf('a2.stl', ['Group A', '2'], 'hash-A'), // dup of hash-A
      sf('b2.stl', ['Group B', '2'], 'hash-B'), // dup of hash-B
      sf('a3.stl', ['Group A', '3'], 'hash-A'), // another dup of hash-A
    ]);

    resolutions.forEach((r, idx) => {
      if (r.kind === 'batch-link') {
        expect(r.representativeIndex).toBeLessThan(idx);
        expect(resolutions[r.representativeIndex].kind).toBe('new-upload');
      }
    });
  });

  it('distinct hashes never collapse into the same group', () => {
    const resolutions = buildResolutions([
      sf('a.stl', ['Right Foot'], 'hash-a'),
      sf('b.stl', ['Left Foot'], 'hash-b'),
    ]);
    expect(resolutions.filter((r) => r.kind === 'new-upload')).toHaveLength(2);
  });

  it('returns an empty plan for an empty input', () => {
    expect(buildResolutions([])).toEqual([]);
  });
});
