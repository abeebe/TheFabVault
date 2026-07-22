import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useCollections } from '../hooks/useCollections.js';
import { CollectionCard } from '../components/CollectionCard.js';
import { Modal } from '../components/Modal.js';
import { Spinner } from '../components/Spinner.js';

// Collections list landing (#2169, Phase B3) -- the /collections route.
// Deliberately simpler than BrowsePage: no search/sort/category filters,
// because there's no B1/B2-equivalent scope call for them here (the
// ticket's plan reference is "cards: cover, name, count" -- a grid, not a
// second discovery surface). If Collections grows enough to need search
// the way models did, that's its own follow-up ticket, not something to
// speculatively build in now.
export function CollectionsPage() {
  const navigate = useNavigate();
  const { collections, loading, error, refresh, createCollection } = useCollections();

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createCollection(name);
      navigate(`/collections/${created.id}`);
    } catch (err) {
      console.error('[CollectionsPage] Failed to create collection:', err);
      alert(`Couldn't create collection: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Collections</span>
        <span className="text-xs text-gray-400">{collections.length} {collections.length === 1 ? 'collection' : 'collections'}</span>
        <div className="flex-1" />
        <button
          onClick={() => setNewOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} /> New collection
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64 text-red-400">
            <p className="text-sm">Failed to load collections: {error}</p>
            <button onClick={refresh} className="mt-2 text-xs text-accent hover:underline">Retry</button>
          </div>
        ) : collections.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <p className="text-lg font-medium">No collections yet</p>
            <p className="text-sm mt-1">Create a collection to group models together.</p>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {collections.map((c) => <CollectionCard key={c.id} collection={c} />)}
          </div>
        )}
      </div>

      {newOpen && (
        <Modal title="New Collection" onClose={() => { setNewOpen(false); setNewName(''); }}>
          <div className="p-1 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                placeholder="e.g. Dragon Miniatures"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setNewOpen(false); setNewName(''); }}
                className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {creating ? 'Creating…' : 'Create collection'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
