// Pure classifier for zip-based model import (#2171, Phase C of the
// "Local MakerWorld" restructure — see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md).
//
// Turns a flat list of zip entry paths into an editable draft import
// plan: suggested title, per-file role, likely description/license
// source, print-profile candidates, and a best-effort guess at which
// site the zip came from. No fs access, no Date.now(), no randomness —
// same input always produces the same output, by design (§ purity is
// the point, per the ticket). routes/modelImport.ts (C2) is the only
// place that reads the actual zip off disk; this module only decides
// the plan from the entry list it's handed, and separately marks
// entries that are unsafe to extract (C2 is the layer that actually
// enforces that — see `invalid` below).
//
// Ext-to-role mapping reuses classifyExt/MODEL_IMAGE_EXTS/MODEL_DOC_EXTS
// from services/modelConvert.ts (which itself reuses THREE_D_EXTS from
// routes/assets.ts) rather than a third, divergent extension list —
// see modelConvert.ts's own comment for why those two sets already
// exist and shouldn't grow a sibling.

import path from 'path';
import { classifyExt, MODEL_IMAGE_EXTS } from './modelConvert.js';
import { THREE_D_EXTS } from '../routes/assets.js';
import type { ModelFileRole } from './enumValidators.js';

// -----------------------------------------------------------------------
// Public types — this shape IS the contract for C2 (routes/modelImport.ts)
// and C3 (the ImportWizard UI). Both re-expose it via web/src/lib/api.ts
// unchanged; treat field renames here as a cross-ticket breaking change.
// -----------------------------------------------------------------------

// A zip entry's role in the resulting model. 'ignore' is not one of
// model_files.role's values (enumValidators.ts's MODEL_FILE_ROLES) —
// it's a classifier-only concept for entries that should never become
// a model_files row at all (macOS junk, bare directory markers). C2
// must drop 'ignore' entries before offering the plan for edit or
// committing it, not map them to 'other'.
export type ZipEntryRole = ModelFileRole | 'ignore';

export interface ZipEntryInput {
  // Relative path exactly as it appears in the zip's central directory
  // listing (whatever separator/case the archive tool wrote — this
  // module normalizes internally but never mutates what it echoes
  // back in `files[].path`, so C2 can match a plan entry back to the
  // real zip entry byte-for-byte).
  path: string;
  // Accepted for forward compatibility with C2 (size caps, dedup
  // hints) but NOT used by any classification heuristic below —
  // deliberately kept optional and inert here so this module's output
  // stays a pure function of `path` alone. Document any future
  // size-based heuristic at the point it's added, not here.
  size?: number;
}

export interface ClassifiedZipFile {
  path: string;
  role: ZipEntryRole;
  // True when `path` fails the zip-slip safety check (an absolute
  // path, or any `..` path segment, on either POSIX or Windows-style
  // separators). C2's extraction step MUST refuse to write any entry
  // with invalid=true, regardless of role — this flag is the one the
  // enforcement layer reads. The classifier still assigns a best-effort
  // `role` to invalid entries (informational, e.g. for the wizard to
  // show "rejected: would have been a part file") but callers must
  // never extract or link them.
  invalid: boolean;
  invalidReason?: 'absolute path' | 'path traversal (..)' | 'empty path';
}

export type GuessedSourceSite = 'makerworld' | 'printables' | 'thingiverse' | null;

export interface ZipImportPlan {
  // Derived from the zip's single common root folder if every entry
  // nests under one (de-slugged), else from the zip filename itself
  // (extension stripped, de-slugged). De-slugging = separator chars
  // (`_`/`-`/whitespace) become spaces, each word's first letter is
  // capitalized, the rest of the word is left as-is (so "MakerWorld"
  // stays "MakerWorld" rather than becoming "Makerworld") — same
  // convention as routes/sets.ts's titleCase.
  suggestedTitle: string;
  // Every input entry, in input order, one-to-one.
  files: ClassifiedZipFile[];
  // Path to the best README candidate (readme.md preferred over
  // readme.txt, case-insensitive, shallowest match wins ties), or null
  // if none exists. Invalid/junk/directory-marker entries are never
  // candidates.
  descriptionSource: string | null;
  // Paths that look like print-ready profiles: every .gcode file
  // (unconditional — that extension has no other meaning), plus any
  // .3mf whose filename or containing directory hints it's a sliced
  // project rather than a design mesh (name/dir contains "profile",
  // "sliced", "print_settings"/"printsettings", or sits directly under
  // a "profiles/" folder). This is a filename heuristic only — a pure
  // function over a path list can't inspect a .3mf's embedded slicer
  // XML to confirm it, so false negatives (a sliced .3mf with a plain
  // name) are expected and left to manual reassignment in the wizard.
  profileCandidates: string[];
  // Best-effort guess at the originating site from folder-shape alone.
  // null is the expected, non-failure result for any zip that doesn't
  // match one of the three known shapes (a random/manually-zipped
  // folder) — every file is still classified by extension regardless
  // of this field.
  guessedSourceSite: GuessedSourceSite;
  // Path to a detected LICENSE/LICENCE/COPYING file (any of
  // .md/.txt/no extension, case-insensitive, shallowest match wins),
  // or null if none exists.
  licenseFile: string | null;
}

// -----------------------------------------------------------------------
// Internal normalization
// -----------------------------------------------------------------------

interface NormalizedEntry {
  original: string;
  // Backslashes converted to forward slashes so path.posix.* and
  // segment-splitting behave the same regardless of which separator
  // the archive tool used (Windows-built zips commonly use `\`).
  normalized: string;
  invalid: boolean;
  invalidReason?: ClassifiedZipFile['invalidReason'];
  // __MACOSX/, .DS_Store, Thumbs.db, desktop.ini, AppleDouble "._*"
  // resource forks — real-world archive noise that should never
  // surface as an importable file, a description/license candidate,
  // or a signal in the site-shape heuristics below.
  isJunk: boolean;
  // A pure directory-listing entry (path ends in `/`, no file bytes
  // behind it). Not junk — it's a legitimate structural signal (a
  // zip that lists "files/" and "images/" explicitly is exactly the
  // Printables/Thingiverse shape) — but it can never be a description,
  // license, or profile candidate, and it's surfaced as role 'ignore'
  // rather than misclassified as 'other'.
  isDirMarker: boolean;
}

const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const README_RE = /^readme\.(md|txt)$/i;
const LICENSE_RE = /^(license|licence|copying)(\.(md|txt))?$/i;
const PROFILE_HINT_WORDS = ['profile', 'sliced', 'print_settings', 'printsettings'];

const JUNK_BASENAME_RE = /^(\.ds_store|thumbs\.db|desktop\.ini)$/i;

function isJunkPath(normalized: string): boolean {
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((seg) => seg.toUpperCase() === '__MACOSX')) return true;
  const base = segments[segments.length - 1] ?? '';
  if (JUNK_BASENAME_RE.test(base)) return true;
  if (base.startsWith('._')) return true; // macOS AppleDouble resource fork
  return false;
}

function pathSafetyIssue(normalized: string): ClassifiedZipFile['invalidReason'] | undefined {
  if (normalized.trim() === '') return 'empty path';
  if (normalized.startsWith('/') || WINDOWS_DRIVE_ABS_RE.test(normalized)) return 'absolute path';
  if (normalized.split('/').some((seg) => seg === '..')) return 'path traversal (..)';
  return undefined;
}

function normalizeEntry(rawPath: string): NormalizedEntry {
  const normalized = rawPath.replace(/\\/g, '/');
  const invalidReason = pathSafetyIssue(normalized);
  return {
    original: rawPath,
    normalized,
    invalid: invalidReason !== undefined,
    invalidReason,
    isJunk: isJunkPath(normalized),
    isDirMarker: normalized.endsWith('/'),
  };
}

function roleFor(entry: NormalizedEntry): ZipEntryRole {
  if (entry.isJunk || entry.isDirMarker) return 'ignore';
  return classifyExt(entry.normalized);
}

function segmentsOf(normalized: string): string[] {
  return normalized.split('/').filter(Boolean);
}

// -----------------------------------------------------------------------
// Title
// -----------------------------------------------------------------------

// A single folder every non-junk, non-invalid entry nests under (its
// own directory-marker entry, if the zip lists one explicitly, doesn't
// count against this — a lone "Cool_Model/" listing is consistent
// with everything else nesting under "Cool_Model", not evidence
// against it). Returns null when entries sit at mixed depths (no
// single wrapping folder), which is the common case for a zip built
// by selecting multiple top-level files/folders rather than one.
function findCommonRootFolder(usable: NormalizedEntry[]): string | null {
  const contentish = usable.filter((e) => !(e.isDirMarker && segmentsOf(e.normalized).length === 1));
  if (contentish.length === 0) return null;
  const candidate = segmentsOf(contentish[0].normalized)[0];
  if (!candidate) return null;
  const allNested = contentish.every((e) => {
    const segs = segmentsOf(e.normalized);
    return segs.length >= 2 && segs[0] === candidate;
  });
  return allNested ? candidate : null;
}

function deslugTitle(raw: string): string {
  const words = raw.split(/[_\-\s]+/).filter(Boolean);
  if (words.length === 0) return raw;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function stripZipExt(filename: string): string {
  return filename.replace(/\.zip$/i, '');
}

// -----------------------------------------------------------------------
// Description / license / profile candidates
// -----------------------------------------------------------------------

function pickShallowest(
  candidates: NormalizedEntry[],
  extPriority?: (ext: string) => number,
): string | null {
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((e) => ({
      entry: e,
      depth: segmentsOf(e.normalized).length,
      ext: path.posix.extname(e.normalized).toLowerCase(),
    }))
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (extPriority) {
        const diff = extPriority(a.ext) - extPriority(b.ext);
        if (diff !== 0) return diff;
      }
      return 0; // stable sort preserves original input order beyond this
    });
  return ranked[0].entry.original;
}

function findDescriptionSource(files: NormalizedEntry[]): string | null {
  const candidates = files.filter((e) => README_RE.test(path.posix.basename(e.normalized)));
  return pickShallowest(candidates, (ext) => (ext === '.md' ? 0 : 1));
}

function findLicenseFile(files: NormalizedEntry[]): string | null {
  const candidates = files.filter((e) => LICENSE_RE.test(path.posix.basename(e.normalized)));
  return pickShallowest(candidates);
}

function isProfileCandidate(entry: NormalizedEntry): boolean {
  const ext = path.posix.extname(entry.normalized).toLowerCase();
  if (ext === '.gcode') return true;
  if (ext === '.3mf') {
    const base = path.posix.basename(entry.normalized).toLowerCase();
    if (PROFILE_HINT_WORDS.some((hint) => base.includes(hint))) return true;
    const dirSegments = segmentsOf(path.posix.dirname(entry.normalized)).map((s) => s.toLowerCase());
    if (dirSegments.includes('profiles')) return true;
  }
  return false;
}

// -----------------------------------------------------------------------
// Source-site structural heuristics
// -----------------------------------------------------------------------

function topLevelDirNames(usable: NormalizedEntry[], root: string | null): Set<string> {
  const names = new Set<string>();
  for (const e of usable) {
    const stripped = root ? e.normalized.slice(root.length + 1) : e.normalized;
    const segs = segmentsOf(stripped);
    if (e.isDirMarker) {
      if (segs.length >= 1) names.add(segs[0].toLowerCase());
    } else if (segs.length >= 2) {
      names.add(segs[0].toLowerCase());
    }
  }
  return names;
}

function detectSourceSite(usable: NormalizedEntry[], files: NormalizedEntry[], root: string | null): GuessedSourceSite {
  const topDirs = topLevelDirNames(usable, root);
  const hasFilesDir = topDirs.has('files');
  const hasImagesDir = topDirs.has('images');

  const rootLevelFiles = files
    .map((e) => (root ? e.normalized.slice(root.length + 1) : e.normalized))
    .filter((stripped) => segmentsOf(stripped).length === 1);

  const hasRootReadme = rootLevelFiles.some((p) => README_RE.test(path.posix.basename(p)));
  const hasRootLicenseTxt = rootLevelFiles.some((p) => path.posix.basename(p).toLowerCase() === 'license.txt');
  const topLevelHasModel = rootLevelFiles.some((p) => THREE_D_EXTS.has(path.posix.extname(p).toLowerCase()));
  const topLevelHasImage = rootLevelFiles.some((p) => MODEL_IMAGE_EXTS.has(path.posix.extname(p).toLowerCase()));

  if (hasFilesDir && hasImagesDir && hasRootReadme) return 'printables';
  if (hasFilesDir && hasImagesDir && hasRootLicenseTxt) return 'thingiverse';
  if (!hasFilesDir && !hasImagesDir && topLevelHasModel && topLevelHasImage) return 'makerworld';
  return null;
}

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

export function classifyZipEntries(entries: ZipEntryInput[], zipFilename: string): ZipImportPlan {
  const normalized = entries.map((e) => normalizeEntry(e.path));

  // "Usable" = safe to reason about structurally (includes directory
  // markers, excludes junk and unsafe paths). "Files" = usable AND an
  // actual file (excludes bare directory markers too) — the set that
  // can be a description/license/profile candidate.
  const usable = normalized.filter((e) => !e.invalid && !e.isJunk);
  const files = usable.filter((e) => !e.isDirMarker);

  const root = findCommonRootFolder(usable);
  const titleSource = root ?? stripZipExt(path.posix.basename(zipFilename.replace(/\\/g, '/')));
  const suggestedTitle = deslugTitle(titleSource) || 'Untitled Import';

  const plan: ZipImportPlan = {
    suggestedTitle,
    files: normalized.map((e) => ({
      path: e.original,
      role: roleFor(e),
      invalid: e.invalid,
      ...(e.invalidReason ? { invalidReason: e.invalidReason } : {}),
    })),
    descriptionSource: findDescriptionSource(files),
    profileCandidates: files.filter(isProfileCandidate).map((e) => e.original),
    guessedSourceSite: detectSourceSite(usable, files, root),
    licenseFile: findLicenseFile(files),
  };

  return plan;
}
