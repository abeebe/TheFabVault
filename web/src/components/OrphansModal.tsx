import { useState, useEffect } from 'react';
import { Search, Trash2, AlertTriangle, CheckCircle, Loader, FolderX, FileX } from 'lucide-react';
import { api } from '../lib/api.js';
import { Modal } from './Modal.js';
import type { OrphansReport } from '../types/index.js';

interface OrphansModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCleaned?: () => void;
}

export function OrphansModal({ isOpen, onClose, onCleaned }: OrphansModalProps) {
  const [report, setReport] = useState<OrphansReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<{ removedRecords: number; removedDirs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);

  useEffect(() => {
    if (isOpen) {
      scan();
    } else {
      setReport(null);
      setResult(null);
      setError(null);
      setConfirmClean(false);
    }
  }, [isOpen]);

  async function scan() {
    setLoading(true);
    setError(null);
    setResult(null);
    setConfirmClean(false);
    try {
      const data = await api.admin.getOrphans();
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan for orphans');
    } finally {
      setLoading(false);
    }
  }

  async function handleClean() {
    setCleaning(true);
    setError(null);
    try {
      const res = await api.admin.cleanOrphans({ deleteDeadRecords: true, deleteOrphanDirs: true });
      setResult({ removedRecords: res.removedRecords, removedDirs: res.removedDirs });
      setReport(null);
      setConfirmClean(false);
      onCleaned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clean orphans');
    } finally {
      setCleaning(false);
    }
  }

  if (!isOpen) return null;

  const totalIssues = (report?.deadRecords.length ?? 0) + (report?.orphanDirs.length ?? 0);
  const hasIssues = totalIssues > 0;

  return (
    <Modal title="Orphan Detection" onClose={onClose}>
      <div className="p-1 space-y-4 min-w-[420px]">
        {/* Scan description */}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Checks for broken library entries and leftover files on disk that no longer belong to any asset.
        </p>

        {loading && (
          <div className="flex items-center gap-3 text-sm text-gray-500 py-4 justify-center">
            <Loader size={16} className="animate-spin text-accent" />
            Scanning storage…
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {/* Clean result */}
        {result && (
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
              <CheckCircle size={14} />
              Cleanup complete
            </div>
            <p className="text-xs text-green-600 dark:text-green-500">
              {result.removedRecords} dead record{result.removedRecords !== 1 ? 's' : ''} removed ·{' '}
              {result.removedDirs} orphan director{result.removedDirs !== 1 ? 'ies' : 'y'} deleted
            </p>
          </div>
        )}

        {/* Report */}
        {report && !loading && (
          <div className="space-y-3">
            {!hasIssues ? (
              <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-3">
                <CheckCircle size={14} />
                No orphans found — library is clean!
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={14} />
                  Found {totalIssues} issue{totalIssues !== 1 ? 's' : ''}
                </div>

                {/* Dead records */}
                {report.deadRecords.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      <FileX size={12} />
                      Dead records ({report.deadRecords.length}) — in database but file missing
                    </div>
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                      {report.deadRecords.map((r) => (
                        <div key={r.id} className="px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 font-mono truncate" title={r.id}>
                          {r.filename}
                          <span className="ml-2 text-gray-400">{r.id.slice(0, 8)}…</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Orphan dirs */}
                {report.orphanDirs.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      <FolderX size={12} />
                      Orphan directories ({report.orphanDirs.length}) — on disk but no asset record
                    </div>
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                      {report.orphanDirs.map((d) => (
                        <div key={d} className="px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 font-mono truncate">
                          {d}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={scan}
            disabled={loading || cleaning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            <Search size={13} />
            {loading ? 'Scanning…' : 'Re-scan'}
          </button>

          <div className="flex-1" />

          {!result && report && hasIssues && !confirmClean && (
            <button
              onClick={() => setConfirmClean(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              <Trash2 size={13} />
              Clean up {totalIssues} issue{totalIssues !== 1 ? 's' : ''}
            </button>
          )}

          {confirmClean && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">This cannot be undone.</span>
              <button
                onClick={() => setConfirmClean(false)}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleClean}
                disabled={cleaning}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
              >
                {cleaning ? <Loader size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {cleaning ? 'Cleaning…' : 'Confirm clean'}
              </button>
            </div>
          )}

          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
