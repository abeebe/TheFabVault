import { useState, useEffect } from 'react';
import { X, Search, Check, FileBox, Image, File } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './Spinner.js';
import type { AssetOut } from '../types/index.js';

function getFileIcon(filename: string) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (['.stl', '.obj', '.3mf', '.step', '.stp', '.lys', '.ctb', '.photon'].includes(ext)) return <FileBox size={20} className="text-blue-400" />;
  if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.dxf', '.cdr', '.ai', '.eps', '.pdf', '.lbrn', '.lbrn2'].includes(ext)) return <Image size={20} className="text-green-400" />;
  return <File size={20} className="text-gray-400" />;
}

interface Props {
  // Extracted from ProjectView.tsx so the build manifest's "+ Add parts"
  // flow (Reid's UX spec, 4.9) can reuse it almost verbatim, scoped to a
  // sub-assembly instead of the project's flat asset list — same search,
  // same pagination, same multi-select-with-checkmark list, just a
  // different destination for the selection via `onAdd`.
  title?: string;
  existingAssetIds: Set<string>;
  // Return value ignored by the picker; loosely typed so both
  // api.projects.addAssets (Promise<void>) and api.manifest.addParts
  // (Promise<{ added: number }>) can be passed directly.
  onAdd: (assetIds: string[]) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}

export function AssetPicker({ title = 'Add files to project', existingAssetIds, onAdd, onDone, onClose }: Props) {
  const [allAssets, setAllAssets] = useState<AssetOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [page, setPage] = useState(0);

  const PAGE_SIZE = 10;

  useEffect(() => {
    api.assets.list({ limit: 500 }).then((result) => {
      setAllAssets(result.items);
    }).catch((err) => {
      console.error('[AssetPicker] Failed to load assets:', err);
    }).finally(() => setLoading(false));
  }, []);

  // Reset to first page whenever the filter changes so users don't end up
  // looking at an empty page after narrowing the result set.
  useEffect(() => { setPage(0); }, [searchFilter]);

  function toggleAsset(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setAdding(true);
    try {
      await onAdd(Array.from(selected));
      onDone();
    } catch (err) {
      console.error('[AssetPicker] Failed to add assets:', err);
    } finally {
      setAdding(false);
    }
  }

  const available = allAssets.filter((a) => !existingAssetIds.has(a.id));
  const filtered = searchFilter
    ? available.filter((a) =>
        a.filename.toLowerCase().includes(searchFilter.toLowerCase()) ||
        (a.originalName && a.originalName.toLowerCase().includes(searchFilter.toLowerCase())) ||
        a.tags.some((t) => t.toLowerCase().includes(searchFilter.toLowerCase()))
      )
    : available;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageItems = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const allPageSelected = pageItems.length > 0 && pageItems.every((a) => selected.has(a.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const a of pageItems) next.delete(a.id);
      } else {
        for (const a of pageItems) next.add(a.id);
      }
      return next;
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search files..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <button
              onClick={toggleSelectAll}
              disabled={pageItems.length === 0}
              className="text-xs text-accent hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
            >
              {allPageSelected
                ? `Deselect page (${pageItems.length})`
                : `Select page (${pageItems.length})`}
            </button>
            <span className="text-[11px] text-gray-400">
              {filtered.length > 0
                ? `Showing ${pageStart + 1}–${Math.min(pageStart + PAGE_SIZE, filtered.length)} of ${filtered.length}`
                : ''}
            </span>
          </div>
        </div>

        {/* Asset list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              {available.length === 0 ? 'All vault files are already here.' : 'No matching files found.'}
            </div>
          ) : (
            <div className="space-y-1">
              {pageItems.map((asset) => {
                const isSelected = selected.has(asset.id);
                const thumbUrl = api.assets.thumbUrl(asset);
                return (
                  <button
                    key={asset.id}
                    onClick={() => toggleAsset(asset.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                      isSelected
                        ? 'bg-accent/10 border border-accent/30'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700 border border-transparent'
                    }`}
                  >
                    {/* Thumbnail or icon */}
                    <div className="w-10 h-10 rounded bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {asset.thumbStatus === 'done' && thumbUrl ? (
                        <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        getFileIcon(asset.filename)
                      )}
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {asset.originalName || asset.filename}
                      </p>
                      <div className="flex gap-1 mt-0.5">
                        {asset.tags.slice(0, 3).map((t) => (
                          <span key={t} className="px-1.5 py-0 rounded text-[10px] bg-gray-100 dark:bg-gray-600 text-gray-500 dark:text-gray-300">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Checkmark */}
                    <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${
                      isSelected
                        ? 'bg-accent border-accent text-white'
                        : 'border-gray-300 dark:border-gray-600'
                    }`}>
                      {isSelected && <Check size={12} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 px-5 py-2 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
            <button
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              className="px-2 py-1 text-xs rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ‹ Prev
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              Page {currentPage + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= totalPages - 1}
              className="px-2 py-1 text-xs rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next ›
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <span className="text-xs text-gray-500">
            {selected.size > 0 ? `${selected.size} file${selected.size !== 1 ? 's' : ''} selected` : `${filtered.length} files available`}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={selected.size === 0 || adding}
              className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''} file${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
