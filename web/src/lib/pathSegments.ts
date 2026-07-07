// Folder-tree import path helpers — Bet 2 of the build manifest. See:
// Reports/reid-thefabvault-import-ux-2026-07-07.md, section 6.1 (Scan
//   phase: derive each file's sub-assembly path from webkitRelativePath)
// Reports/sloane-prd-thefabvault-build-manifest-2026-07-06.md (folder-import
//   mapping: ensureSubAssemblyPath, the server-side counterpart of
//   normalizeSegmentName below)

// The ONE normalization rule for matching a folder-import path segment
// against an existing sub-assembly: trim only, case-sensitive otherwise.
//
// This MUST stay byte-for-byte identical to the server's copy at
// api/src/services/subAssemblyImport.ts's normalizeSegmentName(), or the
// Preview screen's "will merge into existing" tags can lie about what
// Commit actually does (Reid's UX spec, section 5's explicit flag).
//
// It is duplicated rather than imported from a shared package because
// api/ and web/ are two independent npm projects in this repo (see
// api/package.json vs web/package.json — no root package.json, no
// workspaces field tying them together); introducing new build tooling to
// share one trivial pure function isn't justified. Both copies are pinned
// by mirrored unit tests (api/src/__tests__/subAssemblyImport.test.ts and
// __tests__/pathSegments.test.ts here) using the same test vectors, so any
// future drift fails CI on both sides. If this rule ever grows past a
// single trim(), move it into a real shared package instead of letting
// two copies diverge.
export function normalizeSegmentName(name: string): string {
  return name.trim();
}

// OS junk files that ride along in a folder selection and should never
// become part of the detected tree or count toward "N files" anywhere in
// the modal. Fixed denylist, not user-configurable in v1 (Reid's UX spec,
// section 6.1 point 2).
const JUNK_FILENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.directory']);

export function isJunkFile(filename: string): boolean {
  return JUNK_FILENAMES.has(filename);
}

export interface RelativeSegments {
  // Path segments from (but not including) the picked folder's own root
  // name, down to (but not including) the filename. Empty when the file
  // sits directly in the picked folder with no subfolder underneath it.
  segments: string[];
  filename: string;
  // The picked folder's own name — the first path segment, an artifact of
  // what Aaron clicked "select" on. Used only for the modal header
  // ("Import folder: R2D2"), never as a sub-assembly node itself.
  rootFolderName: string;
}

// Splits a File's webkitRelativePath (e.g. "R2D2/Right Foot/greeble.stl")
// into the pieces the Scan phase needs. Per the PRD: drop the first
// segment (the picked folder's own name) and the last segment (the
// filename) — what remains, in order, is the file's sub-assembly path
// relative to the import's target node.
export function deriveRelativeSegments(webkitRelativePath: string): RelativeSegments {
  const parts = webkitRelativePath.split('/').filter(Boolean);
  const rootFolderName = parts[0] ?? '';
  const filename = parts[parts.length - 1] ?? webkitRelativePath;
  const segments = parts.slice(1, -1);
  return { segments, filename, rootFolderName };
}
