import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useModels } from '../hooks/useModels.js';
import { ModelCard } from '../components/ModelCard.js';
import { SearchBar } from '../components/SearchBar.js';
import { Modal } from '../components/Modal.js';
import { Spinner } from '../components/Spinner.js';
import { api } from '../lib/api.js';
import type { ModelListParams } from '../lib/api.js';

const PAGE_SIZE = 60;

// Model-centric library view (Phase A4, #2157). Deliberately basic per
// the phase plan -- search + sort + a grid of ModelCard, no category
// chips or collections yet (that's Browse/Discovery, Phase B). The one
// piece of connective tissue this page adds beyond "just a list" is the
// New Model button: without it, /library and /models/:id have no way to
// get data into them yet (from-folder conversion's bulk wizard is Phase
// B4), so the page would otherwise be an unreachable dead end.
export function LibraryPage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<NonNullable<ModelListParams['sort']>>('date_desc');
  const [page, setPage] = useState(0);
  const [newModelOpen, setNewModelOpen] = useState(false);
  const [newModelTitle, setNewModelTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const params: ModelListParams = Object.fromEntries(
    Object.entries({
      q: searchQuery || undefined,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }).filter(([, v]) => v !== undefined)
  );

  const { models, total, loading, error, refresh } = useModels(params);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function handleCreate() {
    const title = newModelTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const created = await api.models.create({ title });
      navigate(`/models/${created.id}`);
    } catch (err) {
      console.error('[LibraryPage] Failed to create model:', err);
      alert(`Couldn't create model: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex-1 max-w-sm">
          <SearchBar
            value={searchQuery}
            onChange={(v) => { setSearchQuery(v); setPage(0); }}
            placeholder="Search models..."
          />
        </div>
        <div className="flex-1" />
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as NonNullable<ModelListParams['sort']>); setPage(0); }}
          className="text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
        >
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="name_asc">Name A→Z</option>
          <option value="name_desc">Name Z→A</option>
        </select>
        <button
          onClick={() => setNewModelOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} /> New model
        </button>
      </header>

      <div className="px-5 py-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <span className="text-gray-900 dark:text-gray-100 font-medium">Library</span>
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
