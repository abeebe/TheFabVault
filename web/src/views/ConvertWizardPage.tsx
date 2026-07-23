import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, CheckCircle, XCircle, AlertTriangle, Loader, FolderInput, ExternalLink, Layers, Boxes,
} from 'lucide-react';
import { useFolders } from '../hooks/useFolders.js';
import { useModels } from '../hooks/useModels.js';
import { api } from '../lib/api.js';
import { buildFolderPath } from '../lib/folderTreePaths.js';
import { ConvertFolderPicker } from '../components/ConvertFolderPicker.js';
import type {
  FolderConversionMode, FolderConversionPreviewOut, FolderConversionResultEntry, ModelFileRole,
} from '../lib/api.js';

// Folder→model convert wizard, reworked for #2175 (fixes Aaron's "/convert
// is useless" complaint against a GUID-heavy folder tree). Routed at
// /convert (see AppShell.tsx), entry point in AdminSettings' "Library
// Tools" section — same placement as pre-#2175.
//
// The #2170 version of this page was a flat 1,678-row checkbox list with
// one mode (each checked folder -> its own model, direct-children-only).
// Root cause of "useless": real parts live several levels down in
// bare-GUID-named leaf folders left behind by bulk/manifest import, so a
// meaningfully-named parent folder's own direct children were nearly
// empty — the flat list gave no way to even SEE that, let alone fix it.
//
// This rework replaces both the picker and the flow:
//   - Picker is a TREE (ConvertFolderPicker), not a flat list — named
//     folders only; bare-GUID leaves are hidden entirely (never a
//     pickable row), per FolderOut.isBareGuid. Traverse INTO named
//     parents; their GUID-leaf children's parts are pulled in
//     automatically by the recursive backend, they just don't clutter
//     the pick list.
//   - Selection is now singular (one anchor folder), not multi-select —
//     the batch unit moved from "many folders, each becomes one model"
//     to "one folder, N results depending on mode":
//       Mode A 'single'     — the folder (recursively) becomes ONE model.
//       Mode B 'each-child' — each of the folder's immediate NAMED
//                              children becomes its own model, in one
//                              atomic batch (api/src/routes/models.ts's
//                              POST /models/from-folder, mode
//                              'each-child').
//   - Preview (step 'review') shows EXACTLY what will be created before
//     commit — the whole trust mechanism this ticket exists to build.
//     Mode B additionally surfaces every exclusion honestly:
//     skippedChildren (bare-GUID immediate children) and looseAssetCount
//     (direct assets in the container, never converted by this mode) —
//     see the review step's "Won't be converted" panel below. A named
//     child with zero convertible assets is a THIRD, distinct exclusion
//     category the API doesn't name for us (buildConversionEntry always
//     returns an entry for it, unlike skippedChildren) — surfaced here
//     as "N subfolders have no files" so it's never silently dropped
//     between what preview shows and what commit actually creates.
//
// Three steps, plain component state (no new hook) — same "logic lives
// in the component" convention as OrphansModal.tsx/DuplicatesModal.tsx.
type Step = 'select' | 'review' | 'results';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: FolderConversionPreviewOut };

interface ResultRow {
  folderId: string;
  folderName: string;
  status: 'converted' | 'skipped-empty' | 'skipped-bare-guid' | 'error';
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

// Shared preview-card body (title override, role counts, cover, already-
// converted state) — used by BOTH Mode A's single card and Mode B's
// per-child rows below, since api/src/routes/models.ts's
// buildConversionEntry() guarantees they're the exact same
// FolderConversionResultEntry shape either way. One render function
// keeps the two modes' cards from ever quietly drifting apart on what
// counts/cover/already-converted information they show.
function EntryCard({
  entry, titleOverride, onTitleChange, recheck, onToggleRecheck,
}: {
  entry: FolderConversionResultEntry;
  titleOverride: string | undefined;
  onTitleChange: (value: string) => void;
  recheck: boolean;
  onToggleRecheck: () => void;
}) {
  const empty = entry.assetCount === 0;
  const cover = entry.files.find((f) => f.assetId === entry.coverAssetId);
  const needsRecheck = entry.alreadyConverted && !recheck;

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 border-gray-200 dark:border-gray-700 ${
        empty || needsRecheck ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{entry.sourceFolderName}</span>
        {empty && (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">
            <AlertTriangle size={11} /> No convertible files — will be skipped
          </span>
        )}
      </div>

      <input
        type="text"
        value={titleOverride ?? entry.suggestedTitle}
        onChange={(e) => onTitleChange(e.target.value)}
        disabled={empty}
        placeholder="Model title"
        className="w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
      />

      {!empty && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {(Object.keys(ROLE_LABELS) as ModelFileRole[]).map((role) => (
            entry.countsByRole[role] > 0 && (
              <span key={role} className="bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
                {entry.countsByRole[role]} {ROLE_LABELS[role]}{entry.countsByRole[role] !== 1 ? 's' : ''}
              </span>
            )
          ))}
          <span>Cover: {cover ? cover.filename : <em>none — no image found</em>}</span>
        </div>
      )}

      {entry.alreadyConverted && (
        <div className="flex items-center gap-2 flex-wrap text-xs bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-md px-2.5 py-1.5 text-amber-700 dark:text-amber-300">
          <AlertTriangle size={12} className="flex-shrink-0" />
          <span>Already converted to {entry.existingModelIds.length} model{entry.existingModelIds.length !== 1 ? 's' : ''}.</span>
          <label className="flex items-center gap-1 cursor-pointer ml-auto">
            <input type="checkbox" checked={recheck} onChange={onToggleRecheck} className="accent-accent" />
            Convert again anyway
          </label>
        </div>
      )}
    </div>
  );
}

export function ConvertWizardPage() {
  const { folders, loading: foldersLoading } = useFolders();
  const { models, loading: modelsLoading, refresh: refreshModels } = useModels({ limit: ALL_MODELS_LIMIT });

  const [step, setStep] = useState<Step>('select');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [mode, setMode] = useState<FolderConversionMode>('single');
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'idle' });
  // Keyed by sourceFolderId — works unchanged for both modes: mode
  // 'single' has exactly one key in play (the selected folder itself),
  // mode 'each-child' has one per named child.
  const [recheckIds, setRecheckIds] = useState<Set<string>>(new Set());
  const [titleOverrides, setTitleOverrides] = useState<Map<string, string>>(new Map());
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);

  // folderId -> models already converted from it. Client-side, built from
  // the bulk models list rather than a server round-trip per folder —
  // see routes/models.ts's ModelOut.sourceFolderId (already exposed in
  // every list row).
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

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null;
  const selectedPath = selectedFolderId ? buildFolderPath(folders, selectedFolderId) : '';
  const hasNamedChildren = selectedFolderId !== null
    && folders.some((f) => f.parentId === selectedFolderId && !f.isBareGuid);

  function toggleRecheck(folderId: string) {
    setRecheckIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  }

  function setTitleOverride(folderId: string, value: string) {
    setTitleOverrides((prev) => new Map(prev).set(folderId, value));
  }

  async function goToReview() {
    if (!selectedFolderId) return;
    setStep('review');
    setPreviewState({ status: 'loading' });
    setRecheckIds(new Set());
    setTitleOverrides(new Map());
    setCommitError(null);
    try {
      const preview = await api.models.previewFromFolder(selectedFolderId, mode);
      setPreviewState({ status: 'ready', preview });
    } catch (err) {
      setPreviewState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Mode A eligibility: the one result entry, same rule as the pre-#2175
  // single-folder gate (non-empty, and already-converted requires an
  // explicit re-check).
  const singleEntry = (previewState.status === 'ready' && mode === 'single')
    ? (previewState.preview.results[0] ?? null)
    : null;
  const singleEligible = singleEntry !== null
    && singleEntry.assetCount > 0
    && (!singleEntry.alreadyConverted || recheckIds.has(singleEntry.sourceFolderId));

  // Mode B eligibility: results[] is every named immediate child (server
  // already excluded bare-GUID ones). Split into the three exclusion
  // categories the review step surfaces, plus the eligible set the
  // Confirm button actually acts on.
  const namedResults = previewState.status === 'ready' ? previewState.preview.results : [];
  const withAssets = namedResults.filter((r) => r.assetCount > 0);
  const emptyNamedChildren = namedResults.filter((r) => r.assetCount === 0);
  const pendingRecheck = withAssets.filter((r) => r.alreadyConverted && !recheckIds.has(r.sourceFolderId));
  // Atomic batch (Kit's API has no per-child include/exclude param) — if
  // ANY eligible-with-assets child is already-converted, EVERY one of
  // them needs an explicit re-check before Confirm unlocks. There's no
  // way to send "convert these 3, skip that already-converted one" in a
  // single fromFolderEachChild call, so the only non-surprising choice
  // is all-or-nothing: block the whole batch rather than silently
  // re-converting an already-converted child the user never opted into.
  const eachChildEligible = withAssets.length > 0 && pendingRecheck.length === 0;

  const confirmEnabled = mode === 'single' ? singleEligible : eachChildEligible;
  const confirmCount = mode === 'single' ? (singleEligible ? 1 : 0) : withAssets.length;

  async function handleConfirm() {
    if (previewState.status !== 'ready' || !confirmEnabled) return;
    setCommitting(true);
    setCommitError(null);
    try {
      if (mode === 'single') {
        const entry = previewState.preview.results[0];
        const title = titleOverrides.get(entry.sourceFolderId)?.trim() || undefined;
        const created = await api.models.fromFolder(entry.sourceFolderId, title, 'single');
        setResults([{
          folderId: entry.sourceFolderId, folderName: entry.sourceFolderName, status: 'converted', modelId: created.id,
        }]);
      } else {
        const childTitles: Record<string, string> = {};
        for (const r of withAssets) {
          const t = titleOverrides.get(r.sourceFolderId)?.trim();
          if (t) childTitles[r.sourceFolderId] = t;
        }
        const batch = await api.models.fromFolderEachChild(
          selectedFolderId!,
          Object.keys(childTitles).length > 0 ? childTitles : undefined,
        );
        const createdByFolder = new Map(batch.created.map((m) => [m.sourceFolderId as string, m]));

        const rows: ResultRow[] = [];
        // Every eligible-with-assets child gets a row — 'converted' when
        // the batch response actually created it, 'error' in the
        // (should-never-happen) case the response is missing an entry
        // the preview promised, rather than silently dropping that
        // folder from Results (same "no silent surprise" invariant Kit's
        // #2170 review caught a regression on before).
        for (const r of withAssets) {
          const created = createdByFolder.get(r.sourceFolderId);
          rows.push(created
            ? { folderId: r.sourceFolderId, folderName: r.sourceFolderName, status: 'converted', modelId: created.id }
            : { folderId: r.sourceFolderId, folderName: r.sourceFolderName, status: 'error', message: 'Not present in the batch response.' });
        }
        // Named children with zero convertible files — never sent to the
        // server, never created, still shown so the count in Results
        // matches the count promised in the preview.
        for (const r of emptyNamedChildren) {
          rows.push({ folderId: r.sourceFolderId, folderName: r.sourceFolderName, status: 'skipped-empty' });
        }
        // Bare-GUID immediate children the server itself skipped.
        for (const c of batch.skippedChildren) {
          rows.push({ folderId: c.folderId, folderName: c.folderName, status: 'skipped-bare-guid' });
        }
        setResults(rows);
      }
      setStep('results');
      await refreshModels();
    } catch (err) {
      // Atomic commit — a failure here created NOTHING (mode 'single' is
      // one INSERT transaction, mode 'each-child' is one all-or-nothing
      // transaction), so this stays on the review step with a retryable
      // error banner rather than advancing to a Results screen that
      // would misrepresent a failed batch as having partial results.
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  function startOver() {
    setStep('select');
    setSelectedFolderId(null);
    setMode('single');
    setPreviewState({ status: 'idle' });
    setRecheckIds(new Set());
    setTitleOverrides(new Map());
    setCommitError(null);
    setResults([]);
  }

  function backToSelect() {
    setStep('select');
    setCommitError(null);
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <FolderInput size={18} className="text-accent" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Convert Folder to Models</h1>
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
              Pick a folder to convert. This never touches the folder or its files — conversion only
              creates new model records that link to the same assets. GUID-named leaf folders (left
              behind by bulk import) aren&apos;t shown — their parts are pulled in automatically by
              whichever named folder you convert.
            </p>

            {foldersLoading && folders.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
                <Loader size={16} className="animate-spin text-accent" /> Loading folders…
              </div>
            )}

            {!foldersLoading && (
              <ConvertFolderPicker
                folders={folders}
                selectedId={selectedFolderId}
                onSelect={setSelectedFolderId}
                convertedByFolder={convertedByFolder}
              />
            )}

            {selectedFolder && (
              <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 space-y-3">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Selected: <span className="font-medium text-gray-800 dark:text-gray-200">{selectedPath}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    onClick={() => setMode('single')}
                    className={`flex items-start gap-2 text-left p-3 rounded-lg border text-sm transition-colors ${
                      mode === 'single'
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/40'
                    }`}
                  >
                    <Boxes size={16} className="flex-shrink-0 mt-0.5" />
                    <span>
                      <span className="block font-medium">This folder → 1 model</span>
                      <span className="block text-xs opacity-80 mt-0.5">
                        Every file anywhere under &quot;{selectedFolder.name}&quot; becomes one model.
                      </span>
                    </span>
                  </button>

                  <button
                    onClick={() => setMode('each-child')}
                    className={`flex items-start gap-2 text-left p-3 rounded-lg border text-sm transition-colors ${
                      mode === 'each-child'
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/40'
                    }`}
                  >
                    <Layers size={16} className="flex-shrink-0 mt-0.5" />
                    <span>
                      <span className="block font-medium">Each named subfolder → its own model</span>
                      <span className="block text-xs opacity-80 mt-0.5">
                        {hasNamedChildren
                          ? `Every named subfolder of "${selectedFolder.name}" becomes its own model.`
                          : `"${selectedFolder.name}" has no named subfolders — this mode would create nothing.`}
                      </span>
                    </span>
                  </button>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={goToReview}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
                  >
                    Preview <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'review' && (
          <div className="max-w-3xl mx-auto space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Preview only — nothing is created until you confirm below.
            </p>

            {previewState.status === 'loading' && (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
                <Loader size={16} className="animate-spin text-accent" /> Loading preview…
              </div>
            )}

            {previewState.status === 'error' && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
                  <XCircle size={14} /> Preview failed
                </div>
                <p className="text-xs text-red-600 dark:text-red-400">{previewState.message}</p>
              </div>
            )}

            {previewState.status === 'ready' && mode === 'single' && singleEntry && (
              <EntryCard
                entry={singleEntry}
                titleOverride={titleOverrides.get(singleEntry.sourceFolderId)}
                onTitleChange={(v) => setTitleOverride(singleEntry.sourceFolderId, v)}
                recheck={recheckIds.has(singleEntry.sourceFolderId)}
                onToggleRecheck={() => toggleRecheck(singleEntry.sourceFolderId)}
              />
            )}

            {previewState.status === 'ready' && mode === 'each-child' && (
              <div className="space-y-3">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {withAssets.length} model{withAssets.length !== 1 ? 's' : ''} will be created:
                </p>

                {withAssets.map((entry) => (
                  <EntryCard
                    key={entry.sourceFolderId}
                    entry={entry}
                    titleOverride={titleOverrides.get(entry.sourceFolderId)}
                    onTitleChange={(v) => setTitleOverride(entry.sourceFolderId, v)}
                    recheck={recheckIds.has(entry.sourceFolderId)}
                    onToggleRecheck={() => toggleRecheck(entry.sourceFolderId)}
                  />
                ))}

                {(emptyNamedChildren.length > 0
                  || previewState.preview.skippedChildren.length > 0
                  || previewState.preview.looseAssetCount > 0) && (
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-1.5">
                    <p className="text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                      <AlertTriangle size={12} className="text-amber-500" /> Won&apos;t be converted
                    </p>
                    {previewState.preview.skippedChildren.length > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {previewState.preview.skippedChildren.length} GUID-named folder
                        {previewState.preview.skippedChildren.length !== 1 ? 's' : ''} skipped
                        {' '}({previewState.preview.skippedChildren.map((c) => c.folderName).join(', ')})
                      </p>
                    )}
                    {emptyNamedChildren.length > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {emptyNamedChildren.length} named subfolder{emptyNamedChildren.length !== 1 ? 's' : ''} with no
                        convertible files ({emptyNamedChildren.map((r) => r.sourceFolderName).join(', ')})
                      </p>
                    )}
                    {previewState.preview.looseAssetCount > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {previewState.preview.looseAssetCount} loose file
                        {previewState.preview.looseAssetCount !== 1 ? 's' : ''} sitting directly in
                        &quot;{previewState.preview.folderName}&quot; — not converted by this mode.
                      </p>
                    )}
                  </div>
                )}

                {withAssets.length === 0 && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle size={14} /> No named subfolder has convertible files — nothing to convert.
                  </p>
                )}

                {pendingRecheck.length > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {pendingRecheck.length} of the folders above are already converted — check &quot;Convert
                    again anyway&quot; on each one to include it in this batch (this is a single atomic
                    request, so it&apos;s all-or-nothing).
                  </p>
                )}
              </div>
            )}

            {commitError && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
                  <XCircle size={14} /> Conversion failed — nothing was created
                </div>
                <p className="text-xs text-red-600 dark:text-red-400">{commitError}</p>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <button
                onClick={backToSelect}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={committing || previewState.status !== 'ready' || !confirmEnabled}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {committing && <Loader size={14} className="animate-spin" />}
                {committing ? 'Converting…' : `Confirm & convert ${confirmCount} model${confirmCount !== 1 ? 's' : ''}`}
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
                  {(r.status === 'skipped-empty' || r.status === 'skipped-bare-guid') && (
                    <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                  )}
                  <span className="flex-1 truncate text-gray-800 dark:text-gray-200">{r.folderName}</span>
                  {r.status === 'converted' && r.modelId && (
                    <Link to={`/models/${r.modelId}`} className="flex items-center gap-1 text-xs text-accent hover:underline flex-shrink-0">
                      View model <ExternalLink size={11} />
                    </Link>
                  )}
                  {r.status === 'error' && <span className="text-xs text-red-500 flex-shrink-0" title={r.message}>{r.message}</span>}
                  {r.status === 'skipped-empty' && <span className="text-xs text-gray-500 flex-shrink-0">Skipped — no convertible files</span>}
                  {r.status === 'skipped-bare-guid' && <span className="text-xs text-gray-500 flex-shrink-0">Skipped — GUID-named folder</span>}
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={startOver}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Convert another folder
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
