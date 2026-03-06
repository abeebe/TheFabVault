import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Trash2, RefreshCw, AlertCircle, Hash, FileText } from 'lucide-react';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { api } from '../lib/api.js';
import type { DuplicatesReport, DuplicateGroup, DuplicateAsset } from '../types/index.js';

const API_BASE = (import.meta.env.VITE_API_URL as string) || '';

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function thumbUrl(asset: DuplicateAsset): string | null {
  if (!asset.thumbUrl) return null;
  const token = localStorage.getItem('mv_token');
  const base = `${API_BASE}${asset.thumbUrl}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// ─── Single duplicate group row ───────────────────────────────────────────────

interface GroupRowProps {
  group: DuplicateGroup;
  mode: 'name' | 'hash';
  onDeleted: (id: string) => void;
}

function GroupRow({ group, mode, onDeleted }: GroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<DuplicateAsset[]>(group.assets);

  async function handleDelete(asset: DuplicateAsset) {
    setDeleting(asset.id);
    setError(null);
    try {
      await api.assets.delete(asset.id); // soft-delete → moves to trash
      const next = assets.filter((a) => a.id !== asset.id);
      setAssets(next);
      onDeleted(asset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  }

  const label = mode === 'name'
    ? group.key
    : `${group.key.slice(0, 16)}…`;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
      >
        {expanded ? <ChevronDown size={14} className="flex-shrink-0 text-gray-400" /> : <ChevronRight size={14} className="flex-shrink-0 text-gray-400" />}
        <span className="flex-1 text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{label}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">{assets.length} copies</span>
      </button>

      {/* Asset list */}
      {expanded && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {error && (
            <p className="px-4 py-2 text-xs text-red-500">{error}</p>
          )}
          {assets.map((asset, i) => {
            const thumb = thumbUrl(asset);
            const isDeleting = deleting === asset.id;
            return (
              <div key={asset.id} className="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-gray-800">
                {/* Thumb */}
                <div className="w-10 h-10 flex-shrink-0 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
                  {thumb
                    ? <img src={thumb} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs font-mono">{asset.filename.split('.').pop()?.toUpperCase()}</div>
                  }
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                    {asset.originalName || asset.filename}
                    {i === 0 && (
                      <span className="ml-1.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded font-normal">oldest</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {formatBytes(asset.size)} · {new Date(asset.createdAt * 1000).toLocaleDateString()}
                    {asset.tags.length > 0 && ` · ${asset.tags.join(', ')}`}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex-shrink-0 flex items-center gap-1">
                  <button
                    onClick={() => handleDelete(asset)}
                    disabled={isDeleting || assets.length <= 1}
                    title="Move to trash"
                    className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-40 transition-colors"
                  >
                    {isDeleting ? <Spinner size="sm" /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface DuplicatesModalProps {
  onClose: () => void;
  onDeleted: (id: string) => void;
}

export function DuplicatesModal({ onClose, onDeleted }: DuplicatesModalProps) {
  const [report, setReport] = useState<DuplicatesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [rehashing, setRehashing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.admin.getDuplicates();
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load duplicates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRehash() {
    setRehashing(true);
    try {
      const result = await api.admin.rehashFiles();
      // Give the background job a moment then reload
      setTimeout(() => {
        load();
        setRehashing(false);
      }, Math.min(result.queued * 50 + 1000, 8000));
    } catch {
      setRehashing(false);
    }
  }

  function handleDeleted(id: string) {
    onDeleted(id);
    // Optimistically prune the report
    setReport((prev) => {
      if (!prev) return prev;
      function pruneGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
        return groups
          .map((g) => ({ ...g, assets: g.assets.filter((a) => a.id !== id), count: g.count - 1 }))
          .filter((g) => g.count > 1);
      }
      return {
        ...prev,
        byName: pruneGroups(prev.byName),
        byHash: pruneGroups(prev.byHash),
      };
    });
  }

  const totalNameDupes = report?.byName.reduce((s, g) => s + g.count - 1, 0) ?? 0;
  const totalHashDupes = report?.byHash.reduce((s, g) => s + g.count - 1, 0) ?? 0;

  return (
    <Modal title="Duplicate Files" onClose={onClose} wide>
      <div className="px-1 pb-2 space-y-5 max-h-[70vh] overflow-y-auto">
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12"><Spinner size="lg" /></div>
        ) : report && (
          <>
            {/* Summary row */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1 grid grid-cols-2 gap-3">
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1"><FileText size={11} /> By filename</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white mt-0.5">{totalNameDupes} extras</p>
                  <p className="text-xs text-gray-400">{report.byName.length} group{report.byName.length !== 1 ? 's' : ''}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1"><Hash size={11} /> By content hash</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white mt-0.5">{totalHashDupes} extras</p>
                  <p className="text-xs text-gray-400">{report.byHash.length} group{report.byHash.length !== 1 ? 's' : ''}</p>
                </div>
              </div>
              {report.unhashedCount > 0 && (
                <button
                  onClick={handleRehash}
                  disabled={rehashing}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors flex-shrink-0"
                >
                  <RefreshCw size={13} className={rehashing ? 'animate-spin' : ''} />
                  {rehashing ? 'Hashing…' : `Hash ${report.unhashedCount} file${report.unhashedCount !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>

            {/* By filename */}
            {report.byName.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <FileText size={12} /> Same filename
                </h4>
                {report.byName.map((g) => (
                  <GroupRow key={g.key} group={g} mode="name" onDeleted={handleDeleted} />
                ))}
              </section>
            )}

            {/* By hash */}
            {report.byHash.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <Hash size={12} /> Identical content (different names)
                </h4>
                {report.byHash.map((g) => (
                  <GroupRow key={g.key} group={g} mode="hash" onDeleted={handleDeleted} />
                ))}
              </section>
            )}

            {report.byName.length === 0 && report.byHash.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                <p className="text-base font-medium">No duplicates found</p>
                {report.unhashedCount > 0 && (
                  <p className="text-sm mt-1">Hash remaining files to check for content duplicates.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
