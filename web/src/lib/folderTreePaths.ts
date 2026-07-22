// Flat "path" rendering for the folders tree — distinct from
// pathSegments.ts, which derives a path from a File's webkitRelativePath
// during folder-picker import. This one walks the folders table's own
// parent_id chain (the same relationship FolderTree.tsx's isAncestorOf
// walks) to produce a human-readable "Parent / Child / Grandchild" string
// for a flat list display, used by the bulk convert wizard (#2170) so an
// admin can tell folders with the same name apart from a flat list
// without expanding a tree widget.

import type { FolderOut } from '../types/index.js';

// Builds "Parent / Child" for a single folder id. Walks up via parentId
// same as FolderTree.tsx's isAncestorOf, with the same cycle guard (a
// malformed/cyclic parentId chain should never hang the UI in an infinite
// loop — stops and returns whatever was accumulated so far instead).
export function buildFolderPath(folders: FolderOut[], folderId: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const segments: string[] = [];
  let cursor: string | null = folderId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (!folder) break;
    segments.unshift(folder.name);
    cursor = folder.parentId;
  }
  return segments.join(' / ');
}

export interface FolderWithPath {
  folder: FolderOut;
  path: string;
}

// Flat list of every folder with its full path attached, sorted by path
// so siblings/children naturally cluster together (a cheap stand-in for
// a real tree widget's visual grouping) without building actual tree
// state. Used as-is by the convert wizard's folder list.
export function foldersWithPaths(folders: FolderOut[]): FolderWithPath[] {
  return folders
    .map((folder) => ({ folder, path: buildFolderPath(folders, folder.id) }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}
