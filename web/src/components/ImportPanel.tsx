import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle, AlertCircle, ChevronRight, FolderInput } from 'lucide-react';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { useImportJob } from '../hooks/useImportJob.js';
import { cancelImport, resetImport, requestViewManifest } from '../lib/importStore.js';

// Commit + Result UI for the folder-tree import, plus its minimized corner
// pill. Mounted once at the App root (mirroring <UploadPanel />, Reid's UX
// spec section 8) so an in-progress import survives navigation away from
// the project it targets, and reopening after a full unmount (a page
// revisit, or the pill being clicked after ImportFolderModal itself
// already unmounted) rebuilds purely from importStore state — nothing
// here depends on the Scan/Preview modal instance still being alive.
export function ImportPanel() {
  const job = useImportJob();
  const [expanded, setExpanded] = useState(true);
  const [showFileDetails, setShowFileDetails] = useState(false);
  const prevPhase = useRef(job.phase);

  // Re-expand automatically whenever a fresh job starts (idle -> committing),
  // even if a previous job's pill had been collapsed.
  useEffect(() => {
    if (prevPhase.current === 'idle' && job.phase === 'committing') setExpanded(true);
    prevPhase.current = job.phase;
  }, [job.phase]);

  if (job.phase === 'idle') return null;

  const doneItems = job.items.filter((i) => i.status === 'done');
  const errorItems = job.items.filter((i) => i.status === 'error');
  const newCount = doneItems.filter((i) => !i.linked).length;
  const linkedCount = doneItems.filter((i) => i.linked).length;
  const finishedCount = doneItems.length + errorItems.length;
  const createdSoFar = Math.min(job.newSubAssemblyIdsSeen.size, job.newSubAssemblyTotal);

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm animate-fade-in"
      >
        {job.phase === 'committing' ? <Spinner size="sm" /> : <CheckCircle size={16} className="text-green-500" />}
        <span className="text-gray-700 dark:text-gray-200">
          {job.phase === 'committing'
            ? `Importing ${job.folderName}… ${finishedCount}/${job.items.length}`
            : `Import complete: ${job.folderName}`}
        </span>
        {job.phase === 'done' && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); resetImport(); }}
            className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400"
          >
            <X size={14} />
          </span>
        )}
      </button>
    );
  }

  const collapse = () => setExpanded(false);

  return (
    <Modal
      title={job.phase === 'committing' ? `Importing ${job.folderName}…` : 'Import complete'}
      onClose={collapse}
      wide
    >
      <div className="p-5 space-y-4">
        {job.phase === 'committing' ? (
          <>
            <div>
              <p className="text-sm text-gray-700 dark:text-gray-200 tabular-nums">
                {finishedCount} of {job.items.length} files done
                {job.newSubAssemblyTotal > 0 && ` · ${createdSoFar} of ${job.newSubAssemblyTotal} sub-assemblies created`}
              </p>
              <div className="mt-2 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-200"
                  style={{ width: `${job.items.length > 0 ? (finishedCount / job.items.length) * 100 : 0}%` }}
                />
              </div>
              {job.currentLocation && (
                <p className="mt-1.5 text-xs text-gray-400">Currently: {job.currentLocation}</p>
              )}
            </div>

            <FileDetailsDisclosure open={showFileDetails} onToggle={() => setShowFileDetails((v) => !v)} items={job.items} />

            <div className="flex items-center justify-between pt-2 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => cancelImport()}
                disabled={job.cancelRequested}
                className="text-sm text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {job.cancelRequested ? 'Cancelling…' : 'Cancel import'}
              </button>
              <button onClick={collapse} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
                Keep running in background
              </button>
            </div>
          </>
        ) : (
          <>
            <ResultSummary
              folderName={job.folderName}
              createdCount={createdSoFar}
              mergedCount={job.mergedSubAssemblyTotal}
              newCount={newCount}
              linkedCount={linkedCount}
              failedCount={errorItems.length}
            />

            {errorItems.length > 0 && (
              <FileDetailsDisclosure open={showFileDetails} onToggle={() => setShowFileDetails((v) => !v)} items={job.items} onlyFailed />
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
              <button onClick={collapse} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
                Close
              </button>
              <button
                onClick={() => { requestViewManifest(job.projectId!); collapse(); }}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"
              >
                <FolderInput size={14} />
                View manifest
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ResultSummary({
  folderName, createdCount, mergedCount, newCount, linkedCount, failedCount,
}: {
  folderName: string; createdCount: number; mergedCount: number; newCount: number; linkedCount: number; failedCount: number;
}) {
  const nothingNewHappened = createdCount === 0 && mergedCount === 0 && newCount === 0 && linkedCount > 0;

  return (
    <div className="space-y-2">
      {nothingNewHappened ? (
        <p className="text-sm text-gray-700 dark:text-gray-200">
          Linked {linkedCount} file{linkedCount === 1 ? '' : 's'} to existing sub-assemblies. No new sub-assemblies created.
        </p>
      ) : (
        <p className="text-sm text-gray-700 dark:text-gray-200">
          Created {createdCount} new sub-assembl{createdCount === 1 ? 'y' : 'ies'}
          {mergedCount > 0 && ` · merged into ${mergedCount} existing`}
          {' '}· placed {newCount} new part{newCount === 1 ? '' : 's'}
          {linkedCount > 0 && ` · linked ${linkedCount} existing file${linkedCount === 1 ? '' : 's'}`}
        </p>
      )}
      {failedCount > 0 && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          {failedCount} file{failedCount === 1 ? '' : 's'} failed to import from {folderName}. See details below.
        </p>
      )}
    </div>
  );
}

function FileDetailsDisclosure({
  open, onToggle, items, onlyFailed = false,
}: {
  open: boolean;
  onToggle: () => void;
  items: { file: File; segments: string[]; status: string; linked: boolean; error?: string }[];
  onlyFailed?: boolean;
}) {
  const shown = onlyFailed ? items.filter((i) => i.status === 'error') : items;
  return (
    <div>
      <button onClick={onToggle} className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent">
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {onlyFailed ? 'Show details' : 'Show file details'}
      </button>
      {open && (
        <div className="mt-2 max-h-48 overflow-y-auto space-y-1 border-t border-gray-200 dark:border-gray-700 pt-2">
          {shown.map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              {item.status === 'done' && <CheckCircle size={12} className="text-green-500 flex-shrink-0" />}
              {item.status === 'error' && <AlertCircle size={12} className="text-amber-500 flex-shrink-0" />}
              {item.status === 'active' && <Spinner size="sm" />}
              {item.status === 'pending' && <div className="w-3 h-3 rounded-full border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" />}
              <span className="truncate text-gray-600 dark:text-gray-300 flex-1">
                {item.segments.length > 0 ? `${item.segments.join(' > ')} / ` : ''}{item.file.name}
              </span>
              {item.error && <span className="text-amber-600 dark:text-amber-400 truncate flex-shrink-0 max-w-[40%]">{item.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
