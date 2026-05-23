// Module-level upload store.
//
// Uploads must survive navigation (e.g. user starts a batch upload then
// switches into a project view). React component state is destroyed on
// unmount, so the worker pool, in-flight requests, and per-file UI state
// all live here at module scope instead.
//
// Components subscribe via the useUploads hook (useSyncExternalStore).

import { api } from './api.js';
import type { AssetOut } from '../types/index.js';

export interface UploadItem {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  result?: AssetOut;
  error?: string;
}

export interface DuplicateEntry {
  file: File;
  existing: AssetOut;
  keep: boolean;
}

interface UploadStoreState {
  items: UploadItem[];
  panelOpen: boolean;
  dupeModal: DuplicateEntry[] | null;
}

let state: UploadStoreState = {
  items: [],
  panelOpen: false,
  dupeModal: null,
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

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function addUploadsToProject(projectId: string, assetIds: string[]): Promise<void> {
  try {
    await api.projects.addAssets(projectId, assetIds);
    notifyProjectAdds(projectId);
  } catch (err) {
    console.warn(`[uploadStore] Failed to add ${assetIds.length} asset(s) to project ${projectId}:`, err);
  }
}

async function runWorkerPool(files: File[], folderId: string | null, projectId: string | null): Promise<void> {
  const CONCURRENCY = 6;
  const uploaded: AssetOut[] = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= files.length) return;
      const file = files[idx];

      updateItems((items) =>
        items.map((item) => (item.file === file ? { ...item, status: 'uploading' } : item))
      );

      try {
        const asset = await api.assets.upload(file, { folderId: folderId ?? undefined });
        uploaded.push(asset);
        updateItems((items) =>
          items.map((item) => (item.file === file ? { ...item, status: 'done', result: asset } : item))
        );
      } catch (err) {
        updateItems((items) =>
          items.map((item) =>
            item.file === file ? { ...item, status: 'error', error: String(err) } : item
          )
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker())
  );

  if (uploaded.length > 0) {
    if (projectId) {
      await addUploadsToProject(projectId, uploaded.map((a) => a.id));
    }
    onUploadedCallback?.(uploaded);
  }
}

export async function startUploads(
  files: File[],
  opts: { folderId: string | null; projectId?: string | null },
): Promise<void> {
  if (!files.length) return;

  const newItems: UploadItem[] = files.map((f) => ({ file: f, status: 'pending' as const }));
  updateItems((items) => [...newItems, ...items]);
  setPanelOpen(true);

  let filesToUpload = files;
  try {
    const hashResults = await Promise.all(
      files.map(async (file) => {
        try {
          const hash = await sha256Hex(file);
          const check = await api.assets.checkHash(hash);
          return { file, check };
        } catch {
          return { file, check: { exists: false } };
        }
      })
    );

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

  await runWorkerPool(filesToUpload, opts.folderId, opts.projectId ?? null);
}
