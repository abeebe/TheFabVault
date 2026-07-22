// Realistic zip entry-path fixtures for the C1 classifier
// (services/zipImportClassify.ts, #2171) and its Phase C siblings.
//
// Kept in their own module, not inline in zipImportClassify.test.ts, so
// C2's route tests (draft/commit against a real extracted zip) and C3's
// wizard-plan tests can import the exact same shapes rather than each
// re-typing a slightly-different path list — these three site shapes
// and the edge cases below are the ones the plan doc calls out as
// load-bearing for the rest of Phase C.

import type { ZipEntryInput } from '../../services/zipImportClassify.js';

function entries(...paths: string[]): ZipEntryInput[] {
  return paths.map((path) => ({ path }));
}

// Printables: top-level files/ + images/ + a root README, no wrapping
// folder (Printables zips are typically exported flat).
export const PRINTABLES_ZIP_FILENAME = 'articulated_dragon_printables.zip';
export const PRINTABLES_ENTRIES = entries(
  'files/dragon_body.stl',
  'files/dragon_tail.stl',
  'images/render1.jpg',
  'images/render2.jpg',
  'README.md',
  'LICENSE.md',
);

// Thingiverse: top-level files/ + images/ + a root LICENSE.txt, no
// README (this is the discriminator against Printables).
export const THINGIVERSE_ZIP_FILENAME = 'Low_Poly_Fox.zip';
export const THINGIVERSE_ENTRIES = entries(
  'files/fox_body.stl',
  'files/fox_base.stl',
  'images/fox_photo.jpg',
  'LICENSE.txt',
);

// MakerWorld: flat — model + image files sit directly at the top
// level, no files/ or images/ subfolders.
export const MAKERWORLD_ZIP_FILENAME = 'phone_stand_v2.zip';
export const MAKERWORLD_ENTRIES = entries(
  'phone_stand_v2.stl',
  'phone_stand_v2.3mf',
  'cover.jpg',
  'preview_2.png',
);

// Edge: single nested root folder wrapping an otherwise MakerWorld-flat
// shape — everything (including the folder's own directory-listing
// entry) sits under one common ancestor.
export const NESTED_ROOT_ZIP_FILENAME = 'export.zip';
export const NESTED_ROOT_ENTRIES = entries(
  'Cool_Model_v2/',
  'Cool_Model_v2/model.stl',
  'Cool_Model_v2/cover.png',
  'Cool_Model_v2/README.md',
);

// Edge: no README and no LICENSE anywhere — must degrade to
// guessedSourceSite: null with per-extension classification still
// intact, not an error.
export const NO_README_ZIP_FILENAME = 'random_export.zip';
export const NO_README_ENTRIES = entries(
  'part_a.stl',
  'part_b.STL',
  'notes.pdf',
);

// Edge: mixed-case extensions across every role, including a
// case-insensitive profile hint and a case-insensitive README/LICENSE
// match.
export const MIXED_CASE_ZIP_FILENAME = 'Mixed_Case_Set.zip';
export const MIXED_CASE_ENTRIES = entries(
  'Model.STL',
  'Photo.JPG',
  'Notes.PDF',
  'print_PROFILE.3MF',
  'settings.GCODE',
  'Readme.TXT',
  'License.MD',
);

// Edge: hostile entries — parent-traversal (repeated and embedded),
// POSIX absolute, and Windows-drive absolute-with-backslashes — mixed
// in with one legitimate file, proving invalid entries neither crash
// classification nor pollute title/description/license/site-guess.
export const HOSTILE_ZIP_FILENAME = 'evil.zip';
export const HOSTILE_ENTRIES = entries(
  'model.stl',
  '../../../etc/passwd',
  '/etc/shadow',
  'C:\\Windows\\System32\\config',
  'safe/../../escape.txt',
);

// Edge: macOS archiving noise (__MACOSX/ at two different nesting
// depths, .DS_Store, AppleDouble resource forks) plus Windows junk
// (Thumbs.db, desktop.ini), mixed into an otherwise clean
// single-root-folder zip.
export const MACOS_JUNK_ZIP_FILENAME = 'Vase_Design.zip';
export const MACOS_JUNK_ENTRIES = entries(
  'Vase_Design/model.stl',
  'Vase_Design/cover.jpg',
  'Vase_Design/__MACOSX/._model.stl',
  'Vase_Design/.DS_Store',
  '__MACOSX/Vase_Design/._cover.jpg',
  'Thumbs.db',
  'desktop.ini',
);

// Edge: duplicate filenames living in different directories — the
// classifier must classify both independently and never dedup/merge
// (dedup-by-hash is C2's job, against real file bytes, not path text).
export const DUPLICATE_NAME_ZIP_FILENAME = 'duplicate_names.zip';
export const DUPLICATE_NAME_ENTRIES = entries(
  'files/part.stl',
  'spares/part.stl',
);

export { entries };
