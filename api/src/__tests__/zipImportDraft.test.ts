// Tests for services/zipImportDraft.ts (#2172) — the filesystem side of
// zip import: containment (zip-slip enforcement), real extraction against
// a hand-built hostile archive, draft metadata round-tripping, and the
// TTL sweep. DATA_DIR-scoped like models.test.ts's bootApp, but no HTTP
// server here — these are direct calls against the service module, same
// shape as modelConvert.test.ts testing a pure service (this one just
// isn't pure — it touches disk, hence the temp DATA_DIR per test).
//
// config.ts reads DATA_DIR once at module load (a plain property, not a
// getter, unlike storageDir) -- so DATA_DIR must be set and the module
// registry reset BEFORE importing zipImportDraft.ts, exactly like every
// other DATA_DIR-scoped test file in this suite.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildRawZip, UNIX_SYMLINK_EXTERNAL_ATTRS } from './helpers/rawZip.js';

interface Loaded {
  dataDir: string;
  mod: typeof import('../services/zipImportDraft.js');
}

const loaded: Loaded[] = [];

async function loadModule(): Promise<Loaded> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-zipdrafttest-data-'));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const mod = await import('../services/zipImportDraft.js');
  const result = { dataDir, mod };
  loaded.push(result);
  return result;
}

afterEach(() => {
  while (loaded.length) {
    const l = loaded.pop();
    if (l) fs.rmSync(l.dataDir, { recursive: true, force: true });
  }
  delete process.env.DATA_DIR;
});

describe('resolveContainedPath', () => {
  it('resolves an ordinary nested relative path inside baseDir', async () => {
    const { mod } = await loadModule();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-base-'));
    const resolved = mod.resolveContainedPath(base, 'files/model.stl');
    expect(resolved).toBe(path.join(base, 'files', 'model.stl'));
  });

  it('rejects a parent-traversal path', async () => {
    const { mod } = await loadModule();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-base-'));
    expect(mod.resolveContainedPath(base, '../../etc/passwd')).toBeNull();
    expect(mod.resolveContainedPath(base, 'safe/../../escape.txt')).toBeNull();
  });

  it('rejects a POSIX absolute path', async () => {
    const { mod } = await loadModule();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-base-'));
    expect(mod.resolveContainedPath(base, '/etc/shadow')).toBeNull();
  });

  it('treats a Windows-style "C:\\..." path as an ordinary contained relative path, not an escape — there is no drive letter on POSIX', async () => {
    // This is deliberately NOT null. On this Linux/ext4-only stack (see
    // this module's header), path.resolve() has no concept of a "C:"
    // drive -- it just joins "C:/Windows/..." as a subpath, which stays
    // fully inside baseDir. The classifier (services/zipImportClassify.ts)
    // flags this shape as invalid anyway, conservatively, on the string
    // heuristic alone (same accepted reasoning as its "C:evil" case, per
    // Remy's C1 review) -- but resolveContainedPath's job is the actual
    // POSIX containment truth, and on POSIX this genuinely never escapes.
    const { mod } = await loadModule();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-base-'));
    const resolved = mod.resolveContainedPath(base, 'C:\\Windows\\System32\\config');
    expect(resolved).toBe(path.join(base, 'C:', 'Windows', 'System32', 'config'));
  });

  it('resolves the same path deterministically regardless of backslash vs forward-slash separators', async () => {
    const { mod } = await loadModule();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-base-'));
    const a = mod.resolveContainedPath(base, 'files/sub/model.stl');
    const b = mod.resolveContainedPath(base, 'files\\sub\\model.stl');
    expect(a).toBe(b);
  });
});

describe('extractZip — zip-slip enforcement against a real, hand-built hostile archive', () => {
  it('extracts safe entries and silently skips unsafe ones, listing both', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'hostile.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      { name: '../../etc/passwd', content: 'hostile' },
      { name: '/etc/shadow', content: 'also hostile' },
      { name: 'fine.txt', content: 'ok bytes' },
      { name: 'nested/deeper.stl', content: 'model bytes' },
    ]));

    const destDir = path.join(dataDir, 'dest');
    fs.mkdirSync(destDir, { recursive: true });
    const entries = await mod.extractZip(zipPath, destDir);

    // Every entry is reported, hostile ones included, for the classifier
    // to flag.
    expect(entries.map((e) => e.path).sort()).toEqual([
      '../../etc/passwd', '/etc/shadow', 'fine.txt', 'nested/deeper.stl',
    ].sort());

    // But only the safe ones actually landed on disk.
    expect(fs.existsSync(path.join(destDir, 'fine.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'fine.txt'), 'utf8')).toBe('ok bytes');
    expect(fs.existsSync(path.join(destDir, 'nested', 'deeper.stl'))).toBe(true);

    // Nothing escaped destDir -- no file with the hostile content exists
    // anywhere outside it (best-effort check: destDir's tree has exactly
    // the two safe files, nothing else).
    const written = fs.readdirSync(destDir, { recursive: true }) as string[];
    expect(written.sort()).toEqual(['fine.txt', 'nested', path.join('nested', 'deeper.stl')].sort());
  });

  it('extracts a directory-marker entry as a real directory, and files nested under it', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'plain.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      { name: 'Cool_Model/', content: '' },
      { name: 'Cool_Model/model.stl', content: 'bytes' },
    ]));
    const destDir = path.join(dataDir, 'dest2');
    fs.mkdirSync(destDir, { recursive: true });
    await mod.extractZip(zipPath, destDir);

    expect(fs.statSync(path.join(destDir, 'Cool_Model')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'Cool_Model', 'model.stl'), 'utf8')).toBe('bytes');
  });

  it('rejects a corrupt/non-zip file rather than hanging or crashing the process', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'not-a-zip.zip');
    fs.writeFileSync(zipPath, 'this is definitely not a zip file');
    const destDir = path.join(dataDir, 'dest3');
    fs.mkdirSync(destDir, { recursive: true });
    await expect(mod.extractZip(zipPath, destDir)).rejects.toThrow();
  });
});

// Vera's security review, #2172 follow-up, CRITICAL finding: every fs
// call in extractZip's per-entry handler used to be an unguarded
// synchronous call, invoked from yauzl's own internal fs-read callback
// chain -- a throw there was a true UNCAUGHT exception (full process
// exit via processGuards.ts's uncaughtException handler, #2044), not a
// rejected promise. These tests run in THIS process (not a forked
// child), so before the fix they would have taken the whole vitest
// worker down rather than failing cleanly -- confirming they now
// resolve/reject normally IS the regression test.
describe('extractZip — Critical fix: malformed/ordinary entries no longer crash the process', () => {
  it('a NUL byte in an entry name is skipped (not written), not a crash, and legitimate sibling entries still extract', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'nul-byte.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      { name: 'foo\0bar.stl', content: 'hostile-looking but just malformed' },
      { name: 'fine.txt', content: 'ok bytes' },
    ]));
    const destDir = path.join(dataDir, 'dest-nul');
    fs.mkdirSync(destDir, { recursive: true });

    const entries = await mod.extractZip(zipPath, destDir);

    // Still reported (for the classifier to see/flag), just never written.
    expect(entries.map((e) => e.path)).toContain('foo\0bar.stl');
    const written = fs.readdirSync(destDir);
    expect(written).toEqual(['fine.txt']);
  });

  it('a NUL byte in a directory-marker entry name is skipped the same way', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'nul-byte-dir.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      { name: 'foo\0bar/', content: '' },
      { name: 'fine.txt', content: 'ok bytes' },
    ]));
    const destDir = path.join(dataDir, 'dest-nul-dir');
    fs.mkdirSync(destDir, { recursive: true });

    await expect(mod.extractZip(zipPath, destDir)).resolves.not.toThrow();
    expect(fs.readdirSync(destDir)).toEqual(['fine.txt']);
  });

  it('an ordinary file/directory name collision ("foo" as a file, then "foo/bar.stl") is skipped, not a crash -- needs no hostile intent at all', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'collision.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      { name: 'foo', content: 'foo is a plain file' },
      { name: 'foo/bar.stl', content: 'this needs foo to be a directory instead' },
      { name: 'fine.txt', content: 'ok bytes' },
    ]));
    const destDir = path.join(dataDir, 'dest-collision');
    fs.mkdirSync(destDir, { recursive: true });

    const entries = await mod.extractZip(zipPath, destDir);

    expect(entries.map((e) => e.path)).toEqual(['foo', 'foo/bar.stl', 'fine.txt']);
    // "foo" landed as a file (first entry wins); the second entry, which
    // needed foo to be a directory, was skipped rather than crashing.
    expect(fs.statSync(path.join(destDir, 'foo')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'foo', 'bar.stl'))).toBe(false);
    expect(fs.readFileSync(path.join(destDir, 'fine.txt'), 'utf8')).toBe('ok bytes');
  });

  it('the reverse collision ("foo/bar.stl" first, establishing foo as a directory, then "foo" as a file) is also skipped, not a crash', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'collision-reverse.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      { name: 'foo/bar.stl', content: 'foo must be a directory for this' },
      { name: 'foo', content: 'now foo wants to be a plain file instead' },
      { name: 'fine.txt', content: 'ok bytes' },
    ]));
    const destDir = path.join(dataDir, 'dest-collision-reverse');
    fs.mkdirSync(destDir, { recursive: true });

    await expect(mod.extractZip(zipPath, destDir)).resolves.not.toThrow();
    expect(fs.statSync(path.join(destDir, 'foo')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'foo', 'bar.stl'), 'utf8')).toBe('foo must be a directory for this');
    expect(fs.readFileSync(path.join(destDir, 'fine.txt'), 'utf8')).toBe('ok bytes');
  });
});

describe('extractZip — MEDIUM fix: entry-count cap', () => {
  it('rejects a zip whose entry count exceeds MAX_ZIP_ENTRIES, even though every entry is zero bytes', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'too-many-entries.zip');
    const entries = Array.from({ length: mod.MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt`, content: '' }));
    fs.writeFileSync(zipPath, buildRawZip(entries));
    const destDir = path.join(dataDir, 'dest-too-many');
    fs.mkdirSync(destDir, { recursive: true });

    await expect(mod.extractZip(zipPath, destDir)).rejects.toThrow(mod.ZipTooLargeError);
  });

  it('accepts a zip with exactly MAX_ZIP_ENTRIES entries (boundary, not off-by-one)', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'at-cap.zip');
    const entries = Array.from({ length: mod.MAX_ZIP_ENTRIES }, (_, i) => ({ name: `f${i}.txt`, content: '' }));
    fs.writeFileSync(zipPath, buildRawZip(entries));
    const destDir = path.join(dataDir, 'dest-at-cap');
    fs.mkdirSync(destDir, { recursive: true });

    const result = await mod.extractZip(zipPath, destDir);
    expect(result).toHaveLength(mod.MAX_ZIP_ENTRIES);
  }, 15000);
});

describe('extractZip — symlink entries are safe by omission (Remy\'s hardening note, #2172 follow-up)', () => {
  it('writes a unix-symlink-flagged entry as an ordinary regular file containing the literal target string, never a real symlink', async () => {
    const { mod, dataDir } = await loadModule();
    const zipPath = path.join(dataDir, 'symlink.zip');
    fs.writeFileSync(zipPath, buildRawZip([
      {
        name: 'sneaky-link',
        content: '../../../etc/passwd', // what a real symlink entry stores as its "content": the target path
        externalFileAttributes: UNIX_SYMLINK_EXTERNAL_ATTRS,
      },
    ]));
    const destDir = path.join(dataDir, 'dest-symlink');
    fs.mkdirSync(destDir, { recursive: true });

    await mod.extractZip(zipPath, destDir);

    const written = path.join(destDir, 'sneaky-link');
    // isSymbolicLink() must be false -- lstat, not stat, so a real
    // symlink would be detected as such rather than followed.
    expect(fs.lstatSync(written).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(written).isFile()).toBe(true);
    // The "target path" was written as literal, inert text -- reading
    // this file never redirects anywhere.
    expect(fs.readFileSync(written, 'utf8')).toBe('../../../etc/passwd');
  });
});

describe('draft metadata + TTL sweep', () => {
  it('round-trips draft metadata written by writeDraftMeta through readDraftMeta', async () => {
    const { mod } = await loadModule();
    const plan = {
      suggestedTitle: 'Test', files: [], descriptionSource: null, profileCandidates: [], guessedSourceSite: null, licenseFile: null,
    };
    mod.writeDraftMeta({
      draftId: 'abc123', zipFilename: 'test.zip', createdAt: 1000, plan, ownerId: 'user-1',
    });
    expect(mod.readDraftMeta('abc123')).toEqual({
      draftId: 'abc123', zipFilename: 'test.zip', createdAt: 1000, plan, ownerId: 'user-1',
    });
  });

  it('returns null for a draft that was never created', async () => {
    const { mod } = await loadModule();
    expect(mod.readDraftMeta('does-not-exist')).toBeNull();
  });

  it('returns null and does not throw for a corrupt sidecar', async () => {
    const { mod } = await loadModule();
    const draftId = 'corrupt-1';
    fs.mkdirSync(mod.draftDirFor(draftId), { recursive: true });
    fs.writeFileSync(path.join(mod.draftDirFor(draftId), '.draft-meta.json'), '{ not valid json');
    expect(mod.readDraftMeta(draftId)).toBeNull();
  });

  it('deleteDraftDir removes the whole draft directory', async () => {
    const { mod } = await loadModule();
    const draftId = 'to-delete';
    fs.mkdirSync(mod.draftDirFor(draftId), { recursive: true });
    fs.writeFileSync(path.join(mod.draftDirFor(draftId), 'somefile.txt'), 'x');
    mod.deleteDraftDir(draftId);
    expect(fs.existsSync(mod.draftDirFor(draftId))).toBe(false);
  });

  it('sweepExpiredDrafts removes a draft older than the TTL and keeps a fresh one', async () => {
    const { mod } = await loadModule();
    const plan = {
      suggestedTitle: 'T', files: [], descriptionSource: null, profileCandidates: [], guessedSourceSite: null, licenseFile: null,
    };
    const now = 10_000_000;
    mod.writeDraftMeta({
      draftId: 'old', zipFilename: 'old.zip', createdAt: now - mod.DRAFT_TTL_MS - 1, plan, ownerId: 'user-1',
    });
    mod.writeDraftMeta({
      draftId: 'fresh', zipFilename: 'fresh.zip', createdAt: now - 1000, plan, ownerId: 'user-1',
    });

    const result = mod.sweepExpiredDrafts(now);
    expect(result).toEqual({ removed: 1, kept: 1 });
    expect(mod.readDraftMeta('old')).toBeNull();
    expect(mod.readDraftMeta('fresh')).not.toBeNull();
  });

  it('sweepExpiredDrafts treats a draft with a missing/corrupt sidecar as garbage and removes it regardless of age', async () => {
    const { mod } = await loadModule();
    const draftId = 'orphan';
    fs.mkdirSync(mod.draftDirFor(draftId), { recursive: true });
    fs.writeFileSync(path.join(mod.draftDirFor(draftId), 'some-extracted-file.stl'), 'bytes');
    // No .draft-meta.json at all -- simulates a crash mid-extraction.

    const result = mod.sweepExpiredDrafts(Date.now());
    expect(result.removed).toBe(1);
    expect(fs.existsSync(mod.draftDirFor(draftId))).toBe(false);
  });

  it('is safe to call on boot with zero existing drafts', async () => {
    const { mod } = await loadModule();
    expect(mod.sweepExpiredDrafts()).toEqual({ removed: 0, kept: 0 });
  });
});
