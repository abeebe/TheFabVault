import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChevronLeft, Pencil, Trash2, Plus, ArrowUp, ArrowDown, Star, X } from 'lucide-react';
import { useCollection } from '../hooks/useCollections.js';
import { ModelCard } from '../components/ModelCard.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { Modal } from '../components/Modal.js';
import { Spinner } from '../components/Spinner.js';
import { useMe } from '../hooks/useMe.js';
import { isOwnerOrAdmin } from '../lib/permissions.js';
import { api } from '../lib/api.js';
import type { ModelOut } from '../lib/api.js';

// One member tile: reuses ModelCard as-is (per the ticket's routing note
// -- "reuse ModelCard for the collection detail grid") and overlays
// membership-only controls (reorder, set cover, remove) as absolutely
// positioned siblings, not children of ModelCard's own <Link>. Because
// these buttons live outside the anchor in the DOM (CSS position only
// stacks them visually on top of it), clicking one never triggers the
// card's navigate-to-model-page click -- no preventDefault/stopPropagation
// juggling needed the way LikeButton needs it inside ModelCard itself.
// The wrapping overlay div is pointer-events-none so the rest of the tile
// (everywhere that isn't a button) still passes clicks through to the
// card underneath; only the buttons re-enable pointer-events.
function CollectionModelTile({
  model, isFirst, isLast, isCover, canEdit, onMoveUp, onMoveDown, onToggleCover, onRemove,
}: {
  model: ModelOut;
  isFirst: boolean;
  isLast: boolean;
  isCover: boolean;
  // Membership mutations (reorder/cover/remove) are owner-or-admin only
  // on the COLLECTION, same rule as everything else gated in this file --
  // see CollectionPage's own `canEdit` for the full rationale.
  canEdit: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleCover: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="relative group/tile">
      <ModelCard model={model} />
      {canEdit && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-2 left-2 flex gap-1 opacity-0 group-hover/tile:opacity-100 transition-opacity pointer-events-auto">
            <button
              onClick={onMoveUp}
              disabled={isFirst}
              title="Move earlier"
              className="p-1 rounded bg-black/50 text-white hover:bg-black/70 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowUp size={12} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={isLast}
              title="Move later"
              className="p-1 rounded bg-black/50 text-white hover:bg-black/70 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowDown size={12} />
            </button>
          </div>
          <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover/tile:opacity-100 transition-opacity pointer-events-auto">
            <button
              onClick={onToggleCover}
              title={isCover ? 'Cover image (click to clear)' : 'Set as cover'}
              className={`p-1 rounded ${isCover ? 'bg-accent text-white' : 'bg-black/50 text-white hover:bg-black/70'}`}
            >
              <Star size={12} className={isCover ? 'fill-current' : ''} />
            </button>
            <button
              onClick={onRemove}
              title="Remove from collection"
              className="p-1 rounded bg-black/50 text-white hover:bg-red-600"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Collection detail page (#2169, Phase B3) -- the /collections/:id route.
// Mirrors SetView.tsx's inline-edit-on-click shape for name/description
// (click text -> input -> blur/Enter saves) and ModelPage's
// header/delete-confirm layout, applied to a collection instead of a set
// or a model. Visibility editing is deliberately NOT exposed here --
// the ticket's scope is name/description/membership/reorder/cover, and
// api.collections.create already defaults new collections to 'public';
// adding a visibility toggle UI is a small enough follow-up that
// speculatively building it now (with no caller asking for it yet) would
// be exactly the over-building the routing brief calls out to avoid.
export function CollectionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { collection, loading, error, refresh, update, removeModel, addModels, reorderModels, setCover } =
    useCollection(id ?? null);
  const { me } = useMe();

  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const [descVal, setDescVal] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (loading && !collection) {
    return <div className="flex h-full items-center justify-center bg-surface"><Spinner size="lg" /></div>;
  }

  if (!collection) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="text-center text-gray-500 dark:text-gray-400">
          {error ? (
            <>
              <p className="text-sm text-red-400">Failed to load collection: {error}</p>
              <button onClick={refresh} className="mt-2 text-xs text-accent hover:underline">Retry</button>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Collection not found</p>
              <Link to="/collections" className="text-xs text-accent hover:underline mt-1 inline-block">Back to Collections</Link>
            </>
          )}
        </div>
      </div>
    );
  }

  async function saveName() {
    if (!collection || !nameVal.trim()) { setEditingName(false); return; }
    await update({ name: nameVal.trim() });
    setEditingName(false);
  }

  async function saveDesc() {
    if (!collection) { setEditingDesc(false); return; }
    await update({ description: descVal || null });
    setEditingDesc(false);
  }

  async function handleDeleteCollection() {
    if (!collection) return;
    setDeleting(true);
    try {
      await api.collections.delete(collection.id);
      navigate('/collections');
    } catch (err) {
      console.error('[CollectionPage] Failed to delete collection:', err);
      alert(`Couldn't delete collection: ${err instanceof Error ? err.message : String(err)}`);
      setDeleting(false);
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (!collection) return;
    const target = index + direction;
    if (target < 0 || target >= collection.models.length) return;
    const ids = collection.models.map((m) => m.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await reorderModels(ids);
  }

  async function handleToggleCover(modelId: string) {
    await setCover(collection!.coverModelId === modelId ? null : modelId);
  }

  const existingModelIds = new Set(collection.models.map((m) => m.id));
  // Name/description edit, add-models, delete, and per-member reorder/
  // cover/remove are owner-or-admin only on the COLLECTION (same rule as
  // ModelPage's `canEdit`, see lib/permissions.ts) -- any member can
  // still create their own collection (CollectionsPage, unchanged); this
  // only gates mutating someone else's.
  const canEdit = isOwnerOrAdmin(collection.ownerId, me);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface">
      {/* Header */}
      <div className="px-5 py-4 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Link to="/collections" className="text-xs text-gray-400 hover:text-accent inline-flex items-center gap-1 mb-1">
              <ChevronLeft size={12} /> Collections
            </Link>

            {editingName ? (
              <input
                autoFocus
                className="text-xl font-bold w-full bg-transparent border-b border-accent outline-none text-gray-900 dark:text-gray-100"
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
              />
            ) : (
              <h1
                className={`text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2 group flex-wrap ${canEdit ? 'cursor-pointer hover:text-accent' : ''}`}
                onClick={canEdit ? () => { setNameVal(collection.name); setEditingName(true); } : undefined}
              >
                {collection.name}
                {canEdit && <Pencil size={14} className="opacity-0 group-hover:opacity-100 text-gray-400" />}
                <span className="text-sm font-normal text-gray-400 ml-1">
                  ({collection.modelCount} model{collection.modelCount === 1 ? '' : 's'})
                </span>
              </h1>
            )}

            {editingDesc ? (
              <input
                autoFocus
                className="mt-1 text-sm w-full bg-transparent border-b border-accent outline-none text-gray-500 dark:text-gray-400"
                value={descVal}
                placeholder="Add a description…"
                onChange={(e) => setDescVal(e.target.value)}
                onBlur={saveDesc}
                onKeyDown={(e) => { if (e.key === 'Enter') saveDesc(); if (e.key === 'Escape') setEditingDesc(false); }}
              />
            ) : (
              <p
                className={`mt-1 text-sm text-gray-500 dark:text-gray-400 group flex items-center gap-1 ${canEdit ? 'cursor-pointer hover:text-gray-700 dark:hover:text-gray-200' : ''}`}
                onClick={canEdit ? () => { setDescVal(collection.description ?? ''); setEditingDesc(true); } : undefined}
              >
                {collection.description || <span className="italic text-gray-300 dark:text-gray-600">Add description…</span>}
                {canEdit && <Pencil size={12} className="opacity-0 group-hover:opacity-100" />}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {canEdit && (
              <>
                <button
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <Plus size={14} /> Add models
                </button>
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="Delete collection"
                >
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-5">
        {collection.models.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <p className="text-lg font-medium">This collection is empty</p>
            <p className="text-sm mt-1">Add models to get started.</p>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {collection.models.map((model, i) => (
              <CollectionModelTile
                key={model.id}
                model={model}
                isFirst={i === 0}
                isLast={i === collection.models.length - 1}
                isCover={collection.coverModelId === model.id}
                canEdit={canEdit}
                onMoveUp={() => handleMove(i, -1)}
                onMoveDown={() => handleMove(i, 1)}
                onToggleCover={() => handleToggleCover(model.id)}
                onRemove={() => removeModel(model.id)}
              />
            ))}
          </div>
        )}
      </div>

      {pickerOpen && (
        <ModelPicker
          title="Add models to collection"
          existingModelIds={existingModelIds}
          onAdd={(modelIds) => addModels(modelIds)}
          onDone={() => setPickerOpen(false)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(false)} title="Delete collection?">
          <div className="p-1">
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              This removes the collection but does not delete or move the models. They'll still be in the vault.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-1.5 text-sm rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteCollection}
                disabled={deleting}
                className="px-4 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Delete collection'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
