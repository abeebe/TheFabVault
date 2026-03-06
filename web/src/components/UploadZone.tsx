import { useState, useRef, useCallback } from 'react';
import { Upload, FolderOpen, X, CheckCircle, AlertCircle, Copy } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './Spinner.js';
import type { AssetOut } from '../types/index.js';

interface UploadZoneProps {
  currentFolderId: string | null;
  onUploaded: (assets: AssetOut[]) => void;
}

interface UploadItem {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  result?: AssetOut;
  error?: string;
}

// ─── Duplicate info collected before uploading ────────────────────────────────

interface DuplicateEntry {
  file: File;
  existing: AssetOut;
  keep: boolean; // user decision: import anyway?
}

// ─── SHA-256 via Web Crypto API ───────────────────────────────────────────────

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Duplicate confirmation modal ────────────────────────────────────────────

interface DupeModalProps {
  duplicates: DuplicateEntry[];
  onConfirm: (decisions: DuplicateEntry[]) => void;
  onCancel: () => void;
}

function DupeModal({ duplicates, onConfirm, onCancel }: DupeModalProps) {
  const [entries, setEntries] = useState<DuplicateEntry[]>(duplicates);

  function toggle(idx: number) {
    setEntries((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, keep: !e.keep } : e))
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <Copy size={18} className="text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              {duplicates.length === 1 ? 'Duplicate file detected' : `${duplicates.length} duplicate files detected`}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              These files already exist in your vault. Choose which ones to import anyway.
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        {/* List */}
        <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
          {entries.map((entry, i) => (
            <label key={i} className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <input
                type="checkbox"
                checked={entry.keep}
                onChange={() => toggle(i)}
                className="w-4 h-4 accent-accent flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{entry.file.name}</p>
                <p className="text-xs text-gray-400 truncate">
                  Already in vault as: <span className="text-gray-500 dark:text-gray-300">{entry.existing.originalName || entry.existing.filename}</span>
                </p>
              </div>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel all
          </button>
          <button
            onClick={() => onConfirm(entries)}
            className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            {entries.filter((e) => e.keep).length > 0
              ? `Import ${entries.filter((e) => e.keep).length} selected`
              : 'Skip all'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function UploadZone({ currentFolderId, onUploaded }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dupeModal, setDupeModal] = useState<DuplicateEntry[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  // Stores the promise resolver for the duplicate modal so we can await it
  const dupeResolveRef = useRef<((d: DuplicateEntry[]) => void) | null>(null);

  // Core upload loop — runs after duplicate check is resolved
  const runUploads = useCallback(async (files: File[]) => {
    if (!files.length) return;

    const uploaded: AssetOut[] = [];

    for (const file of files) {
      setItems((prev) =>
        prev.map((item) =>
          item.file === file ? { ...item, status: 'uploading' } : item
        )
      );

      try {
        const asset = await api.assets.upload(file, { folderId: currentFolderId ?? undefined });
        uploaded.push(asset);
        setItems((prev) =>
          prev.map((item) =>
            item.file === file ? { ...item, status: 'done', result: asset } : item
          )
        );
      } catch (err) {
        setItems((prev) =>
          prev.map((item) =>
            item.file === file ? { ...item, status: 'error', error: String(err) } : item
          )
        );
      }
    }

    if (uploaded.length > 0) onUploaded(uploaded);
  }, [currentFolderId, onUploaded]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;

    // Add all files to the panel immediately as 'pending'
    const newItems: UploadItem[] = files.map((f) => ({ file: f, status: 'pending' as const }));
    setItems((prev) => [...newItems, ...prev]);
    setPanelOpen(true);

    // Check hashes in parallel to find duplicates
    let filesToUpload = files;
    try {
      const hashResults = await Promise.all(
        files.map(async (file) => {
          try {
            const hash = await sha256Hex(file);
            const check = await api.assets.checkHash(hash);
            return { file, check };
          } catch {
            // On any error, allow the upload through
            return { file, check: { exists: false } };
          }
        })
      );

      const duplicates: DuplicateEntry[] = hashResults
        .filter((r) => r.check.exists && r.check.asset)
        .map((r) => ({ file: r.file, existing: r.check.asset!, keep: false }));

      if (duplicates.length > 0) {
        // Pause and wait for the user to confirm/skip via the modal
        const decisions = await new Promise<DuplicateEntry[]>((resolve) => {
          dupeResolveRef.current = resolve;
          setDupeModal(duplicates);
        });
        setDupeModal(null);
        dupeResolveRef.current = null;

        const skipSet = new Set(decisions.filter((d) => !d.keep).map((d) => d.file));

        // Mark skipped files in the panel
        setItems((prev) =>
          prev.map((item) =>
            skipSet.has(item.file)
              ? { ...item, status: 'error', error: 'Skipped — already in vault' }
              : item
          )
        );

        filesToUpload = files.filter((f) => !skipSet.has(f));
      }
    } catch {
      // If anything in the hash check blows up, just upload everything
    }

    await runUploads(filesToUpload);
  }, [runUploads]);

  function handleDupeConfirm(decisions: DuplicateEntry[]) {
    dupeResolveRef.current?.(decisions);
  }

  function handleDupeCancel() {
    // Cancel = skip all duplicates
    const entries = dupeModal?.map((e) => ({ ...e, keep: false })) ?? [];
    dupeResolveRef.current?.(entries);
  }

  // Global drag-over detection
  const handleWindowDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragging(true);
  }, []);

  const handleWindowDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  }, [uploadFiles]);

  const pendingCount = items.filter((i) => i.status === 'uploading' || i.status === 'pending').length;

  return (
    <>
      {/* Full-screen drop overlay */}
      <div
        className={`fixed inset-0 z-40 pointer-events-none transition-opacity duration-150 ${dragging ? 'opacity-100' : 'opacity-0'}`}
        onDragEnter={handleWindowDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={handleWindowDragLeave}
        onDrop={handleDrop}
        style={{ pointerEvents: dragging ? 'all' : 'none' }}
      >
        <div className="absolute inset-0 bg-accent/20 backdrop-blur-sm border-4 border-dashed border-accent rounded-2xl m-4 flex items-center justify-center">
          <div className="text-center">
            <Upload size={48} className="text-accent mx-auto mb-3" />
            <p className="text-xl font-semibold text-accent">Drop files to upload</p>
            {currentFolderId && (
              <p className="text-sm text-accent/70 mt-1">Files will be added to the current folder</p>
            )}
          </div>
        </div>
      </div>

      {/* Duplicate confirmation modal */}
      {dupeModal && (
        <DupeModal
          duplicates={dupeModal}
          onConfirm={handleDupeConfirm}
          onCancel={handleDupeCancel}
        />
      )}

      {/* Upload buttons */}
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) uploadFiles(Array.from(e.target.files)); }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-ignore — webkitdirectory is not in TS types
          webkitdirectory=""
          className="hidden"
          onChange={(e) => { if (e.target.files) uploadFiles(Array.from(e.target.files)); }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
        >
          <Upload size={15} />
          Upload
        </button>
        <button
          onClick={() => folderInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <FolderOpen size={15} />
          Folder
        </button>

        {/* Upload progress pill */}
        {items.length > 0 && (
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${
              pendingCount > 0
                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
            }`}
          >
            {pendingCount > 0 ? <Spinner size="sm" /> : <CheckCircle size={14} />}
            {pendingCount > 0 ? `${pendingCount} uploading...` : `${items.filter((i) => i.status === 'done').length} done`}
          </button>
        )}
      </div>

      {/* Upload panel */}
      {panelOpen && items.length > 0 && (
        <div className="fixed bottom-4 right-4 z-30 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Uploads</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setItems([])}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                Clear
              </button>
              <button
                onClick={() => setPanelOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                {item.status === 'uploading' && <Spinner size="sm" />}
                {item.status === 'pending' && <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" />}
                {item.status === 'done' && <CheckCircle size={16} className="text-green-500 flex-shrink-0" />}
                {item.status === 'error' && <AlertCircle size={16} className="text-amber-500 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{item.file.name}</p>
                  {item.error && <p className="text-xs text-amber-600 dark:text-amber-400 truncate">{item.error}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
