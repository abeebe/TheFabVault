// Module-level import-job store — folder-tree import, Bet 2 of the build
// manifest. Parallel to lib/uploadStore.ts (same architecture: module
// scope + useSyncExternalStore + a bounded-concurrency worker pool), NOT a
// modification of it. See Reid's UX spec, section 8, for why this is a
// separate store: UploadItem's shape (status/result/error/bytes*) is built
// for "a flat list of files, each independently uploading." A folder
// import needs to track per-file link-vs-upload outcomes, a running
// sub-assemblies-created count, and a current-node breadcrumb — none of
// which fit UploadItem without overloading it with fields meaningless for
// a regular upload.
//
// Scan and Preview (the modal's first two phases) are local component
// state and never touch this store — nothing is written to the server
// until "Start import" is clicked. That's the exact boundary
// uploadStore.ts already draws between "user clicked something" and
// "long-running background work," and it's why this store's state only
// has to model the Commit phase onward.

import { api } from './api.js';
import type { AssetOut } from '../types/index.js';

// ─── Resolution plan — built by the modal's Preview phase, consumed here ──────

// Every included file in the import, already classified during Scan:
//   - 'new-upload'  — first time this hash has been seen; upload the bytes.
//   - 'vault-link'  — hash already exists somewhere in the vault (the
//                      client's own scan-phase /check-hash call found it);
//                      no bytes sent, just a placement against assetId.
//   - 'batch-link'  — hash matches another file THIS SAME BATCH already
//                      resolved as 'new-upload' (representativeIndex points
//                      at that entry's index in the same array); waits for
//                      the representative's real upload to learn its
//                      resulting assetId, then links to it.
//
// Invariant enforced by the modal when building this array: for every
// 'batch-link' entry, `representativeIndex` MUST be a lower index than the
// entry's own position. The worker pool below claims tasks via a strictly
// increasing cursor (same pattern as uploadStore.ts's hashWorker/
// uploadWorker), so a lower-indexed representative is always claimed by
// some worker before any of its dependents — this is what makes awaiting
// the representative's promise deadlock-free regardless of concurrency.
export type ImportResolution =
  | { kind: 'new-upload'; file: File; segments: string[] }
  | { kind: 'vault-link'; file: File; segments: string[]; assetId: string }
  | { kind: 'batch-link'; file: File; segments: string[]; representativeIndex: number };

export interface ImportPlan {
  projectId: string;
  // The modal's targetParentId — null for project root, a specific node
  // id when the import was launched from inside a drilled-in node.
  parentSubAssemblyId: string | null;
  folderName: string;
  resolutions: ImportResolution[];
  // Frozen at Preview time from the detected tree's "will merge" tags,
  // filtered to only the branches Aaron left checked. The Result screen
  // reports these as fixed totals; Commit's live count (see
  // newSubAssemblyIdsSeen below) never exceeds newSubAssemblyTotal.
  newSubAssemblyTotal: number;
  mergedSubAssemblyTotal: number;
}

export type ImportItemStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped';

export interface ImportItem {
  file: File;
  segments: string[];
  kind: ImportResolution['kind'];
  status: ImportItemStatus;
  linked: boolean; // final outcome once status is 'done'
  error?: string;
}

export type ImportPhase = 'idle' | 'committing' | 'done';

interface ImportStoreState {
  phase: ImportPhase;
  panelOpen: boolean;
  projectId: string | null;
  folderName: string;
  parentSubAssemblyId: string | null;
  items: ImportItem[];
  currentLocation: string; // e.g. "Dome > Ring", or "" between files
  cancelRequested: boolean;
  newSubAssemblyTotal: number;
  mergedSubAssemblyTotal: number;
  // Every sub-assembly id any commit response has reported as newly
  // created so far — a Set so a node touched by multiple files (only its
  // first-touching file actually creates it, per resolveAndPlace) is
  // counted once. size() is the live "N of M sub-assemblies created"
  // numerator during Commit, and the final "Created N new sub-assemblies"
  // count on the Result screen.
  newSubAssemblyIdsSeen: Set<string>;
}

let state: ImportStoreState = {
  phase: 'idle',
  panelOpen: false,
  projectId: null,
  folderName: '',
  parentSubAssemblyId: null,
  items: [],
  currentLocation: '',
  cancelRequested: false,
  newSubAssemblyTotal: 0,
  mergedSubAssemblyTotal: 0,
  newSubAssemblyIdsSeen: new Set(),
};

const listeners = new Set<() => void>();

// Per-project listeners, mirroring uploadStore.ts's subscribeProjectAdds —
// lets ProjectView refresh its manifest when an import lands, whether or
// not the ImportFolderModal/ImportPanel happens to be mounted at that
// moment (Aaron may have navigated away while a large import runs in the
// background pill).
const projectImportListeners = new Map<string, Set<() => void>>();

export function subscribeProjectImports(projectId: string, listener: () => void): () => void {
  let set = projectImportListeners.get(projectId);
  if (!set) { set = new Set(); projectImportListeners.set(projectId, set); }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) projectImportListeners.delete(projectId);
  };
}

function notifyProjectImport(projectId: string): void {
  const set = projectImportListeners.get(projectId);
  if (!set) return;
  for (const l of set) l();
}

function emit() {
  for (const l of listeners) l();
}

// App.tsx registers a callback (mirroring setOnUploaded) so the Result
// screen's "View manifest" button can navigate there even though
// ImportPanel is mounted at the App root, outside the view-selection
// state it needs to change. Kept as a single callback (not a per-project
// subscription like subscribeProjectImports above) since only one
// "navigate to this project" action can be acted on at a time.
let onViewManifestCallback: ((projectId: string) => void) | null = null;

export function setOnViewManifestRequested(cb: ((projectId: string) => void) | null): void {
  onViewManifestCallback = cb;
}

export function requestViewManifest(projectId: string): void {
  onViewManifestCallback?.(projectId);
}

function setState(patch: Partial<ImportStoreState> | ((s: ImportStoreState) => Partial<ImportStoreState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  emit();
}

function updateItems(updater: (items: ImportItem[]) => ImportItem[]) {
  setState({ items: updater(state.items) });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSnapshot(): ImportStoreState {
  return state;
}

export function setPanelOpen(open: boolean): void {
  setState({ panelOpen: open });
}

export function togglePanel(): void {
  setState({ panelOpen: !state.panelOpen });
}

// Stops claiming further tasks. Already-in-flight requests finish
// naturally rather than being aborted mid-transfer — Reid's UX spec:
// "cancel means stop processing remaining files, not undo what already
// happened," and an aborted mid-write multipart request is a worse
// failure mode than just letting it land.
export function cancelImport(): void {
  setState({ cancelRequested: true });
}

// A fresh import job discards any previous job's finished state (mirrors
// uploadStore's clearItems, but a whole new plan replaces the old one —
// there's no "append to an in-progress import" case since only one import
// modal can be open at a time).
export function resetImport(): void {
  setState({
    phase: 'idle', items: [], currentLocation: '', cancelRequested: false,
    newSubAssemblyTotal: 0, mergedSubAssemblyTotal: 0, newSubAssemblyIdsSeen: new Set(),
  });
}

const COMMIT_CONCURRENCY = 4;

function locationLabel(segments: string[]): string {
  return segments.length > 0 ? segments.join(' > ') : '(root)';
}

// Runs the Commit phase: resolves every item in `plan.resolutions` against
// the server, bounded concurrency, cursor-based claiming (see the
// ImportResolution doc comment above for why cursor order is what makes
// batch-link's dependency-await deadlock-free).
export async function startImport(plan: ImportPlan): Promise<void> {
  const items: ImportItem[] = plan.resolutions.map((r) => ({
    file: r.file,
    segments: r.segments,
    kind: r.kind,
    status: 'pending',
    linked: false,
  }));

  setState({
    phase: 'committing',
    panelOpen: true,
    projectId: plan.projectId,
    folderName: plan.folderName,
    parentSubAssemblyId: plan.parentSubAssemblyId,
    items,
    currentLocation: '',
    cancelRequested: false,
    newSubAssemblyTotal: plan.newSubAssemblyTotal,
    mergedSubAssemblyTotal: plan.mergedSubAssemblyTotal,
    newSubAssemblyIdsSeen: new Set(),
  });

  // One deferred promise per 'new-upload' entry so any 'batch-link'
  // dependents can grab a stable reference to "the assetId this
  // representative will eventually resolve to" before that representative
  // has necessarily even started.
  const representativeAssetId = new Map<number, { promise: Promise<string>; resolve: (id: string) => void; reject: (err: unknown) => void }>();
  plan.resolutions.forEach((r, idx) => {
    if (r.kind === 'new-upload') {
      let resolve!: (id: string) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
      representativeAssetId.set(idx, { promise, resolve, reject });
    }
  });

  function setItemStatus(idx: number, patch: Partial<ImportItem>) {
    updateItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function recordCreated(ids: string[]) {
    if (ids.length === 0) return;
    setState((s) => {
      const next = new Set(s.newSubAssemblyIdsSeen);
      for (const id of ids) next.add(id);
      return { newSubAssemblyIdsSeen: next };
    });
  }

  async function processOne(idx: number): Promise<void> {
    const r = plan.resolutions[idx];
    setItemStatus(idx, { status: 'active' });
    setState({ currentLocation: locationLabel(r.segments) });

    try {
      let result: { asset: AssetOut; linked: boolean; createdSubAssemblyIds: string[] };

      if (r.kind === 'vault-link') {
        result = await api.manifest.importLinkExisting(plan.projectId, {
          assetId: r.assetId, pathSegments: r.segments, parentSubAssemblyId: plan.parentSubAssemblyId,
        });
      } else if (r.kind === 'new-upload') {
        result = await api.manifest.importUploadFile(plan.projectId, r.file, {
          pathSegments: r.segments, parentSubAssemblyId: plan.parentSubAssemblyId,
        });
        representativeAssetId.get(idx)?.resolve(result.asset.id);
      } else {
        // batch-link — wait for the representative's real upload to learn
        // its assetId. If the representative failed, this throws too
        // (the representative's catch block below calls .reject()), which
        // correctly surfaces this file as failed rather than hanging.
        const repAssetId = await representativeAssetId.get(r.representativeIndex)!.promise;
        result = await api.manifest.importLinkExisting(plan.projectId, {
          assetId: repAssetId, pathSegments: r.segments, parentSubAssemblyId: plan.parentSubAssemblyId,
        });
      }

      recordCreated(result.createdSubAssemblyIds);
      setItemStatus(idx, { status: 'done', linked: result.linked });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setItemStatus(idx, { status: 'error', error: message });
      // A failed representative must reject its dependents' waiting
      // promise too, or any batch-link sibling hangs forever.
      representativeAssetId.get(idx)?.reject(err);
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (true) {
      if (state.cancelRequested) return;
      const idx = cursor++;
      if (idx >= plan.resolutions.length) return;
      await processOne(idx);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(COMMIT_CONCURRENCY, plan.resolutions.length) }, () => worker())
  );

  // Cancel stops the pool from claiming further work (see cancelImport's
  // comment), but that leaves every item the pool never got to still
  // 'pending' — an unresolvable state the UI has no way to represent as
  // "finished." Reid's spec calls this "skipped," not "failed": these
  // files were never attempted, so they must not read as errors. This is
  // also why the finished-count math in ImportPanel counts 'skipped'
  // alongside 'done'/'error' — otherwise the progress bar would never
  // reach 100% on a cancelled run.
  if (state.cancelRequested) {
    updateItems((cur) => cur.map((it) => (it.status === 'pending' ? { ...it, status: 'skipped' } : it)));
  }

  setState({ phase: 'done', currentLocation: '' });
  notifyProjectImport(plan.projectId);
}
