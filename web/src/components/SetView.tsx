import { useCallback, useState } from 'react';
import { Trash2, Pencil } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSetDetail } from '../hooks/useSets.js';
import { AssetGrid } from './AssetGrid.js';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import type { FolderOut, ProjectOut } from '../types/index.js';

interface Props {
  setId: string;
  folders: FolderOut[];
  projects: ProjectOut[];
  onAddToProject: (assetId: string, projectId: string) => void;
  onDeleted: () => void;
  onSetUpdated: () => void;
}

// A set's detail view. Mirrors ProjectView's shape but stripped of the
// active-work scaffolding (no printer/laser/vinyl settings, no per-asset
// overrides). Members keep their normal folder/tags; remove-from-set
// only severs the membership row, doesn't trash the file.
export function SetView({ setId, folders, projects, onAddToProject, onDeleted, onSetUpdated }: Props) {
  const { set, loading, refresh, removeAsset, update } = useSetDetail(setId);
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const [descVal, setDescVal] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleRemoveAsset = useCallback(async (id: string) => {
    await removeAsset(id);
    onSetUpdated();
  }, [removeAsset, onSetUpdated]);

  async function saveName() {
    if (!set || !nameVal.trim()) { setEditingName(false); return; }
    await update({ name: nameVal.trim() });
    setEditingName(false);
    onSetUpdated();
  }

  async function saveDesc() {
    if (!set) { setEditingDesc(false); return; }
    await update({ description: descVal || null });
    setEditingDesc(false);
    onSetUpdated();
  }

  async function handleDelete() {
    if (!set) return;
    await api.sets.delete(set.id);
    onDeleted();
  }

  if (loading || !set) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
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
              <h2
                className="text-xl font-bold text-gray-900 dark:text-gray-100 cursor-pointer hover:text-accent flex items-center gap-2 group"
                onClick={() => { setNameVal(set.name); setEditingName(true); }}
              >
                {set.name}
                <Pencil size={14} className="opacity-0 group-hover:opacity-100 text-gray-400" />
                <span className="text-sm font-normal text-gray-400 ml-2">({set.assetCount} file{set.assetCount === 1 ? '' : 's'})</span>
              </h2>
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
                className="mt-1 text-sm text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 group flex items-center gap-1"
                onClick={() => { setDescVal(set.description ?? ''); setEditingDesc(true); }}
              >
                {set.description || <span className="italic text-gray-300 dark:text-gray-600">Add description…</span>}
                <Pencil size={12} className="opacity-0 group-hover:opacity-100" />
              </p>
            )}
          </div>

          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0"
            title="Delete set"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-5">
        {set.assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <p className="text-lg font-medium">This set is empty</p>
            <p className="text-sm mt-1">Drag files onto the set in the sidebar to add them.</p>
          </div>
        ) : (
          <AssetGrid
            assets={set.assets}
            folders={folders}
            loading={false}
            onUpdate={() => { refresh(); }}
            onDelete={handleRemoveAsset}
            projects={projects}
            onAddToProject={onAddToProject}
          />
        )}
      </div>

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(false)} title="Delete set?">
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            This removes the set but does not delete or move the files. They'll still be in their folders.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-4 py-1.5 text-sm rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              className="px-4 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600"
            >
              Delete set
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
