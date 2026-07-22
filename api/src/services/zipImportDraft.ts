// Scratch-disk lifecycle for zip import drafts (#2172, Phase C of the
// "Local MakerWorld" restructure — see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md).
// Owns everything C1's pure classifier (services/zipImportClassify.ts)
// deliberately doesn't: touching the filesystem — where a draft's
// extracted files live, the zip-slip containment check that gates every
// write, and the abandoned-draft TTL sweep.
//
// Draft layout, all under config.dataDir (see below for why):
//   <dataDir>/import-scratch/<uuid>.zip   -- multer diskStorage target for
//                                             the raw upload; deleted right
//                                             after it's read
//   <dataDir>/import-drafts/<draftId>/    -- extracted contents, preserving
//     .draft-meta.json                       the zip's relative paths, plus
//     <...extracted files...>                a sidecar recording the
//                                             original classification plan
//                                             and creation time
//
// Why config.dataDir and not config.storageDir: docker-compose.production.yml
// maps STORAGE_DIR to /app/storage, which is the CIFS Unraid NAS mount (see
// that file's own header comment), while DATA_DIR maps to /app/data ->
// /var/lib/fabvault/db, a local ext4 disk -- "SQLite requires POSIX
// locking" per that same comment. A scratch zip and its mid-extraction
// writes need the identical guarantee (atomic rename, reliable fsync), so
// they get the identical disk, never the NAS mount.
//
// No background timers here, ever (#2078, "no background filesystem
// scanning" hard lesson). sweepExpiredDrafts() is only ever invoked by its
// two call sites — index.ts on boot, routes/modelImport.ts right before
// creating a new draft — both explicit, neither on an interval.

import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import { config } from '../config.js';
import type { ZipImportPlan } from './zipImportClassify.js';

// 48h: generous enough that someone picking through a half-finished
// import wizard across a weekend doesn't lose their in-progress edits,
// bounded enough that an abandoned draft doesn't sit on disk
// indefinitely. Tune here if it turns out to be wrong in practice --
// this is the only place the number lives.
export const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

// Multer's own limit on the raw (compressed) upload -- matches the
// existing 1 GB ceiling routes/models.ts's file-attach upload already
// uses, rather than inventing a different number with no basis.
export const MAX_ZIP_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB

// Applied against the running SUM of each entry's declared
// uncompressedSize while extracting -- a cheap zip-bomb guard (a tiny
// compressed file that unpacks to far more than this aborts instead of
// filling the disk). yauzl's own AssertByteCountStream already aborts if
// the ACTUAL decompressed bytes exceed an entry's DECLARED
// uncompressedSize (a shrink-then-lie bomb is defended by the library
// itself), so this cap's real job is bounding total legitimate content,
// not distrusting yauzl's per-entry accounting (Vera's security review,
// #2172 follow-up).
export const MAX_ZIP_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

// Caps entry COUNT, independent of MAX_ZIP_UNCOMPRESSED_BYTES, which only
// bounds cumulative bytes and does nothing against a small, valid archive
// containing tens of thousands of zero-byte entries -- confirmed
// empirically (Vera, #2172 security review) to take 53s and create 60,000
// real files on disk for a ~5.7MB upload, with the byte cap never
// engaging. 2,000 is generous for anything a real MakerWorld/Printables/
// Thingiverse export would ever contain -- a legitimate model zip is
// files + a handful of images + maybe a few profiles, not thousands of
// entries.
export const MAX_ZIP_ENTRIES = 2000;

export class ZipTooLargeError extends Error {}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function scratchRootDir(): string {
  return ensureDir(path.join(config.dataDir, 'import-scratch'));
}

export function draftsRootDir(): string {
  return ensureDir(path.join(config.dataDir, 'import-drafts'));
}

export function draftDirFor(draftId: string): string {
  return path.join(draftsRootDir(), draftId);
}

function draftMetaPath(draftId: string): string {
  return path.join(draftDirFor(draftId), '.draft-meta.json');
}

export interface DraftMeta {
  draftId: string;
  zipFilename: string;
  createdAt: number; // ms epoch
  plan: ZipImportPlan;
  // Set from req.user!.id at draft creation (Vera's security review,
  // #2172 follow-up, HIGH finding — Phase D blocker closed now while
  // it's still a design decision, not a migration). requireAuth only
  // proves SOME valid session exists, not that the caller created THIS
  // draft; routes/modelImport.ts's commit/DELETE handlers check this
  // against req.user!.id (or an admin role) before doing anything else.
  // Inert today (single admin user) but load-bearing the moment a
  // second household user exists.
  ownerId: string;
}

export function writeDraftMeta(meta: DraftMeta): void {
  fs.mkdirSync(draftDirFor(meta.draftId), { recursive: true });
  fs.writeFileSync(draftMetaPath(meta.draftId), JSON.stringify(meta), 'utf8');
}

// Returns null for a missing OR corrupt sidecar -- both are treated as
// "no usable draft" by every caller. A corrupt sidecar can only mean a
// crash mid-write, which sweepExpiredDrafts also treats as garbage to
// remove, never as a draft to trust.
export function readDraftMeta(draftId: string): DraftMeta | null {
  try {
    const raw = fs.readFileSync(draftMetaPath(draftId), 'utf8');
    return JSON.parse(raw) as DraftMeta;
  } catch {
    return null;
  }
}

export function deleteDraftDir(draftId: string): void {
  fs.rmSync(draftDirFor(draftId), { recursive: true, force: true });
}

// The zip-slip ENFORCEMENT layer. Deliberately a separate implementation
// from zipImportClassify.ts's string-based ".."/absolute-path check, not
// a shared helper -- that module's check is a cheap heuristic for early,
// informational feedback (flagging a plan entry for the wizard to show
// as excluded); this one, built on path.resolve()'s own canonicalization
// against a real base directory, is the actual boundary nothing is ever
// written across or read back from. Two independently-written checks
// catching the same class of attack is the point -- a bug in one is
// unlikely to be mirrored in the other. Used both during extraction
// (skip unsafe entries) and again at commit time (re-validate every
// client-submitted path before touching it) -- see routes/modelImport.ts.
//
// Note this is real POSIX containment, not a generic cross-platform
// check: a Windows-style "C:\..." entry is NOT rejected here, because on
// this Linux/ext4-only deployment (see header) path.resolve() has no
// concept of a drive letter — "C:/Windows/..." just joins as an ordinary
// subpath that stays fully inside baseDir. The classifier flags that
// shape as invalid anyway on a conservative string heuristic (same
// accepted reasoning as its "C:evil" case, Remy's C1 review), but this
// function's job is the actual containment truth on the filesystem it
// runs on, and on POSIX that shape genuinely never escapes.
//
// Also rejects any path containing a NUL byte (Vera's security review,
// #2172 follow-up, CRITICAL finding): path.resolve() itself does NOT
// throw on an embedded '\0' (confirmed empirically) and would happily
// hand back a "contained" result -- the crash instead happens later,
// synchronously, inside fs.mkdirSync/fs.createWriteStream, which DO
// throw ERR_INVALID_ARG_VALUE on a NUL byte. Catching it here, in the
// same function that already rejects traversal/absolute paths, means
// extractZip's per-entry fs calls never see one at all -- belt AND
// suspenders alongside the try/catch extractZip also now has around
// those same calls (a synchronous throw from some OTHER cause, e.g. an
// ordinary file/directory name collision, isn't a "path" problem this
// function can characterize, so it's caught there instead).
export function resolveContainedPath(baseDir: string, rawEntryPath: string): string | null {
  if (rawEntryPath.includes('\0')) return null;
  const cleaned = rawEntryPath.replace(/\\/g, '/');
  const resolved = path.resolve(baseDir, cleaned);
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (resolved !== baseDir && !resolved.startsWith(baseWithSep)) return null;
  return resolved;
}

export interface RawZipEntry {
  path: string;
  size: number;
}

// decodeStrings:false is deliberate, not a default left alone. yauzl's
// OWN default validation (services/zipImportClassify.ts-adjacent logic
// baked into the library itself — see its validateFileName) rejects an
// absolute path or a ".." segment by emitting a fatal 'error' on the
// WHOLE zipfile the moment it decodes such an entry — it does not skip
// that one entry and keep going. That default is exactly wrong for this
// feature: a single hostile entry would kill the entire import instead
// of the plan showing it excluded alongside every legitimate file (the
// wizard UX the ticket calls for). Passing decodeStrings:false disables
// that built-in check entirely and hands back `entry.fileName` as a raw
// Buffer instead of a validated string — we decode it ourselves (below)
// and apply our OWN containment check per entry via resolveContainedPath,
// which is where the safety decision now fully lives. One known,
// accepted gap from doing our own decoding: yauzl's decodeBuffer would
// pick cp437 vs utf8 per entry based on the general-purpose bit flag;
// our manual `.toString('utf8')` always assumes utf8. Fine for this
// app's filenames in practice (ASCII-heavy 3D model/image filenames);
// a legacy zip tool using cp437 for accented filenames could mis-decode
// — no reports of this in practice, revisit if it ever surfaces.
function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zipfile) => {
      if (err || !zipfile) { reject(err ?? new Error('Failed to open zip file')); return; }
      resolve(zipfile);
    });
  });
}

// Single read-through of the archive: records every entry exactly as it
// appears in the zip's central directory -- including unsafe ones, so the
// classifier downstream can flag them for the wizard -- while extracting
// only the entries that pass resolveContainedPath to destDir. Unsafe
// entries are silently skipped on disk; they still come back in the
// returned list, which is what feeds classifyZipEntries and lets its
// `invalid` flag reach the wizard.
//
// Symlink entries are safe BY OMISSION, deliberately -- not by any
// explicit check -- and that omission must stay in place (Remy's C1/C2
// review, #2172 follow-up): entry.externalFileAttributes (where a
// unix-built zip stores the symlink mode bit, S_IFLNK, in its upper 16
// bits) is never read anywhere in this function. Every non-directory
// entry, symlink or not, is written via fs.createWriteStream as an
// ordinary regular file containing whatever bytes the archive stored for
// it -- for a real symlink entry, that's just the link-target path as
// literal text, not an actual filesystem symlink. There is no
// traversal-via-symlink vector as a result: nothing this function ever
// creates can be followed out of destDir. If a future change ever starts
// honoring externalFileAttributes to recreate real symlinks, it MUST
// re-run every target through resolveContainedPath first, with the same
// rigor as file entries get here -- see the regression test in
// zipImportDraft.test.ts pinning the current (safe) behavior.
// Error-code triage for the per-entry try/catch below (Vera's security
// review, #2172 catch-triage follow-up, MEDIUM -- found by attacking the
// prior fix round). The earlier fix treated every caught error the same
// way -- skip this one entry, keep going -- which silently absorbed a
// genuinely ENVIRONMENTAL failure (disk full, quota exceeded, permission
// denied) as if it were just one more malformed entry. That's the wrong
// call: dataDir shares its disk with the production SQLite DB (see this
// file's header), so a household running low on space deserves a loud,
// clear extraction failure, not a plan quietly missing some files with
// no signal why. This set is deliberately narrow and code-based, listing
// only the codes that mean "this ONE entry's path/name is unwritable for
// a reason baked into the entry itself" -- everything else, INCLUDING
// any code this set doesn't recognize, aborts the whole extraction
// (fail-closed on observability, not fail-open: an unclassified error is
// treated as a signal something is wrong with the environment, not
// shrugged off as another bad filename).
const SKIP_ENTRY_ERROR_CODES = new Set([
  'EEXIST', // mkdirSync where a FILE already sits at that path
  'ENOTDIR', // a path component that should be a directory is a file
  'EISDIR', // a DIRECTORY already sits where a file entry wants to write (both the real syscall code and the synthetic code this module attaches to its own pre-check error just below)
  'ERR_INVALID_ARG_VALUE', // NUL byte or similarly malformed path string (belt-and-suspenders -- resolveContainedPath already rejects NUL bytes before reaching here)
]);

function isSkippableEntryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && SKIP_ENTRY_ERROR_CODES.has(code);
}

export async function extractZip(zipPath: string, destDir: string): Promise<RawZipEntry[]> {
  const entries: RawZipEntry[] = [];
  const zipfile = await openZip(zipPath);
  let totalUncompressed = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch { /* already closing/closed */ }
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Triages a caught fs error from the per-entry handler below (Vera's
    // security review, #2172 follow-up, CRITICAL finding + catch-triage
    // follow-up MEDIUM finding). Every fs call inside the 'entry' handler
    // used to be an unguarded synchronous call; yauzl invokes that
    // handler from its own internal fs-read callback chain, outside this
    // Promise executor's own call stack, so a throw there was a true
    // UNCAUGHT exception -- not a rejected promise, not caught by this
    // function's fail()/reject() at all. Confirmed crash triggers: a NUL
    // byte in an entry name (ERR_INVALID_ARG_VALUE) and an ordinary
    // file/directory name collision, e.g. "foo" as a file followed by
    // "foo/bar.stl" implying foo must be a directory (EEXIST). Both are
    // full-process crashes via processGuards.ts's uncaughtException
    // handler (#2044) — a single authenticated upload, no auth bypass,
    // no cleverness, malformed zips included, not just malicious ones.
    //
    // Catching the exception was only half the fix: whether to SKIP just
    // this entry (entry-shape problem, see SKIP_ENTRY_ERROR_CODES above)
    // or FAIL the whole extraction (environmental problem -- disk full,
    // quota, permissions) is decided here, not assumed. Skipping
    // everything uniformly is what let a genuine ENOSPC/EACCES silently
    // absorb as "some entries skipped" with zero signal it ever
    // happened -- exactly the disk-fill scenario this file's own header
    // comment already worries about (dataDir shares its disk with the
    // production SQLite DB).
    function handleEntryFsError(fileName: string, err: unknown): void {
      const message = err instanceof Error ? err.message : String(err);
      if (isSkippableEntryError(err)) {
        console.warn(`[zipImportDraft] Skipping unwritable entry (${fileName}): ${message}`);
        zipfile.readEntry();
        return;
      }
      fail(new Error(`Zip extraction aborted -- unexpected error on entry "${fileName}": ${message}`));
    }

    zipfile.on('error', fail);
    zipfile.on('end', succeed);
    zipfile.on('entry', (entry: yauzl.Entry) => {
      // decodeStrings:false (see openZip above) means fileName arrives as
      // a raw Buffer -- decode it ourselves; this is the one and only
      // place that decoding happens for the rest of this function.
      const fileName = (entry.fileName as unknown as Buffer).toString('utf8');
      entries.push({ path: fileName, size: entry.uncompressedSize });

      // Entry-COUNT cap, independent of the byte cap below (Vera's
      // security review, #2172 follow-up, MEDIUM finding) -- a small,
      // entirely valid zip with tens of thousands of zero-byte entries
      // sails past MAX_ZIP_UNCOMPRESSED_BYTES (which only bounds
      // cumulative declared size) while still taking the better part of
      // a minute and creating that many real files on disk. Checked
      // before the byte-cap check below so a huge-entry-count,
      // near-zero-byte zip is rejected on the cheaper, more specific
      // signal first.
      if (entries.length > MAX_ZIP_ENTRIES) {
        fail(new ZipTooLargeError(`Zip exceeds the ${MAX_ZIP_ENTRIES}-entry cap`));
        return;
      }

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
        fail(new ZipTooLargeError(
          `Zip exceeds the ${MAX_ZIP_UNCOMPRESSED_BYTES}-byte uncompressed size cap`,
        ));
        return;
      }

      const isDir = fileName.endsWith('/');
      const dest = resolveContainedPath(destDir, fileName);

      if (!dest) {
        // Zip-slip (or NUL-byte) candidate -- never written, regardless
        // of what the classifier later decides to call it.
        zipfile.readEntry();
        return;
      }

      if (isDir) {
        try {
          fs.mkdirSync(dest, { recursive: true });
        } catch (err) {
          handleEntryFsError(fileName, err);
          return;
        }
        zipfile.readEntry();
        return;
      }

      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
      } catch (err) {
        handleEntryFsError(fileName, err);
        return;
      }

      // The REVERSE type-collision (a directory already sits at `dest`,
      // e.g. an earlier entry "foo/bar.stl" implied "foo" must be a
      // directory, and THIS entry is a plain file also named "foo"):
      // fs.createWriteStream's own EISDIR failure for that case doesn't
      // throw synchronously at all -- it surfaces asynchronously via the
      // stream's own 'error' event (already wired to fail() below),
      // which is not a crash, but WOULD reject the whole extraction over
      // one bad entry, same problem this whole fix round exists to close
      // for the synchronous cases. Checking for it explicitly here, with
      // an explicit code: 'EISDIR' so handleEntryFsError's triage
      // classifies it the same as the real syscall error it's standing
      // in for, keeps both collision directions symmetric.
      if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
        const collisionErr = new Error(`refusing to overwrite an existing directory with a file: ${fileName}`) as NodeJS.ErrnoException;
        collisionErr.code = 'EISDIR';
        handleEntryFsError(fileName, collisionErr);
        return;
      }

      let writeStream: fs.WriteStream;
      try {
        writeStream = fs.createWriteStream(dest);
      } catch (err) {
        handleEntryFsError(fileName, err);
        return;
      }

      zipfile.openReadStream(entry, (err, readStream) => {
        if (err) { fail(err); return; }
        readStream.on('error', fail);
        writeStream.on('error', fail);
        writeStream.on('close', () => zipfile.readEntry());
        readStream.pipe(writeStream);
      });
    });

    zipfile.readEntry();
  });

  return entries;
}

// Boot-time + new-draft-creation sweep (never a timer -- see header).
// Treats a draft as expired if its sidecar says so, and treats a draft
// with a MISSING or corrupt sidecar as orphaned garbage from a crash
// mid-write -- same removal, no separate code path, since both cases
// mean "nothing recoverable here."
export function sweepExpiredDrafts(now: number = Date.now()): { removed: number; kept: number } {
  const root = draftsRootDir();
  let removed = 0;
  let kept = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const draftId = entry.name;
    const meta = readDraftMeta(draftId);
    const expired = !meta || now - meta.createdAt > DRAFT_TTL_MS;
    if (expired) {
      try {
        deleteDraftDir(draftId);
        removed += 1;
      } catch (err) {
        console.error(`[zipImportDraft] Failed to remove expired draft ${draftId}:`, err);
      }
    } else {
      kept += 1;
    }
  }
  return { removed, kept };
}
