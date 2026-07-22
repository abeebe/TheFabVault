// Tests for the zip-import classifier (services/zipImportClassify.ts,
// #2171). Pure function, no DB/filesystem — same testing shape as
// modelConvert.test.ts's classifyExt/planFolderConversion suites.

import { describe, expect, it } from 'vitest';
import { classifyZipEntries, type ZipEntryInput } from '../services/zipImportClassify.js';
import {
  entries,
  PRINTABLES_ZIP_FILENAME, PRINTABLES_ENTRIES,
  THINGIVERSE_ZIP_FILENAME, THINGIVERSE_ENTRIES,
  MAKERWORLD_ZIP_FILENAME, MAKERWORLD_ENTRIES,
  NESTED_ROOT_ZIP_FILENAME, NESTED_ROOT_ENTRIES,
  NO_README_ZIP_FILENAME, NO_README_ENTRIES,
  MIXED_CASE_ZIP_FILENAME, MIXED_CASE_ENTRIES,
  HOSTILE_ZIP_FILENAME, HOSTILE_ENTRIES,
  MACOS_JUNK_ZIP_FILENAME, MACOS_JUNK_ENTRIES,
  DUPLICATE_NAME_ZIP_FILENAME, DUPLICATE_NAME_ENTRIES,
} from './fixtures/zipImportFixtures.js';

function fileRole(plan: ReturnType<typeof classifyZipEntries>, p: string) {
  return plan.files.find((f) => f.path === p)?.role;
}

describe('classifyZipEntries — site-shape fixtures', () => {
  it('classifies a Printables-shaped zip', () => {
    const plan = classifyZipEntries(PRINTABLES_ENTRIES, PRINTABLES_ZIP_FILENAME);

    expect(plan.guessedSourceSite).toBe('printables');
    expect(plan.descriptionSource).toBe('README.md');
    expect(plan.licenseFile).toBe('LICENSE.md');
    expect(fileRole(plan, 'files/dragon_body.stl')).toBe('part');
    expect(fileRole(plan, 'images/render1.jpg')).toBe('image');
    expect(fileRole(plan, 'README.md')).toBe('doc');
    expect(plan.profileCandidates).toEqual([]);
    // No wrapping folder here, so the title falls back to the zip filename.
    expect(plan.suggestedTitle).toBe('Articulated Dragon Printables');
  });

  it('classifies a Thingiverse-shaped zip', () => {
    const plan = classifyZipEntries(THINGIVERSE_ENTRIES, THINGIVERSE_ZIP_FILENAME);

    expect(plan.guessedSourceSite).toBe('thingiverse');
    expect(plan.descriptionSource).toBeNull(); // no README distinguishes it from Printables
    expect(plan.licenseFile).toBe('LICENSE.txt');
    expect(fileRole(plan, 'files/fox_body.stl')).toBe('part');
    expect(fileRole(plan, 'images/fox_photo.jpg')).toBe('image');
    expect(plan.suggestedTitle).toBe('Low Poly Fox');
  });

  it('classifies a MakerWorld-shaped (flat) zip', () => {
    const plan = classifyZipEntries(MAKERWORLD_ENTRIES, MAKERWORLD_ZIP_FILENAME);

    expect(plan.guessedSourceSite).toBe('makerworld');
    expect(fileRole(plan, 'phone_stand_v2.stl')).toBe('part');
    expect(fileRole(plan, 'phone_stand_v2.3mf')).toBe('part');
    expect(fileRole(plan, 'cover.jpg')).toBe('image');
    expect(fileRole(plan, 'preview_2.png')).toBe('image');
    expect(plan.descriptionSource).toBeNull();
    expect(plan.licenseFile).toBeNull();
    expect(plan.suggestedTitle).toBe('Phone Stand V2');
  });
});

describe('classifyZipEntries — edge fixtures', () => {
  it('strips a single nested root folder and still detects the flat shape beneath it', () => {
    const plan = classifyZipEntries(NESTED_ROOT_ENTRIES, NESTED_ROOT_ZIP_FILENAME);

    // Title prefers the wrapping folder name over the zip filename.
    expect(plan.suggestedTitle).toBe('Cool Model V2');
    expect(plan.guessedSourceSite).toBe('makerworld');
    expect(plan.descriptionSource).toBe('Cool_Model_v2/README.md');
    expect(fileRole(plan, 'Cool_Model_v2/')).toBe('ignore'); // bare directory marker
    expect(plan.files.find((f) => f.path === 'Cool_Model_v2/')?.invalid).toBe(false);
    expect(fileRole(plan, 'Cool_Model_v2/model.stl')).toBe('part');
  });

  it('recognizes the root folder even when only its own directory entry and one nested file exist', () => {
    const plan = classifyZipEntries(entries('Solo/', 'Solo/part.stl'), 'irrelevant.zip');
    expect(plan.suggestedTitle).toBe('Solo');
  });

  it('degrades gracefully with no README/LICENSE — extension classification still works', () => {
    const plan = classifyZipEntries(NO_README_ENTRIES, NO_README_ZIP_FILENAME);

    expect(plan.guessedSourceSite).toBeNull();
    expect(plan.descriptionSource).toBeNull();
    expect(plan.licenseFile).toBeNull();
    expect(fileRole(plan, 'part_a.stl')).toBe('part');
    expect(fileRole(plan, 'part_b.STL')).toBe('part'); // case-insensitive
    expect(fileRole(plan, 'notes.pdf')).toBe('doc');
    expect(plan.suggestedTitle).toBe('Random Export');
  });

  it('handles mixed-case extensions across every role, README/LICENSE match, and profile hints', () => {
    const plan = classifyZipEntries(MIXED_CASE_ENTRIES, MIXED_CASE_ZIP_FILENAME);

    expect(fileRole(plan, 'Model.STL')).toBe('part');
    expect(fileRole(plan, 'Photo.JPG')).toBe('image');
    expect(fileRole(plan, 'Notes.PDF')).toBe('doc');
    expect(fileRole(plan, 'print_PROFILE.3MF')).toBe('part');
    expect(fileRole(plan, 'settings.GCODE')).toBe('other');
    expect(plan.profileCandidates.sort()).toEqual(['print_PROFILE.3MF', 'settings.GCODE'].sort());
    expect(plan.descriptionSource).toBe('Readme.TXT');
    expect(plan.licenseFile).toBe('License.MD');
    expect(plan.suggestedTitle).toBe('Mixed Case Set');
  });

  it('flags absolute paths and parent-traversal entries as invalid without crashing or polluting the plan', () => {
    const plan = classifyZipEntries(HOSTILE_ENTRIES, HOSTILE_ZIP_FILENAME);

    const traversal = plan.files.find((f) => f.path === '../../../etc/passwd');
    expect(traversal?.invalid).toBe(true);
    expect(traversal?.invalidReason).toBe('path traversal (..)');

    const posixAbs = plan.files.find((f) => f.path === '/etc/shadow');
    expect(posixAbs?.invalid).toBe(true);
    expect(posixAbs?.invalidReason).toBe('absolute path');

    const winAbs = plan.files.find((f) => f.path === 'C:\\Windows\\System32\\config');
    expect(winAbs?.invalid).toBe(true);
    expect(winAbs?.invalidReason).toBe('absolute path');

    const embeddedTraversal = plan.files.find((f) => f.path === 'safe/../../escape.txt');
    expect(embeddedTraversal?.invalid).toBe(true);
    expect(embeddedTraversal?.invalidReason).toBe('path traversal (..)');

    // The one legitimate entry is unaffected.
    const legit = plan.files.find((f) => f.path === 'model.stl');
    expect(legit?.invalid).toBe(false);
    expect(legit?.role).toBe('part');

    // Invalid entries must never drive title/description/license/site-guess.
    expect(plan.suggestedTitle).toBe('Evil');
    expect(plan.descriptionSource).toBeNull();
    expect(plan.licenseFile).toBeNull();
    expect(plan.guessedSourceSite).toBeNull();
  });

  it('still assigns a best-effort role to invalid entries for display purposes', () => {
    const plan = classifyZipEntries(HOSTILE_ENTRIES, HOSTILE_ZIP_FILENAME);
    // '../../../etc/passwd' has no extension -> 'other', informational only.
    expect(fileRole(plan, '../../../etc/passwd')).toBe('other');
    // 'safe/../../escape.txt' has a .txt extension -> classified as 'doc'.
    expect(fileRole(plan, 'safe/../../escape.txt')).toBe('doc');
  });

  it('classifies macOS/Windows archiving junk as ignore, not other, and never lets it pollute structure detection', () => {
    const plan = classifyZipEntries(MACOS_JUNK_ENTRIES, MACOS_JUNK_ZIP_FILENAME);

    expect(fileRole(plan, 'Vase_Design/__MACOSX/._model.stl')).toBe('ignore');
    expect(fileRole(plan, 'Vase_Design/.DS_Store')).toBe('ignore');
    expect(fileRole(plan, '__MACOSX/Vase_Design/._cover.jpg')).toBe('ignore');
    expect(fileRole(plan, 'Thumbs.db')).toBe('ignore');
    expect(fileRole(plan, 'desktop.ini')).toBe('ignore');

    // None of the junk is invalid — it's just noise, not a safety issue.
    for (const junkPath of [
      'Vase_Design/__MACOSX/._model.stl', 'Vase_Design/.DS_Store',
      '__MACOSX/Vase_Design/._cover.jpg', 'Thumbs.db', 'desktop.ini',
    ]) {
      expect(plan.files.find((f) => f.path === junkPath)?.invalid).toBe(false);
    }

    // Root-folder detection sees through the junk to the real single root.
    expect(plan.suggestedTitle).toBe('Vase Design');
    expect(fileRole(plan, 'Vase_Design/model.stl')).toBe('part');
    expect(fileRole(plan, 'Vase_Design/cover.jpg')).toBe('image');
  });

  it('classifies duplicate filenames in different directories independently, without deduping', () => {
    const plan = classifyZipEntries(DUPLICATE_NAME_ENTRIES, DUPLICATE_NAME_ZIP_FILENAME);

    expect(plan.files).toHaveLength(2);
    expect(fileRole(plan, 'files/part.stl')).toBe('part');
    expect(fileRole(plan, 'spares/part.stl')).toBe('part');
  });
});

describe('classifyZipEntries — structural correctness', () => {
  it('returns one output file per input entry, in input order', () => {
    const paths = ['b.stl', 'a.png', 'z.pdf'];
    const plan = classifyZipEntries(entries(...paths), 'order.zip');
    expect(plan.files.map((f) => f.path)).toEqual(paths);
  });

  it('does not detect a common root when entries sit at mixed depths', () => {
    const plan = classifyZipEntries(entries('top.stl', 'Folder/inner.stl'), 'mixed_depth.zip');
    expect(plan.suggestedTitle).toBe('Mixed Depth');
  });

  it('is a pure function — identical input always produces identical output', () => {
    const first = classifyZipEntries(MIXED_CASE_ENTRIES, MIXED_CASE_ZIP_FILENAME);
    const second = classifyZipEntries(MIXED_CASE_ENTRIES, MIXED_CASE_ZIP_FILENAME);
    expect(first).toEqual(second);
  });

  it('threads each entry\'s size through to the matching file, unmodified, when provided', () => {
    const withSize: ZipEntryInput[] = [
      { path: 'model.stl', size: 123456 },
      { path: 'cover.jpg', size: 0 },
    ];
    const plan = classifyZipEntries(withSize, 'sized.zip');
    expect(fileRole(plan, 'model.stl')).toBe('part'); // size never influences role
    expect(plan.files.find((f) => f.path === 'model.stl')?.size).toBe(123456);
    expect(plan.files.find((f) => f.path === 'cover.jpg')?.size).toBe(0); // 0 is a real size, not "missing"
  });

  it('omits size entirely when the input entry did not include one, and never lets its presence/absence affect classification', () => {
    const withSize: ZipEntryInput[] = [{ path: 'model.stl', size: 123456 }, { path: 'cover.jpg', size: 0 }];
    const withoutSize: ZipEntryInput[] = [{ path: 'model.stl' }, { path: 'cover.jpg' }];

    const plan = classifyZipEntries(withoutSize, 'sized.zip');
    expect(plan.files.find((f) => f.path === 'model.stl')).not.toHaveProperty('size');

    const a = classifyZipEntries(withSize, 'sized.zip');
    const b = classifyZipEntries(withoutSize, 'sized.zip');
    // Strip size before comparing -- that's the one field size legitimately
    // changes; everything else (role, invalid, title, description,
    // license, profile candidates, site guess) must be identical.
    const stripSize = (p: typeof a) => ({ ...p, files: p.files.map(({ size: _size, ...rest }) => rest) });
    expect(stripSize(a)).toEqual(stripSize(b));
  });

  it('returns an empty plan for an empty entry list', () => {
    const plan = classifyZipEntries([], 'empty.zip');
    expect(plan.files).toEqual([]);
    expect(plan.descriptionSource).toBeNull();
    expect(plan.licenseFile).toBeNull();
    expect(plan.profileCandidates).toEqual([]);
    expect(plan.guessedSourceSite).toBeNull();
    expect(plan.suggestedTitle).toBe('Empty');
  });

  it('does not flag a Windows drive-RELATIVE path ("C:evil", no slash after the colon) as invalid — confirmed inert on this Linux-only stack (Remy, C1 review)', () => {
    const plan = classifyZipEntries(entries('C:evil'), 'drive_relative.zip');
    expect(plan.files[0].invalid).toBe(false);
  });

  it('handles a bare ".." entry with no separators as invalid traversal', () => {
    const plan = classifyZipEntries(entries('..'), 'weird.zip');
    expect(plan.files[0].invalid).toBe(true);
    expect(plan.files[0].invalidReason).toBe('path traversal (..)');
  });

  it('treats an empty-string path as invalid rather than throwing', () => {
    const plan = classifyZipEntries(entries(''), 'weird2.zip');
    expect(plan.files[0].invalid).toBe(true);
    expect(plan.files[0].invalidReason).toBe('empty path');
  });

  it('falls back to "Untitled Import" if the zip filename itself is empty and there is no root folder', () => {
    const plan = classifyZipEntries(entries('a.stl'), '');
    expect(plan.suggestedTitle).toBe('Untitled Import');
  });
});
