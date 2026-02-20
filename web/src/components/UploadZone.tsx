import { useState, useRef, useCallback } from 'react';
import { Upload, FolderOpen, X, CheckCircle, AlertCircle } from 'lucide-react';
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

export function UploadZone({ currentFolderId, onUploaded }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;

    const newItems: UploadItem[] = files.map((f) => ({ file: f, status: 'pending' }));
    setItems((prev) => [...newItems, ...prev]);
    setPanelOpen(true);

    const uploaded: AssetOut[] = [];

    for (let i = 0; i < files.length; i++) {
      setItems((prev) => prev.map((item, idx) =>
        item.file === files[i] && idx < newItems.length
          ? { ...item, status: 'uploading' }
          : item
      ));

      try {
        const asset = await api.assets.upload(files[i], { folderId: currentFolderId ?? undefined });
        uploaded.push(asset);
        setItems((prev) => prev.map((item) =>
          item.file === files[i] ? { ...item, status: 'done', result: asset } : item
        ));
      } catch (err) {
        setItems((prev) => prev.map((item) =>
          item.file === files[i] ? { ...item, status: 'error', error: String(err) } : item
        ));
      }
    }

    if (uploaded.length > 0) onUploaded(uploaded);
  }, [currentFolderId, onUploaded]);

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

      {/* Upload buttons (rendered by parent into toolbar) */}
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
                {item.status === 'error' && <AlertCircle size={16} className="text-red-500 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{item.file.name}</p>
                  {item.error && <p className="text-xs text-red-500 truncate">{item.error}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
