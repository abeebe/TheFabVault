import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, CheckCircle, XCircle, AlertTriangle, Loader, FolderInput, ExternalLink,
} from 'lucide-react';
import { useFolders } from '../hooks/useFolders.js';
import { useModels } from '../hooks/useModels.js';
import { api } from '../lib/api.js';
import { foldersWithPaths } from '../lib/folderTreePaths.js';
import type { FolderConversionPreviewOut, ModelFileRole } from '../lib/api.js';

// Bulk folder→model convert wizard (#2170, Phase B4). Admin-ish power
// tool: routed at /convert (see AppShell.tsx), entry point placed in
// AdminSettings' "Library Tools" section rather than surfaced on the main
// Browse/Vault nav — same "opt in to find it" placement as Duplicates/
// Orphans detection there, just as a full route instead of a modal
// because a 3-step wizard (select → review N previews → batch results)
// needs real page real estate, not a dialog stacked on a dialog.
//
// No server auth change in this ticket (from-folder is requireAuth, not
// requireAdmin, same as every other route in models.ts) — Phase D is
// where member-vs-admin gating gets formalized project-wide. This page
// is just gated by where its entry point lives today.
//
// Three steps, plain component state (no new hook) — same "logic lives in
// the component" convention as OrphansModal.tsx/DuplicatesModal.tsx, not
// a custom hook, since none of this state is needed anywhere else.
type Step = 'select' | 'review' | 'results';

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: FolderConversionPreviewOut };

interface ResultRow {
  folderId: string;
  folderName: string;
  status: 'converted' | 'skipped-empty' | 'skipped-already-converted' | 'error';
  modelId?: string;
  message?: string;
}

const ROLE_LABELS: Record<ModelFileRole, string> = {
  part: 'Part', image: 'Image', doc: 'Doc', other: 'Other',
};

// Large enough to cover every model in a personal-vault-scale library in
// one request — GET /models enforces no server-side cap on `limit` (it's
// used directly in the SQL LIMIT clause), and this is an admin tool run
// occasionally, not a hot path worth paginating for.
const ALL_MODELS_LIMIT = 100000;

export function ConvertWizardPage() {
  const { folders, loading: foldersLoading } = useFolders();
  const { models, loading: modelsLoading, refresh: refreshModels } = useModels({ limit: ALL_MODELS_LIMIT });

  const [step, setStep] = useState<Step>('select');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [recheckIds, setRecheckIds] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Map<string, PreviewState>>(new Map());
  const [titleOverrides, setTitleOverrides] = useState<Map<string, string>>(new Map());
  const [converting, setConverting] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);

  // folderId -> models already converted from it. Client-side, built from
  // the bulk models list rather than a server round-trip per folder — see
  // routes/models.ts's ModelOut.sourceFolderId (already exposed in every
  // list row, confirmed rather than adding a second endpoint for this).
  const convertedByFolder = useMemo(() => {
    const map = new Map<string, Array<{ id: string; title: string }>>();
    for (const m of models) {
      if (!m.sourceFolderId) continue;
      const list = map.get(m.sourceFolderId) ?? [];
      list.push({ id: m.id, title: m.title });
      map.set(m.sourceFolderId, list);
    }
    return map;
  }, [models]);

  const rows = useMemo(() => foldersWithPaths(folders), [folders]);

  function toggleSelected(folderId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(rows.map((r) => r.folder.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Sequential, not Promise.all — this is an occasional admin tool, not a
  // hot path, and sequential per-folder requests keep failures isolated
  // and attributable (one slow/broken folder doesn't take the others
  // down with it in a Promise.all rejection).
  async function goToReview() {
    setStep('review');
    for (const folderId of selectedIds) {
      if (previews.has(folderId)) continue;
      setPreviews((prev) => new Map(prev).set(folderId, { status: 'loading' }));
      try {
        const preview = await api.models.previewFromFolder(folderId);
        setPreviews((prev) => new Map(prev).set(folderId, { status: 'ready', preview }));
      } catch (err) {
        setPreviews((prev) => new Map(prev).set(
          folderId,
          { status: 'error', message: err instanceof Error ? err.message : String(err) },
        ));
      }
    }
  }

  function isEligible(folderId: string): boolean {
    const p = previews.get(folderId);
    if (!p || p.status !== 'ready') return false;
    if (p.preview.assetCount === 0) return false;
    if (p.preview.alreadyConverted && !recheckIds.has(folderId)) return false;
    return true;
  }

  const eligibleIds = [...selectedIds].filter(isEligible);

  async function handleConvert() {
    setConverting(true);
    setResults([]);
    for (const folderId of eligibleIds) {
      const p = previews.get(folderId);
      const folderName = p && p.status === 'ready' ? p.preview.folderName
        : rows.find((r) => r.folder.id === folderId)?.folder.name ?? folderId;
      const title = titleOverrides.get(folderId)?.trim() || undefined;
      try {
        const created = await api.models.fromFolder(folderId, title);
        setResults((prev) => [...prev, { folderId, folderName, status: 'converted', modelId: created.id }]);
      } catch (err) {
        setResults((prev) => [...prev, {
          folderId, folderName, status: 'error', message: err instanceof Error ? err.message : String(err),
        }]);
      }
    }
    // Folders that were selected but excluded from the batch (empty, or
    // already-converted without an explicit re-check) still get a result
    // row — "one confirm per batch, then per-folder results" means every
    // selected folder should show up in the outcome, not silently vanish.
    for (const folderId of selectedIds) {
      if (eligibleIds.includes(folderId)) continue;
      const p = previews.get(folderId);
      const folderName = p && p.status === 'ready' ? p.preview.folderName
        : rows.find((r) => r.folder.id === folderId)?.folder.name ?? folderId;
      if (p && p.status === 'ready' && p.preview.assetCount === 0) {
        setResults((prev) => [...prev, { folderId, folderName, status: 'skipped-empty' }]);
      } else if (p && p.status === 'ready' && p.preview.alreadyConverted) {
        setResults((prev) => [...prev, { folderId, folderName, status: 'skipped-already-converted' }]);
      }
    }
    setConverting(false);
    setStep('results');
    await refreshModels();
  }

  function startOver() {
    setStep('select');
    setSelectedIds(new Set());
    setRecheckIds(new Set());
    setPreviews(new Map());
    setTitleOverrides(new Map());
    setResults([]);
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <FolderInput size={18} className="text-accent" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Bulk Convert Folders to Models</h1>
        <div className="flex-1" />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {step === 'select' && 'Step 1 of 3 — Select'}
          {step === 'review' && 'Step 2 of 3 — Review'}
          {step === 'results' && 'Step 3 of 3 — Results'}
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {step === 'select' && (
          <div className="max-w-3xl mx-auto space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Select folders to convert into models. This never touches the folder or its files —
              conversion only creates new model records that link to the same assets. Folders already
              converted are marked below; check them again to convert a second time.
            </p>

            {(foldersLoading || modelsLoading) && rows.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
                <Loader size={16} className="animate-spin text-accent" /> Loading folders…
              </div>
            )}

            {!foldersLoading && rows.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">No folders in the vault yet.</p>
            )}

            {rows.length > 0 && (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <button onClick={selectAll} className="text-accent hover:underline">Select all</button>
                  <span className="text-gray-300 dark:text-gray-600">·</span>
                  <button onClick={clearSelection} className="text-accent hover:underline">Clear</button>
                  <div className="flex-1" />
                  <span className="text-gray-500 dark:text-gray-400">{selectedIds.size} selected</span>
                </div>

                <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
                  {rows.map(({ folder, path }) => {
                    const converted = convertedByFolder.get(folder.id) ?? [];
                    return (
                      <label
                        key={folder.id}
                        className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(folder.id)}
                          onChange={() => toggleSelected(folder.id)}
                          className="accent-accent"
                        />
                        <span className="flex-1 truncate text-gray-800 dark:text-gray-200" title={path}>{path}</span>
                        {converted.length > 0 && (
                          <span className="flex items-center gap-1 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full flex-shrink-0">
                            <CheckCircle size={11} />
                            Already converted{converted.length > 1 ? ` (${converted.length}×)` : ''}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={goToReview}
                disabled={selectedIds.size === 0}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Review {selectedIds.size > 0 ? selectedIds.size : ''} folder{selectedIds.size !== 1 ? 's' : ''}
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="max-w-3xl mx-auto space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Preview only — nothing is created until you confirm below. Folders with no convertible
              files, or already-converted folders you haven&apos;t re-checked, are excluded from the count.
            </p>

            <div className="space-y-3">
              {[...selectedIds].map((folderId) => {
                const rowMeta = rows.find((r) => r.folder.id === folderId);
                const p = previews.get(folderId);

                if (!p || p.status === 'loading') {
                  return (
                    <div key={folderId} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 flex items-center gap-2 text-sm text-gray-500">
                      <Loader size={14} className="animate-spin text-accent" />
                      {rowMeta?.path ?? folderId}
                    </div>
                  );
                }

                if (p.status === 'error') {
                  return (
                    <div key={folderId} className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
                        <XCircle size={14} /> {rowMeta?.path ?? folderId}
                      </div>
                      <p className="text-xs text-red-600 dark:text-red-400">Preview failed: {p.message}</p>
                    </div>
                  );
                }

                const { preview } = p;
                const empty = preview.assetCount === 0;
                const needsRecheck = preview.alreadyConverted && !recheckIds.has(folderId);
                const cover = preview.files.find((f) => f.assetId === preview.coverAssetId);
                const excluded = empty || needsRecheck;

                return (
                  <div
                    key={folderId}
                    className={`rounded-lg border p-3 space-y-2 ${
                      excluded
                        ? 'border-gray-200 dark:border-gray-700 opacity-60'
                        : 'border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400 truncate" title={rowMeta?.path}>
                        {rowMeta?.path ?? preview.folderName}
                      </span>
                      {empty && (
                        <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">
                          <AlertTriangle size={11} /> No convertible assets — will be skipped
                        </span>
                      )}
                    </div>

                    <input
                      type="text"
                      value={titleOverrides.get(folderId) ?? preview.suggestedTitle}
                      onChange={(e) => setTitleOverrides((prev) => new Map(prev).set(folderId, e.target.value))}
                      disabled={empty}
                      placeholder="Model title"
                      className="w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
                    />

                    {!empty && (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        {(Object.keys(ROLE_LABELS) as ModelFileRole[]).map((role) => (
                          preview.countsByRole[role] > 0 && (
                            <span key={role} className="bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
                              {preview.countsByRole[role]} {ROLE_LABELS[role]}{preview.countsByRole[role] !== 1 ? 's' : ''}
                            </span>
                          )
                        ))}
                        <span>
                          Cover: {cover ? cover.filename : <em>none — no image found</em>}
                        </span>
                      </div>
                    )}

                    {preview.alreadyConverted && (
                      <div className="flex items-center gap-2 flex-wrap text-xs bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-md px-2.5 py-1.5 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} className="flex-shrink-0" />
                        <span>Already converted to {preview.existingModelIds.length} model{preview.existingModelIds.length !== 1 ? 's' : ''}.</span>
                        <label className="flex items-center gap-1 cursor-pointer ml-auto">
                          <input
                            type="checkbox"
                            checked={recheckIds.has(folderId)}
                            onChange={() => setRecheckIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
                              return next;
                            })}
                            className="accent-accent"
                          />
                          Convert again anyway
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between pt-2">
              <button
                onClick={() => setStep('select')}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <button
                onClick={handleConvert}
                disabled={converting || eligibleIds.length === 0}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {converting && <Loader size={14} className="animate-spin" />}
                {converting ? 'Converting…' : `Confirm & convert ${eligibleIds.length} folder${eligibleIds.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}

        {step === 'results' && (
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
              {results.map((r) => (
                <div key={r.folderId} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {r.status === 'converted' && <CheckCircle size={14} className="text-green-600 dark:text-green-400 flex-shrink-0" />}
                  {r.status === 'error' && <XCircle size={14} className="text-red-600 dark:text-red-400 flex-shrink-0" />}
                  {(r.status === 'skipped-empty' || r.status === 'skipped-already-converted') && (
                    <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                  )}
                  <span className="flex-1 truncate text-gray-800 dark:text-gray-200">{r.folderName}</span>
                  {r.status === 'converted' && r.modelId && (
                    <Link to={`/models/${r.modelId}`} className="flex items-center gap-1 text-xs text-accent hover:underline flex-shrink-0">
                      View model <ExternalLink size={11} />
                    </Link>
                  )}
                  {r.status === 'error' && <span className="text-xs text-red-500 flex-shrink-0" title={r.message}>{r.message}</span>}
                  {r.status === 'skipped-empty' && <span className="text-xs text-gray-500 flex-shrink-0">Skipped — no assets</span>}
                  {r.status === 'skipped-already-converted' && <span className="text-xs text-gray-500 flex-shrink-0">Skipped — already converted</span>}
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={startOver}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Convert more folders
              </button>
              <Link
                to="/"
                className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                Done — go to Browse
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
