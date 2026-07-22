import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileArchive, Upload, CheckCircle, XCircle, AlertTriangle, Loader, ExternalLink, X,
} from 'lucide-react';
import { useCategories } from '../hooks/useCategories.js';
import { TagInput } from '../components/TagInput.js';
import { buildCategoryOptions } from '../lib/categoryTree.js';
import { isSafeUrl } from '../lib/markdown.js';
import { api } from '../lib/api.js';
import type {
  ZipImportDraftResponse, ZipImportPlan, ZipImportCommitBody, ZipImportCommitResult,
  ZipImportCommitFileResult, ModelFileRole, GuessedSourceSite,
} from '../lib/api.js';

// Zip ImportWizard (#2173, Phase C of the "Local MakerWorld" restructure --
// see Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md).
// Upload a downloaded MakerWorld/Printables/Thingiverse zip -> edit the
// server's classified draft plan -> commit into a real model. Three-step,
// plain component state (no custom hook) -- same "logic lives in the
// component" convention as ConvertWizardPage.tsx (#2170)/OrphansModal.tsx/
// DuplicatesModal.tsx, not a custom hook, since none of this state is
// needed anywhere else.
//
// Builds against api/src/routes/modelImport.ts (C2, #2172) and
// api/src/services/zipImportClassify.ts (C1, #2171) exactly as mirrored in
// lib/api.ts's Zip Import section -- see that file's own header comment
// for the "this shape IS the contract" note. One deliberate scope
// decision worth flagging: ZipImportPlan.descriptionSource/licenseFile are
// PATHS inside the draft, not file CONTENT -- there is no API route that
// serves a draft file's bytes back to the client before commit (by
// design: routes/modelImport.ts only ever exposes create/commit/abandon
// for a draft). The description/license fields below are therefore
// editable free text with a "detected at <path>" hint, never a
// pre-filled copy of the README/LICENSE text itself -- surfacing a path
// the wizard can't actually show the contents of as if it were the real
// text would be a fabricated-content bug, not a convenience.
type Step = 'upload' | 'plan' | 'results';

// 'exclude' is wizard-only -- never sent to the server as a role. A file
// set to 'exclude' is simply omitted from the commit body's `files`
// array entirely (see buildCommitBody below).
type WizardRole = ModelFileRole | 'exclude';

const ROLE_OPTIONS: Array<{ value: WizardRole; label: string }> = [
  { value: 'part', label: 'Part' },
  { value: 'image', label: 'Image' },
  { value: 'doc', label: 'Doc' },
  { value: 'other', label: 'Other' },
  { value: 'exclude', label: 'Exclude' },
];

// Human-cased for the sourceSite text field -- same casing convention the
// classifier itself documents ("MakerWorld" stays "MakerWorld", see
// zipImportClassify.ts's deslugTitle comment) and matches
// EditDetailsModal's own placeholder example ("Source site (e.g.
// Printables)") on ModelPage.
const GUESSED_SITE_LABELS: Record<NonNullable<GuessedSourceSite>, string> = {
  makerworld: 'MakerWorld',
  printables: 'Printables',
  thingiverse: 'Thingiverse',
};

const OUTCOME_LABELS: Record<ZipImportCommitFileResult['outcome'], string> = {
  created: 'Created',
  'linked-existing': 'Linked existing',
  'merged-duplicate': 'Merged duplicate',
};

// Duplicated locally rather than pulled into a shared lib -- this exact
// three-line helper already exists independently in AssetCard.tsx,
// ModelPage.tsx, DuplicatesModal.tsx (as formatBytes), VersionPanel.tsx,
// and TrashView.tsx; matching that established (if repetitive) convention
// rather than introducing a new shared module this ticket doesn't need.
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function basename(zipPath: string): string {
  const cleaned = zipPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

function outcomeIcon(outcome: ZipImportCommitFileResult['outcome']) {
  if (outcome === 'created') return <CheckCircle size={14} className="text-green-600 dark:text-green-400 flex-shrink-0" />;
  if (outcome === 'linked-existing') return <ExternalLink size={14} className="text-blue-500 flex-shrink-0" />;
  return <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />; // merged-duplicate
}

const inputClass = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent';

interface PlanFormState {
  title: string;
  tags: string[];
  categoryId: string;
  description: string;
  sourceUrl: string;
  sourceSite: string;
  sourceAuthor: string;
  license: string;
  roles: Map<string, WizardRole>;
  profilePaths: Set<string>;
  coverPath: string | null;
}

function initialFormState(plan: ZipImportPlan): PlanFormState {
  const roles = new Map<string, WizardRole>();
  for (const f of plan.files) {
    if (f.invalid) continue; // permanently excluded -- never editable, never in the map
    if (f.role === 'ignore') continue; // junk/dir marker -- never shown as a row at all
    roles.set(f.path, f.role);
  }

  const profilePaths = new Set(plan.profileCandidates.filter((p) => roles.has(p)));
  const firstImage = plan.files.find((f) => !f.invalid && f.role === 'image');

  return {
    title: plan.suggestedTitle,
    tags: [],
    categoryId: '',
    description: '',
    sourceUrl: '',
    sourceSite: plan.guessedSourceSite ? GUESSED_SITE_LABELS[plan.guessedSourceSite] : '',
    sourceAuthor: '',
    license: '',
    roles,
    profilePaths,
    coverPath: firstImage ? firstImage.path : null,
  };
}

export function ImportWizardPage() {
  const navigate = useNavigate();
  const { categories } = useCategories();
  const categoryOptions = buildCategoryOptions(categories);

  const [step, setStep] = useState<Step>('upload');

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [zipFilename, setZipFilename] = useState('');
  const [plan, setPlan] = useState<ZipImportPlan | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const [form, setForm] = useState<PlanFormState | null>(null);

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [result, setResult] = useState<ZipImportCommitResult | null>(null);

  // Tracks the current draft's lifecycle for the unmount cleanup below --
  // a ref (not state) because the cleanup closure must read the LATEST
  // value at unmount time, not whatever was captured when the effect was
  // installed.
  const draftLifecycle = useRef<{ id: string | null; finalized: boolean }>({ id: null, finalized: false });
  useEffect(() => {
    draftLifecycle.current.id = draftId;
  }, [draftId]);

  useEffect(() => () => {
    const { id, finalized } = draftLifecycle.current;
    if (id && !finalized) {
      // Best-effort only, per the ticket's "on wizard unmount with an
      // in-flight draft, best-effort delete" requirement -- this only
      // actually completes for an in-app route change (a real tab
      // close/reload can't be awaited from inside an unmount cleanup).
      // zipImportDraft.ts's 48h DRAFT_TTL_MS sweep is the backstop for
      // that case, so this is a courtesy early cleanup, not the only
      // cleanup path a draft ever gets.
      api.import.abandon(id).catch(() => {});
    }
  }, []);

  async function handleFileSelected(file: File) {
    setUploadError(null);
    setUploading(true);
    setUploadProgress(0);
    try {
      const draft: ZipImportDraftResponse = await api.import.uploadZip(file, {
        onProgress: (loaded, total) => setUploadProgress(total > 0 ? Math.round((loaded / total) * 100) : 0),
      });
      setDraftId(draft.draftId);
      setZipFilename(draft.zipFilename);
      setPlan(draft.plan);
      setExpiresAt(draft.expiresAt);
      setForm(initialFormState(draft.plan));
      setCommitError(null);
      setResult(null);
      setStep('plan');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function patchForm(patch: Partial<PlanFormState>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function setRole(path: string, role: WizardRole) {
    setForm((prev) => {
      if (!prev) return prev;
      const roles = new Map(prev.roles);
      roles.set(path, role);
      let coverPath = prev.coverPath;
      if (role !== 'image' && coverPath === path) coverPath = null;
      let profilePaths = prev.profilePaths;
      if (role === 'exclude' && profilePaths.has(path)) {
        profilePaths = new Set(profilePaths);
        profilePaths.delete(path);
      }
      return { ...prev, roles, coverPath, profilePaths };
    });
  }

  function toggleProfile(path: string) {
    setForm((prev) => {
      if (!prev) return prev;
      const profilePaths = new Set(prev.profilePaths);
      if (profilePaths.has(path)) profilePaths.delete(path); else profilePaths.add(path);
      return { ...prev, profilePaths };
    });
  }

  async function handleCancel() {
    draftLifecycle.current.finalized = true; // prevents a double-abandon from the unmount cleanup below
    if (draftId) {
      try { await api.import.abandon(draftId); } catch { /* best-effort */ }
    }
    navigate('/');
  }

  function startOver() {
    setStep('upload');
    setDraftId(null);
    setZipFilename('');
    setPlan(null);
    setExpiresAt(null);
    setForm(null);
    setCommitError(null);
    setResult(null);
    setUploadError(null);
    setUploadProgress(0);
    draftLifecycle.current = { id: null, finalized: false };
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  if (!plan || !form) {
    return renderUploadStep();
  }

  // Visible rows = every invalid entry (any role -- shown permanently
  // excluded with its reason) PLUS every valid, non-'ignore' entry.
  // Valid 'ignore' entries (macOS junk / bare directory markers) are
  // never rendered as rows at all -- they carry no reassignable role and
  // showing one row per __MACOSX/.DS_Store entry would bury the files
  // that actually matter. A one-line count still surfaces that they were
  // dropped, so nothing silently vanishes without a trace.
  const visibleFiles = plan.files.filter((f) => f.invalid || f.role !== 'ignore');
  const junkCount = plan.files.filter((f) => !f.invalid && f.role === 'ignore').length;
  const includedFiles = visibleFiles.filter((f) => !f.invalid && form.roles.get(f.path) !== 'exclude');
  const sourceUrlTrimmed = form.sourceUrl.trim();
  const sourceUrlValid = sourceUrlTrimmed === '' || isSafeUrl(sourceUrlTrimmed);
  const canCommit = form.title.trim() !== '' && includedFiles.length > 0 && sourceUrlValid && !committing;

  function buildCommitBody(): ZipImportCommitBody {
    return {
      title: form!.title.trim(),
      description: form!.description.trim() || null,
      categoryId: form!.categoryId || null,
      tags: form!.tags,
      sourceUrl: sourceUrlTrimmed || null,
      sourceSite: form!.sourceSite.trim(),
      sourceAuthor: form!.sourceAuthor.trim() || null,
      license: form!.license.trim() || null,
      files: includedFiles.map((f) => ({ path: f.path, role: form!.roles.get(f.path) as ModelFileRole })),
      coverPath: form!.coverPath,
      profiles: [...form!.profilePaths]
        .filter((p) => includedFiles.some((f) => f.path === p))
        .map((p) => ({ path: p })),
    };
  }

  async function handleCommit() {
    if (!draftId) return;
    if (!form!.title.trim()) { setCommitError('Title is required'); return; }
    if (includedFiles.length === 0) { setCommitError('At least one file must be included'); return; }
    if (!sourceUrlValid) { setCommitError('Source URL must be a valid http(s) link'); return; }

    setCommitting(true);
    setCommitError(null);
    try {
      const commitResult = await api.import.commit(draftId, buildCommitBody());
      draftLifecycle.current.finalized = true;
      setResult(commitResult);
      setStep('results');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  function renderUploadStep() {
    return (
      <div className="flex flex-col h-full bg-surface overflow-hidden">
        {header('upload')}
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          <div className="max-w-xl mx-auto space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Upload a zip downloaded from MakerWorld, Printables, or Thingiverse (or any zip of 3D
              print files). It&apos;s extracted and classified server-side into an editable draft --
              nothing is added to the vault until you review and commit it below.
            </p>

            <label
              htmlFor="import-zip-input"
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 py-12 text-center cursor-pointer hover:border-accent transition-colors"
            >
              <Upload size={28} className="text-gray-400" />
              <span className="text-sm text-gray-600 dark:text-gray-300">
                {uploading ? 'Uploading…' : 'Click to choose a .zip file'}
              </span>
              <input
                id="import-zip-input"
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelected(file);
                }}
                className="sr-only"
              />
            </label>

            {uploading && (
              <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <div className="h-full bg-accent transition-all duration-200" style={{ width: `${uploadProgress}%` }} />
              </div>
            )}

            {uploadError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <XCircle size={14} className="flex-shrink-0" /> {uploadError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function header(current: Step) {
    return (
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <FileArchive size={18} className="text-accent" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Import zip</h1>
        <div className="flex-1" />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {current === 'upload' && 'Step 1 of 3 — Upload'}
          {current === 'plan' && 'Step 2 of 3 — Review & edit'}
          {current === 'results' && 'Step 3 of 3 — Done'}
        </span>
      </header>
    );
  }

  if (step === 'results' && result) {
    const outcomes: ZipImportCommitFileResult['outcome'][] = ['created', 'linked-existing', 'merged-duplicate'];
    return (
      <div className="flex flex-col h-full bg-surface overflow-hidden">
        {header('results')}
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <CheckCircle size={16} className="text-green-600 dark:text-green-400 flex-shrink-0" />
              Imported <strong>{result.model.title}</strong> — {result.files.length} file{result.files.length !== 1 ? 's' : ''} committed.
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              {outcomes.map((outcome) => {
                const count = result.files.filter((f) => f.outcome === outcome).length;
                if (count === 0) return null;
                return (
                  <span key={outcome} className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
                    {count} {OUTCOME_LABELS[outcome]}
                  </span>
                );
              })}
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
              {result.files.map((f) => (
                <div key={f.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {outcomeIcon(f.outcome)}
                  <span className="flex-1 truncate text-gray-800 dark:text-gray-200" title={f.path}>{basename(f.path)}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">{OUTCOME_LABELS[f.outcome]}</span>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={startOver}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Import another zip
              </button>
              <button
                onClick={() => navigate(`/models/${result.model.id}`)}
                className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                View model
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Plan (review & edit) step ────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      {header('plan')}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        <div className="max-w-3xl mx-auto space-y-5">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {zipFilename}
            {expiresAt !== null && ` · draft expires ${new Date(expiresAt * 1000).toLocaleString()}`}
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => patchForm({ title: e.target.value })}
              className={inputClass}
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label htmlFor="import-category-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select
                id="import-category-select"
                value={form.categoryId}
                onChange={(e) => patchForm({ categoryId: e.target.value })}
                className={inputClass}
              >
                <option value="">Uncategorized</option>
                {categoryOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags</label>
              <TagInput tags={form.tags} onChange={(tags) => patchForm({ tags })} />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            {plan.descriptionSource && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                Detected {basename(plan.descriptionSource)} in the zip — this wizard can&apos;t read its
                contents before commit, so copy in what you want and edit freely.
              </p>
            )}
            <textarea
              value={form.description}
              onChange={(e) => patchForm({ description: e.target.value })}
              rows={4}
              placeholder={plan.descriptionSource ? `e.g. paste from ${basename(plan.descriptionSource)}` : 'Optional description'}
              className={inputClass}
            />
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">Source & license</h2>
            <div className="flex gap-2">
              <input
                value={form.sourceSite}
                onChange={(e) => patchForm({ sourceSite: e.target.value })}
                placeholder="Source site (e.g. Printables)"
                className={inputClass}
              />
              <input
                value={form.sourceAuthor}
                onChange={(e) => patchForm({ sourceAuthor: e.target.value })}
                placeholder="Original author"
                className={inputClass}
              />
            </div>
            <input
              value={form.sourceUrl}
              onChange={(e) => patchForm({ sourceUrl: e.target.value })}
              placeholder="Source URL"
              className={`${inputClass} ${!sourceUrlValid ? 'border-red-400 dark:border-red-600' : ''}`}
            />
            {!sourceUrlValid && (
              <p className="text-xs text-red-500">Must be a valid http(s) (or mailto:) link.</p>
            )}
            <input
              value={form.license}
              onChange={(e) => patchForm({ license: e.target.value })}
              placeholder="License (e.g. CC-BY-NC)"
              className={inputClass}
            />
            {plan.licenseFile && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Detected license file: {basename(plan.licenseFile)}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">Files</h2>
              <span className="text-xs text-gray-500 dark:text-gray-400">{includedFiles.length} of {visibleFiles.filter((f) => !f.invalid).length} included</span>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
              {visibleFiles.map((f) => {
                if (f.invalid) {
                  return (
                    <div key={f.path} className="flex items-center gap-3 px-3 py-2 text-sm opacity-60">
                      <XCircle size={14} className="text-red-500 flex-shrink-0" />
                      <span className="flex-1 truncate text-gray-600 dark:text-gray-300" title={f.path}>{basename(f.path)}</span>
                      {f.size !== undefined && <span className="text-xs text-gray-400 flex-shrink-0 w-16 text-right">{formatSize(f.size)}</span>}
                      <span className="text-xs text-red-500 flex-shrink-0">Excluded — {f.invalidReason}</span>
                    </div>
                  );
                }

                const role = form.roles.get(f.path) ?? 'other';
                const excluded = role === 'exclude';
                const isProfileCandidate = plan.profileCandidates.includes(f.path);

                return (
                  <div key={f.path} className={`flex items-center gap-3 px-3 py-2 text-sm ${excluded ? 'opacity-50' : ''}`}>
                    <span className="flex-1 truncate text-gray-800 dark:text-gray-200" title={f.path}>{basename(f.path)}</span>
                    {f.size !== undefined && <span className="text-xs text-gray-400 flex-shrink-0 w-16 text-right">{formatSize(f.size)}</span>}
                    <select
                      aria-label={`Role for ${basename(f.path)}`}
                      value={role}
                      onChange={(e) => setRole(f.path, e.target.value as WizardRole)}
                      className="text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 outline-none focus:ring-2 focus:ring-accent/40"
                    >
                      {ROLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {role === 'image' && (
                      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 flex-shrink-0 cursor-pointer">
                        <input
                          type="radio"
                          name="import-cover"
                          checked={form.coverPath === f.path}
                          onChange={() => patchForm({ coverPath: f.path })}
                          className="accent-accent"
                        />
                        Cover
                      </label>
                    )}
                    {isProfileCandidate && !excluded && (
                      <label
                        className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 flex-shrink-0 cursor-pointer"
                        title="Also add as a print profile"
                      >
                        <input
                          type="checkbox"
                          checked={form.profilePaths.has(f.path)}
                          onChange={() => toggleProfile(f.path)}
                          className="accent-accent"
                        />
                        Profile
                      </label>
                    )}
                  </div>
                );
              })}
            </div>

            {junkCount > 0 && (
              <p className="text-xs text-gray-400">
                {junkCount} junk/directory {junkCount === 1 ? 'entry was' : 'entries were'} automatically excluded.
              </p>
            )}
          </div>

          {commitError && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <XCircle size={14} className="flex-shrink-0" /> {commitError}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button
              onClick={handleCancel}
              className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <X size={14} /> Cancel import
            </button>
            <button
              onClick={handleCommit}
              disabled={!canCommit}
              className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {committing && <Loader size={14} className="animate-spin" />}
              {committing ? 'Committing…' : `Commit ${includedFiles.length} file${includedFiles.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
