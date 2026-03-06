import { useState, useEffect, useCallback } from 'react';
import { Trash2, RotateCcw, X, AlertTriangle, Image } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './Spinner.js';
import type { AssetOut } from '../types/index.js';

interface TrashViewProps {
  onClose: () => void;
  onRestored: () => void; // called when any asset is restored so main list can refresh
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDeletedAt(ts: number): string {
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString();
}

export function TrashView({ onClose, onRestored }: TrashViewProps) {
  const [items, setItems] = useState<AssetOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [emptying, setEmptying] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.trash.list();
      setItems(result.items);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRestore(id: string) {
    setActioningId(id);
    try {
      await api.trash.restore(id);
      setItems((prev) => prev.filter((a) => a.id !== id));
      onRestored();
    } catch {}
    setActioningId(null);
  }

  async function handleDeletePermanently(id: string) {
    setActioningId(id);
    try {
      await api.assets.deletePermanently(id);
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch {}
    setActioningId(null);
  }

  async function handleEmptyTrash() {
    setEmptying(true);
    try {
      await api.trash.empty();
      setItems([]);
    } catch {}
    setEmptying(false);
    setConfirmEmpty(false);
  }

  const totalSize = items.reduce((sum, a) => sum + a.size, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <Trash2 size={18} className="text-red-500 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Trash</h3>
            {!loading && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {items.length === 0
                  ? 'Empty'
                  : `${items.length} item${items.length !== 1 ? 's' : ''} · ${formatBytes(totalSize)}`}
              </p>
            )}
          </div>

          {/* Empty trash button */}
          {items.length > 0 && !confirmEmpty && (
            <button
              onClick={() => setConfirmEmpty(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-600 dark:text-red-400 border border-red-200 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              <Trash2 size={13} />
              Empty trash
            </button>
          )}

          {confirmEmpty && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-600 dark:text-red-400 font-medium">Delete all permanently?</span>
              <button
                onClick={handleEmptyTrash}
                disabled={emptying}
                className="px-3 py-1.5 rounded-lg text-xs bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-60"
              >
                {emptying ? 'Deleting…' : 'Yes, delete all'}
              </button>
              <button
                onClick={() => setConfirmEmpty(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-2">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400">
              <Trash2 size={40} strokeWidth={1.5} />
              <p className="text-sm">Trash is empty</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {items.map((asset) => {
                const thumb = api.assets.thumbUrl(asset);
                const isActioning = actioningId === asset.id;
                return (
                  <div key={asset.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors">
                    {/* Thumbnail */}
                    <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {thumb ? (
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Image size={18} className="text-gray-400" />
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                        {asset.originalName || asset.filename}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatBytes(asset.size)} · deleted {formatDeletedAt(asset.deletedAt!)}
                      </p>
                    </div>

                    {/* Actions */}
                    {isActioning ? (
                      <Spinner size="sm" />
                    ) : (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleRestore(asset.id)}
                          title="Restore"
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                        >
                          <RotateCcw size={12} />
                          Restore
                        </button>
                        <button
                          onClick={() => handleDeletePermanently(asset.id)}
                          title="Delete permanently"
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-red-600 dark:text-red-400 border border-red-200 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          <AlertTriangle size={12} />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer note */}
        {items.length > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
            <p className="text-xs text-gray-400">
              Files in trash still occupy disk space until permanently deleted.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
