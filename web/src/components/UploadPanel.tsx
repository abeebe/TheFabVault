import { X, CheckCircle, AlertCircle, Copy } from 'lucide-react';
import { Spinner } from './Spinner.js';
import { useUploads } from '../hooks/useUploads.js';
import {
  setPanelOpen,
  clearItems,
  confirmDupes,
  cancelDupes,
  type DuplicateEntry,
} from '../lib/uploadStore.js';
import { useState, useEffect } from 'react';

// Floating progress panel + duplicate modal. Mounted at the App root so
// uploads remain visible across navigation (project view, folder switches,
// etc.) — see lib/uploadStore.ts for the module-level state that backs it.
export function UploadPanel() {
  const { items, panelOpen, dupeModal, phase, batchTotal, hashedCount } = useUploads();

  const doneCount = items.filter((i) => i.status === 'done').length;
  const errorCount = items.filter((i) => i.status === 'error').length;
  const finishedCount = doneCount + errorCount;

  let statusLine: string;
  let progressPct: number;
  if (phase === 'hashing') {
    statusLine = `Checking ${hashedCount} of ${batchTotal} for duplicates…`;
    progressPct = batchTotal > 0 ? (hashedCount / batchTotal) * 100 : 0;
  } else if (phase === 'uploading') {
    // During pipelined uploads hashing and uploading overlap, so surface
    // both counters until hashing finishes.
    if (batchTotal > 0 && hashedCount < batchTotal) {
      statusLine = `Checked ${hashedCount}/${batchTotal} · Uploaded ${finishedCount}/${batchTotal}`;
    } else {
      statusLine = `Uploading ${finishedCount} of ${items.length}…`;
    }
    progressPct = items.length > 0 ? (finishedCount / items.length) * 100 : 0;
  } else if (errorCount > 0) {
    statusLine = `${doneCount} done · ${errorCount} skipped/failed`;
    progressPct = 100;
  } else {
    statusLine = `${doneCount} done`;
    progressPct = 100;
  }

  return (
    <>
      {dupeModal && <DupeModal duplicates={dupeModal} />}

      {panelOpen && items.length > 0 && (
        <div className="fixed bottom-4 right-4 z-30 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 animate-fade-in">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Uploads</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearItems}
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
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 tabular-nums">{statusLine}</p>
            <div className="mt-2 h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {items.map((item, i) => {
              const hashPct = item.bytesTotal > 0 ? (item.bytesHashed / item.bytesTotal) * 100 : 0;
              const uploadPct = item.bytesTotal > 0 ? (item.bytesUploaded / item.bytesTotal) * 100 : 0;
              const showBars = item.status === 'hashing' || item.status === 'uploading' || (item.status === 'pending' && item.bytesHashed > 0);
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                  {item.status === 'hashing' && <Spinner size="sm" />}
                  {item.status === 'uploading' && <Spinner size="sm" />}
                  {item.status === 'pending' && <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" />}
                  {item.status === 'done' && <CheckCircle size={16} className="text-green-500 flex-shrink-0" />}
                  {item.status === 'error' && <AlertCircle size={16} className="text-amber-500 flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{item.file.name}</p>
                    {item.error && <p className="text-xs text-amber-600 dark:text-amber-400 truncate">{item.error}</p>}
                    {showBars && (
                      <div className="mt-1 space-y-0.5">
                        <div className="h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <div
                            className="h-full bg-green-500 transition-all duration-150"
                            style={{ width: `${hashPct}%` }}
                          />
                        </div>
                        <div className="h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-150"
                            style={{ width: `${uploadPct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function DupeModal({ duplicates }: { duplicates: DuplicateEntry[] }) {
  const [entries, setEntries] = useState<DuplicateEntry[]>(duplicates);

  // Reset local state if the upstream duplicate set changes (e.g. another
  // upload triggers while this one is still resolving).
  useEffect(() => { setEntries(duplicates); }, [duplicates]);

  function toggle(idx: number) {
    setEntries((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, keep: !e.keep } : e))
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-2xl shadow-2xl overflow-hidden">
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
          <button onClick={cancelDupes} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

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

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <button
            onClick={cancelDupes}
            className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel all
          </button>
          <button
            onClick={() => confirmDupes(entries)}
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
