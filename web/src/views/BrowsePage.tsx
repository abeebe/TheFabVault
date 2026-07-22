import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useModels } from '../hooks/useModels.js';
import { useCategories } from '../hooks/useCategories.js';
import { buildCategoryOptions } from '../lib/categoryTree.js';
import { ModelCard } from '../components/ModelCard.js';
import { SearchBar } from '../components/SearchBar.js';
import { Modal } from '../components/Modal.js';
import { Spinner } from '../components/Spinner.js';
import { api } from '../lib/api.js';
import type { ModelListParams } from '../lib/api.js';

const PAGE_SIZE = 60;
// Debounces the search box -> URL sync so rapid typing doesn't spam
// pushState (and, downstream, the /models fetch) on every keystroke.
// SearchBar itself stays exactly as-is (LibraryPage's component,
// unmodified) -- this is a thin URL-sync wrapper around it, not a new
// search input.
const SEARCH_DEBOUNCE_MS = 300;

// Phase B scope (#2168 ticket): only two sort options ship now -- "likes"
// is explicitly deferred until B1 (#2167, collections/likes API) merges;
// wiring it in ahead of that would mean shipping a sort value the API
// can't yet satisfy. Values match ModelListParams['sort'] so no
// translation layer is needed between URL state and the fetch params.
type BrowseSort = 'date_desc' | 'name_asc';
const DEFAULT_SORT: BrowseSort = 'date_desc';
const SORT_OPTIONS: Array<{ value: BrowseSort; label: string }> = [
  { value: 'date_desc', label: 'Newest' },
  { value: 'name_asc', label: 'Title A→Z' },
];

function isBrowseSort(value: string | null): value is BrowseSort {
  return value === 'date_desc' || value === 'name_asc';
}

// Browse landing page (#2168, Phase B) -- the new / route. Search-first:
// prominent search box, category chips (flat -- reuses the same tree
// flatten ModelPage's Edit Details select already does via
// buildCategoryOptions, just rendered as chips instead of <option>s),
// sort, and a grid of ModelCard (unchanged from LibraryPage/#2157). All
// three filters are deep-linkable via URL search params (useSearchParams)
// so a Browse view is shareable/bookmarkable -- q/category/sort round-trip
// through the URL, not just component state.
//
// This supersedes LibraryPage (#2157): the New Model affordance moves
// here (see AppShell.tsx / router for the /library -> / redirect) so it
// isn't stranded now that Browse is the front door.
export function BrowsePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const qParam = searchParams.get('q') ?? '';
  const categoryParam = searchParams.get('category');
  const sortParam = searchParams.get('sort');
  const sort: BrowseSort = isBrowseSort(sortParam) ? sortParam : DEFAULT_SORT;

  // Search input is local state so every keystroke is instantly
  // responsive in the box; it's debounced into the URL (and from there
  // into the fetch params below) rather than the URL being written on
  // every change. Kept in sync with the URL in the other direction too --
  // back/forward nav or landing on a bookmarked ?q= link updates the box.
  const [searchInput, setSearchInput] = useState(qParam);
  const [page, setPage] = useState(0);

  useEffect(() => { setSearchInput(qParam); }, [qParam]);

  useEffect(() => {
    if (searchInput === qParam) return;
    const timer = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (searchInput) next.set('q', searchInput); else next.delete('q');
        return next;
      }, { replace: true });
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const { categories } = useCategories();
  const categoryChips = buildCategoryOptions(categories);

  const [newModelOpen, setNewModelOpen] = useState(false);
  const [newModelTitle, setNewModelTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const params: ModelListParams = Object.fromEntries(
    Object.entries({
      q: qParam || undefined,
      category: categoryParam || undefined,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }).filter(([, v]) => v !== undefined)
  );

  const { models, total, loading, error, refresh } = useModels(params);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function handleCategorySelect(id: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('category', id); else next.delete('category');
      return next;
    });
    setPage(0);
  }

  function handleSortChange(next: BrowseSort) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === DEFAULT_SORT) params.delete('sort'); else params.set('sort', next);
      return params;
    });
    setPage(0);
  }

  async function handleCreate() {
    const title = newModelTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const created = await api.models.create({ title });
      navigate(`/models/${created.id}`);
    } catch (err) {
      console.error('[BrowsePage] Failed to create model:', err);
      alert(`Couldn't create model: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex-1 max-w-md">
          <SearchBar
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search models..."
          />
        </div>
        <div className="flex-1" />
        <select
          value={sort}
          onChange={(e) => handleSortChange(e.target.value as BrowseSort)}
          className="text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <button
          onClick={() => setNewModelOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} /> New model
        </button>
      </header>

      {categoryChips.length > 0 && (
        <div className="flex items-center gap-2 px-5 py-2 flex-wrap bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button
            onClick={() => handleCategorySelect(null)}
            className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
              categoryParam === null
                ? 'bg-accent text-white border-accent'
                : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            All
          </button>
          {categoryChips.map((chip) => (
            <button
              key={chip.id}
              onClick={() => handleCategorySelect(chip.id)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                categoryParam === chip.id
                  ? 'bg-accent text-white border-accent'
                  : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      <div className="px-5 py-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <span className="text-gray-900 dark:text-gray-100 font-medium">Browse</span>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{total} {total === 1 ? 'model' : 'models'}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64 text-red-400">
            <p className="text-sm">Failed to load models: {error}</p>
            <button onClick={refresh} className="mt-2 text-xs text-accent hover:underline">Retry</button>
          </div>
        ) : models.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <p className="text-lg font-medium">No models yet</p>
            <p className="text-sm mt-1">Create a model to get started.</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
              {models.map((model) => <ModelCard key={model.id} model={model} />)}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-6 pb-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Prev
                </button>
                <span className="text-xs text-gray-500 tabular-nums">Page {page + 1} of {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {newModelOpen && (
        <Modal title="New Model" onClose={() => { setNewModelOpen(false); setNewModelTitle(''); }}>
          <div className="p-1 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
              <input
                autoFocus
                value={newModelTitle}
                onChange={(e) => setNewModelTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                placeholder="e.g. Articulated Dragon"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setNewModelOpen(false); setNewModelTitle(''); }}
                className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newModelTitle.trim() || creating}
                className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {creating ? 'Creating…' : 'Create model'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
