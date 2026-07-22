import { describe, expect, it } from 'vitest';
import { buildFolderPath, foldersWithPaths } from '../lib/folderTreePaths.js';
import type { FolderOut } from '../types/index.js';

function folder(id: string, name: string, parentId: string | null = null): FolderOut {
  return { id, name, parentId, createdAt: 0 };
}

describe('buildFolderPath', () => {
  it('returns just the name for a root folder', () => {
    const folders = [folder('a', 'Dragons')];
    expect(buildFolderPath(folders, 'a')).toBe('Dragons');
  });

  it('joins parent chain with " / ", root-first', () => {
    const folders = [
      folder('a', 'Dragons'),
      folder('b', 'Articulated', 'a'),
      folder('c', 'v2', 'b'),
    ];
    expect(buildFolderPath(folders, 'c')).toBe('Dragons / Articulated / v2');
  });

  it('does not hang on a cyclic parentId chain — stops and returns what it has', () => {
    const folders = [
      folder('a', 'A', 'b'),
      folder('b', 'B', 'a'),
    ];
    // Should terminate (not infinite-loop) and produce *some* string.
    expect(() => buildFolderPath(folders, 'a')).not.toThrow();
    expect(typeof buildFolderPath(folders, 'a')).toBe('string');
  });

  it('returns empty string for an unknown folder id', () => {
    expect(buildFolderPath([], 'missing')).toBe('');
  });
});

describe('foldersWithPaths', () => {
  it('attaches the full path to every folder and sorts by path', () => {
    const folders = [
      folder('z', 'Zephyr'),
      folder('a', 'Alpha'),
      folder('a1', 'Sub', 'a'),
    ];
    const result = foldersWithPaths(folders);
    expect(result.map((r) => r.path)).toEqual(['Alpha', 'Alpha / Sub', 'Zephyr']);
    expect(result.map((r) => r.folder.id)).toEqual(['a', 'a1', 'z']);
  });
});
