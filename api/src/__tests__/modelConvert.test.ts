// Tests for the folder->model conversion planner (services/modelConvert.ts,
// #2155). Pure function, no DB/filesystem — same testing shape as
// subAssemblyTree.test.ts's validateReparent.

import { describe, expect, it } from 'vitest';
import {
  classifyExt, planFolderConversion, type ConvertibleAsset,
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
