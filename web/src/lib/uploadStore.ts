// Module-level upload store.
//
// Uploads must survive navigation (e.g. user starts a batch upload then
// switches into a project view). React component state is destroyed on
// unmount, so the worker pool, in-flight requests, and per-file UI state
// all live here at module scope instead.
//
// Components subscribe via the useUploads hook (useSyncExternalStore).

import { sha256 } from 'js-sha256';
import { api } from './api.js';
import type { AssetOut } from '../types/index.js';

export interface UploadItem {
  file: File;
  status: 'pending' | 'hashing' | 'uploading' | 'done' | 'error';
  result?: AssetOut;
  error?: string;
  // Per-file progress in bytes for the hashing and uploading phases.
  // `bytesTotal` is the file size; the two `bytes*` fields drive the
  // green (hash) and blue (upload) bars in the UI.
  bytesTotal: number;
  bytesHashed: number;
  bytesUploaded: number;
}

export interface DuplicateEntry {
  file: File;
  existing: AssetOut;
  keep: boolean;
}

// Phase of the most recent (or in-flight) upload batch. Used to surface
// what the app is doing during large uploads — the hash-check phase can
// take a noticeable amount of time with 100+ files and otherwise looks
// like the UI is stuck.
export type UploadPhase = 'idle' | 'hashing' | 'uploading' | 'done';

interface UploadStoreState {
  items: UploadItem[];
  panelOpen: boolean;
  dupeModal: DuplicateEntry[] | null;
  phase: UploadPhase;
  // Total files in the current batch (used as the denominator in progress
  // displays — `items.length` accumulates across batches).
  batchTotal: number;
  // How many of those have been hashed so far during the dedupe phase.
  hashedCount: number;
}

let state: UploadStoreState = {
  items: [],
  panelOpen: false,
  dupeModal: null,
  phase: 'idle',
  batchTotal: 0,
  hashedCount: 0,
};

const listeners = new Set<() => void>();
let dupeResolver: ((d: DuplicateEntry[]) => void) | null = null;

// App registers a callback so newly uploaded assets can be added to its
// in-memory asset list and project counts refreshed.
let onUploadedCallback: ((assets: AssetOut[]) => void) | null = null;

// Per-project listeners so a project detail view can refresh itself when
// drops land in that project from anywhere in the app.
const projectAddListeners = new Map<string, Set<() => void>>();

export function subscribeProjectAdds(projectId: string, listener: () => void): () => void {
  let set = projectAddListeners.get(projectId);
  if (!set) { set = new Set(); projectAddListeners.set(projectId, set); }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) projectAddListeners.delete(projectId);
  };
}

function notifyProjectAdds(projectId: string): void {
  const set = projectAddListeners.get(projectId);
  if (!set) return;
  for (const l of set) l();
}

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<UploadStoreState> | ((s: UploadStoreState) => Partial<UploadStoreState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  emit();
}

function updateItems(updater: (items: UploadItem[]) => UploadItem[]) {
  setState({ items: updater(state.items) });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSnapshot(): UploadStoreState {
  return state;
}

export function setOnUploaded(cb: ((assets: AssetOut[]) => void) | null): void {
  onUploadedCallback = cb;
}

export function setPanelOpen(open: boolean): void {
  setState({ panelOpen: open });
}

export function togglePanel(): void {
  setState({ panelOpen: !state.panelOpen });
}

export function clearItems(): void {
  setState({ items: [] });
}

export function confirmDupes(decisions: DuplicateEntry[]): void {
  dupeResolver?.(decisions);
}

export function cancelDupes(): void {
  const entries = state.dupeModal?.map((e) => ({ ...e, keep: false })) ?? [];
  dupeResolver?.(entries);
}

// Streaming SHA-256 over file chunks. Avoids loading the whole file into
// memory and lets us report incremental progress via the optional
// `onProgress` callback. Uses js-sha256 because Web Crypto's `digest`
// is one-shot only.
//
// Exported so lib/importStore.ts (folder-tree import, Bet 2) can reuse
// this verbatim for its own Scan-phase hashing pass instead of a second,
// divergent implementation — same reasoning as reusing checkHash() as-is.
export async function sha256Hex(
  file: File,
  onProgress?: (bytesHashed: number) => void,
): Promise<string> {
  const hasher = sha256.create();
  const reader = file.stream().getReader();
  let processed = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
    processed += value.byteLength;
    onProgress?.(processed);
  }
  return hasher.hex();
}

async function addUploadsToProject(projectId: string, assetIds: string[]): Promise<void> {
  try {
    await api.projects.addAssets(projectId, assetIds);
    notifyProjectAdds(projectId);
  } catch (err) {
    console.warn(`[uploadStore] Failed to add ${assetIds.length} asset(s) to project ${projectId}:`, err);
  }
}

const HASH_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 6;
// Above this many files we skip the dedupe modal — triaging hundreds of
// checkboxes is worse than the chance of an unwanted duplicate. Duplicates
// are still detected and marked inline as skipped.
const AUTO_SKIP_DUPES_THRESHOLD = 20;

async function uploadOne(
  file: File,
  folderId: string | null,
): Promise<AssetOut | null> {
  updateItems((items) =>
    items.map((item) =>
      item.file === file ? { ...item, status: 'uploading', bytesUploaded: 0 } : item
    )
  );
  try {
    const asset = await api.assets.upload(file, {
      folderId: folderId ?? undefined,
      onProgress: (loaded) => {
        updateItems((items) =>
          items.map((item) =>
            item.file === file ? { ...item, bytesUploaded: loaded } : item
          )
        );
      },
    });
    updateItems((items) =>
      items.map((item) =>
        item.file === file
          ? { ...item, status: 'done', result: asset, bytesUploaded: item.bytesTotal }
          : item
      )
    );
    return asset;
  } catch (err) {
    updateItems((items) =>
      items.map((item) =>
        item.file === file ? { ...item, status: 'error', error: String(err) } : item
      )
    );
    return null;
  }
}

// Pipelined runner: hash workers and upload workers run concurrently.
// As each file's hash check completes, the file is either marked as
// auto-skipped (duplicate) or pushed to the upload queue so an upload
// worker can grab it immediately. Hash concurrency is bounded so peak
// memory stays at ~HASH_CONCURRENCY × largest file size.
async function runPipelined(
  files: File[],
  folderId: string | null,
  projectId: string | null,
): Promise<void> {
  const uploadQueue: File[] = [];
  const waiters: Array<(file: File | null) => void> = [];
  let hashingDone = false;

  function enqueue(file: File) {
    const waiter = waiters.shift();
    if (waiter) waiter(file);
    else uploadQueue.push(file);
  }

  function nextFile(): Promise<File | null> {
    return new Promise((resolve) => {
      if (uploadQueue.length > 0) { resolve(uploadQueue.shift()!); return; }
      if (hashingDone) { resolve(null); return; }
      waiters.push(resolve);
    });
  }

  function drainWaiters() {
    while (waiters.length > 0) waiters.shift()!(null);
  }

  let hashCursor = 0;
  const hashWorker = async () => {
    while (true) {
      const idx = hashCursor++;
      if (idx >= files.length) return;
      const file = files[idx];
      updateItems((items) =>
        items.map((item) =>
          item.file === file ? { ...item, status: 'hashing' } : item
        )
      );
      try {
        const hash = await sha256Hex(file, (bytes) => {
          updateItems((items) =>
            items.map((item) =>
              item.file === file ? { ...item, bytesHashed: bytes } : item
            )
          );
        });
        const check = await api.assets.checkHash(hash);
        setState((s) => ({ hashedCount: s.hashedCount + 1 }));
        if (check.exists) {
          updateItems((items) =>
            items.map((item) =>
              item.file === file
                ? { ...item, status: 'error', error: 'Skipped — already in vault' }
                : item
            )
          );
        } else {
          // Reset to pending so the UI shows it's waiting for an upload slot.
          updateItems((items) =>
            items.map((item) =>
              item.file === file
                ? { ...item, status: 'pending', bytesHashed: item.bytesTotal }
                : item
            )
          );
          enqueue(file);
        }
      } catch {
        // Hash failure shouldn't block upload — push it through anyway.
        setState((s) => ({ hashedCount: s.hashedCount + 1 }));
        enqueue(file);
      }
    }
  };

  const uploaded: AssetOut[] = [];
  const uploadWorker = async () => {
    while (true) {
      const file = await nextFile();
      if (!file) return;
      const asset = await uploadOne(file, folderId);
      if (asset) uploaded.push(asset);
    }
  };

  const hashPool = Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, () => hashWorker())
  ).then(() => {
    hashingDone = true;
    drainWaiters();
  });

  const uploadPool = Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => uploadWorker())
  );

  await Promise.all([hashPool, uploadPool]);

  if (uploaded.length > 0) {
    if (projectId) await addUploadsToProject(projectId, uploaded.map((a) => a.id));
    onUploadedCallback?.(uploaded);
  }
}

// Simple upload pool — used after the modal path has already filtered out
// duplicates the user chose to skip.
async function runWorkerPool(
  files: File[],
  folderId: string | null,
  projectId: string | null,
): Promise<void> {
  let cursor = 0;
  const uploaded: AssetOut[] = [];

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= files.length) return;
      const asset = await uploadOne(files[idx], folderId);
      if (asset) uploaded.push(asset);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker())
  );

  if (uploaded.length > 0) {
    if (projectId) await addUploadsToProject(projectId, uploaded.map((a) => a.id));
    onUploadedCallback?.(uploaded);
  }
}

// Bounded-concurrency parallel map. Caps how many files are held in
// memory as ArrayBuffers during hashing (Web Crypto SHA-256 is not
// incremental, so each hash must load the full file).
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return out;
}

export async function startUploads(
  files: File[],
  opts: { folderId: string | null; projectId?: string | null },
): Promise<void> {
  if (!files.length) return;

  const newItems: UploadItem[] = files.map((f) => ({
    file: f,
    status: 'pending' as const,
    bytesTotal: f.size,
    bytesHashed: 0,
    bytesUploaded: 0,
  }));
  updateItems((items) => [...newItems, ...items]);
  setState({
    panelOpen: true,
    phase: 'hashing',
    batchTotal: files.length,
    hashedCount: 0,
  });

  // Above the threshold the dedupe modal is unusable. Pipeline hashes
  // and uploads, auto-skipping duplicates inline.
  if (files.length > AUTO_SKIP_DUPES_THRESHOLD) {
    setState({ phase: 'uploading' });
    await runPipelined(files, opts.folderId, opts.projectId ?? null);
    setState({ phase: 'done' });
    return;
  }

  // Small-batch path: hash everything first, prompt the user about
  // duplicates, then upload. Hash concurrency is bounded so even small
  // batches of huge files don't blow up RAM.
  let filesToUpload = files;
  try {
    const hashResults = await mapWithConcurrency(files, HASH_CONCURRENCY, async (file) => {
      updateItems((items) =>
        items.map((item) =>
          item.file === file ? { ...item, status: 'hashing' } : item
        )
      );
      try {
        const hash = await sha256Hex(file, (bytes) => {
          updateItems((items) =>
            items.map((item) =>
              item.file === file ? { ...item, bytesHashed: bytes } : item
            )
          );
        });
        const check = await api.assets.checkHash(hash);
        setState((s) => ({ hashedCount: s.hashedCount + 1 }));
        updateItems((items) =>
          items.map((item) =>
            item.file === file
              ? { ...item, status: 'pending', bytesHashed: item.bytesTotal }
              : item
          )
        );
        return { file, check };
      } catch {
        setState((s) => ({ hashedCount: s.hashedCount + 1 }));
        return { file, check: { exists: false } };
      }
    });

    const duplicates: DuplicateEntry[] = hashResults
      .filter((r) => r.check.exists && r.check.asset)
      .map((r) => ({ file: r.file, existing: r.check.asset!, keep: false }));

    if (duplicates.length > 0) {
      const decisions = await new Promise<DuplicateEntry[]>((resolve) => {
        dupeResolver = resolve;
        setState({ dupeModal: duplicates });
      });
      setState({ dupeModal: null });
      dupeResolver = null;

      const skipSet = new Set(decisions.filter((d) => !d.keep).map((d) => d.file));

      updateItems((items) =>
        items.map((item) =>
          skipSet.has(item.file)
            ? { ...item, status: 'error', error: 'Skipped — already in vault' }
            : item
        )
      );

      filesToUpload = files.filter((f) => !skipSet.has(f));
    }
  } catch {
    // Hash check failures fall through to a normal upload.
  }

  setState({ phase: 'uploading' });
  await runWorkerPool(filesToUpload, opts.folderId, opts.projectId ?? null);
  setState({ phase: 'done' });
}
