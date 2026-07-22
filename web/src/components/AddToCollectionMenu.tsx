import { useEffect, useRef, useState } from 'react';
import { FolderPlus, Check, Plus } from 'lucide-react';
import { useCollections } from '../hooks/useCollections.js';
import { Spinner } from './Spinner.js';
import { api } from '../lib/api.js';

interface Props {
  modelId: string;
}

// Small popover menu for ModelPage's "add this model to a collection"
// affordance (#2169 ticket: "small menu listing collections + create-new
// inline — don't overbuild"). Deliberately does NOT try to show which
// collections this model already belongs to -- CollectionOut (the list
// shape) doesn't carry membership for an arbitrary model, only
// CollectionDetailOut does (for that one collection's own members), so
// finding out would mean an extra request per collection just to render
// a checkbox state. Instead: api.collections.addModels is idempotent
// (INSERT OR IGNORE server-side, same contract as models.like), so
// clicking an already-containing collection again is harmless, and this
// menu tracks "added this click" locally just to give the user feedback
// that their click landed.
export function AddToCollectionMenu({ modelId }: Props) {
  const { collections, loading, createCollection } = useCollections();
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  async function handleAdd(collectionId: string) {
    setBusyId(collectionId);
    try {
      await api.collections.addModels(collectionId, [modelId]);
      setAdded((prev) => new Set(prev).add(collectionId));
    } catch (err) {
      console.error('[AddToCollectionMenu] Failed to add to collection:', err);
      alert(`Couldn't add to collection: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreateAndAdd() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const collection = await createCollection(name, { modelIds: [modelId] });
      setAdded((prev) => new Set(prev).add(collection.id));
      setNewName('');
    } catch (err) {
      console.error('[AddToCollectionMenu] Failed to create collection:', err);
      alert(`Couldn't create collection: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        <FolderPlus size={14} /> Add to collection
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-20 flex flex-col">
          <div className="max-h-48 overflow-y-auto p-1">
            {loading ? (
              <div className="flex justify-center py-4"><Spinner size="sm" /></div>
            ) : collections.length === 0 ? (
              <p className="px-2 py-3 text-xs text-gray-400 italic">No collections yet.</p>
            ) : (
              collections.map((c) => {
                const isAdded = added.has(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => handleAdd(c.id)}
                    disabled={busyId === c.id || isAdded}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:hover:bg-transparent"
                  >
                    <span className="truncate">{c.name}</span>
                    {busyId === c.id ? (
                      <Spinner size="sm" />
                    ) : isAdded ? (
                      <Check size={14} className="text-accent flex-shrink-0" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-1.5 p-2 border-t border-gray-200 dark:border-gray-700">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAndAdd(); }}
              placeholder="New collection…"
              className="flex-1 min-w-0 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40"
            />
            <button
              onClick={handleCreateAndAdd}
              disabled={!newName.trim() || creating}
              title="Create and add"
              className="p-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex-shrink-0"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
