// Mirrors api/src/__tests__/subAssemblyImport.test.ts's normalizeSegmentName
// coverage with the SAME test vectors — this is the drift guard for the
// intentional client/server duplication documented in lib/pathSegments.ts.
// If these two test files ever disagree on an input/output pair, the two
// implementations have drifted and the Preview screen can no longer be
// trusted to represent what Commit will actually do.

import { describe, expect, it } from 'vitest';
import { normalizeSegmentName, isJunkFile, deriveRelativeSegments } from '../lib/pathSegments.js';

describe('normalizeSegmentName', () => {
  it('trims leading/trailing whitespace and nothing else', () => {
    expect(normalizeSegmentName('  Right Foot  ')).toBe('Right Foot');
    expect(normalizeSegmentName('Right Foot')).toBe('Right Foot');
    expect(normalizeSegmentName('right foot')).toBe('right foot');
  });
});

describe('isJunkFile', () => {
  it('flags known OS junk filenames', () => {
    expect(isJunkFile('.DS_Store')).toBe(true);
    expect(isJunkFile('Thumbs.db')).toBe(true);
    expect(isJunkFile('desktop.ini')).toBe(true);
    expect(isJunkFile('.directory')).toBe(true);
  });

  it('does not flag real model-pack files', () => {
    expect(isJunkFile('greeble.stl')).toBe(false);
    expect(isJunkFile('Right Foot')).toBe(false);
  });
});

describe('deriveRelativeSegments', () => {
  it('extracts nested segments, dropping the root folder and filename', () => {
    const result = deriveRelativeSegments('R2D2/Dome/Dome Ring/greeble.stl');
    expect(result).toEqual({
      segments: ['Dome', 'Dome Ring'],
      filename: 'greeble.stl',
      rootFolderName: 'R2D2',
    });
  });

  it('returns an empty segments array for a file sitting directly in the picked folder', () => {
    const result = deriveRelativeSegments('R2D2/readme.txt');
    expect(result).toEqual({
      segments: [],
      filename: 'readme.txt',
      rootFolderName: 'R2D2',
    });
  });

  it('handles a single-level subfolder', () => {
    const result = deriveRelativeSegments('R2D2/Right Foot/greeble.stl');
    expect(result.segments).toEqual(['Right Foot']);
    expect(result.filename).toBe('greeble.stl');
  });
});
