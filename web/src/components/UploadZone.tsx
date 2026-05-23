import { useRef, useCallback } from 'react';
import { Upload, FolderOpen, CheckCircle } from 'lucide-react';
import { Spinner } from './Spinner.js';
import { useUploads } from '../hooks/useUploads.js';
import { startUploads, togglePanel } from '../lib/uploadStore.js';

interface UploadZoneProps {
  currentFolderId: string | null;
}

// Renders the Upload/Folder buttons and the quick-status pill in the top
// bar. The full-screen drop overlay lives in <GlobalDropZone /> and the
// per-file progress UI lives in <UploadPanel /> — both at the App root so
// they work across every view.
export function UploadZone({ currentFolderId }: UploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { items, phase, batchTotal, hashedCount } = useUploads();

  const begin = useCallback((files: File[]) => {
    if (!files.length) return;
    void startUploads(files, { folderId: currentFolderId });
  }, [currentFolderId]);

  const doneCount = items.filter((i) => i.status === 'done').length;
  const errorCount = items.filter((i) => i.status === 'error').length;
  const finishedCount = doneCount + errorCount;
  const pendingCount = items.filter((i) => i.status === 'uploading' || i.status === 'pending').length;

  let pillLabel: string;
  if (phase === 'hashing') {
    pillLabel = `Checking ${hashedCount}/${batchTotal}...`;
  } else if (phase === 'uploading' || pendingCount > 0) {
    pillLabel = `${finishedCount}/${items.length} done`;
  } else {
    pillLabel = `${doneCount} done`;
  }

  return (
    <>
      {/* Upload buttons */}
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) begin(Array.from(e.target.files)); }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-ignore — webkitdirectory is not in TS types
          webkitdirectory=""
          className="hidden"
          onChange={(e) => { if (e.target.files) begin(Array.from(e.target.files)); }}
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
            onClick={togglePanel}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${
              pendingCount > 0
                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
            }`}
          >
            {pendingCount > 0 || phase === 'hashing' ? <Spinner size="sm" /> : <CheckCircle size={14} />}
            {pillLabel}
          </button>
        )}
      </div>
    </>
  );
}
