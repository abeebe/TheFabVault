import { useEffect, useState } from 'react';
import { X, Search, Check, FileBox } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './Spinner.js';
import type { ModelOut } from '../lib/api.js';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 200;

interface Props {
  title?: string;
  existingModelIds: Set<string>;
  onAdd: (modelIds: string[]) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}

// Model-level analog of AssetPicker.tsx, used by CollectionPage's "Add
// models" affordance. Deliberately not shared code with AssetPicker --
// that component's filtering is entirely client-side (it loads up to 500
// assets once and filters in memory), whereas this one searches via
// api.models.list's own q param (same debounce idiom as BrowsePage's
// search box) since the vault's full model list isn't guaranteed to be a
// few hundred rows forever the way AssetPicker's comment assumes for
// assets. Selection/checkmark/footer chrome is intentionally the same
// look so both pickers read as one pattern to a user, even though the
// data-fetching underneath differs.
export function ModelPicker({ title = 'Add models', existingModelIds, onAdd, onDone, onClose }: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<ModelOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.models.list({ q: query || undefined, limit: PAGE_LIMIT })
      .then((result) => { if (!cancelled) setModels(result.items); })
      .catch((err) => console.error('[ModelPicker] Failed to load models:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  function toggleModel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
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
      console.error('[ModelPicker] Failed to add models:', err);
    } finally {
      setAdding(false);
    }
  }

  const available = models.filter((m) => !existingModelIds.has(m.id));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search models..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner size="md" /></div>
          ) : available.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              {models.length === 0 ? 'No matching models found.' : 'All matching models are already in this collection.'}
            </div>
          ) : (
            <div className="space-y-1">
              {available.map((model) => {
                const isSelected = selected.has(model.id);
                const thumbUrl = api.models.coverThumbUrl(model);
                return (
                  <button
                    key={model.id}
                    onClick={() => toggleModel(model.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                      isSelected
                        ? 'bg-accent/10 border border-accent/30'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700 border border-transparent'
                    }`}
                  >
                    <div className="w-10 h-10 rounded bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {thumbUrl ? (
                        <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <FileBox size={18} className="text-blue-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{model.title}</p>
                      <p className="text-xs text-gray-400">{model.fileCount} file{model.fileCount === 1 ? '' : 's'}</p>
                    </div>
                    <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${
                      isSelected ? 'bg-accent border-accent text-white' : 'border-gray-300 dark:border-gray-600'
                    }`}>
                      {isSelected && <Check size={12} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <span className="text-xs text-gray-500">
            {selected.size > 0 ? `${selected.size} model${selected.size !== 1 ? 's' : ''} selected` : `${available.length} models found`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={selected.size === 0 || adding}
              className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''} model${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
