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
// filling the disk). Not a hardened defense (a crafted central directory
// could still lie about sizes), but proportionate to this app's threat
// model -- "internal-only app; multi-user = trusted household users"
// (plan §Hard constraints) -- and layered on top of, not instead of, the
// zip-slip containment check below, which IS the hard security boundary.
export const MAX_ZIP_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

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
export function resolveContainedPath(baseDir: string, rawEntryPath: string): string | null {
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

    zipfile.on('error', fail);
    zipfile.on('end', succeed);
    zipfile.on('entry', (entry: yauzl.Entry) => {
      // decodeStrings:false (see openZip above) means fileName arrives as
      // a raw Buffer -- decode it ourselves; this is the one and only
      // place that decoding happens for the rest of this function.
      const fileName = (entry.fileName as unknown as Buffer).toString('utf8');
      entries.push({ path: fileName, size: entry.uncompressedSize });

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
        // Zip-slip candidate -- never written, regardless of what the
        // classifier later decides to call it.
        zipfile.readEntry();
        return;
      }

      if (isDir) {
        fs.mkdirSync(dest, { recursive: true });
        zipfile.readEntry();
        return;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err) { fail(err); return; }
        const writeStream = fs.createWriteStream(dest);
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
