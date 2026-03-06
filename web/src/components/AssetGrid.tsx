import { useState } from 'react';
import { Trash2, Tag, FolderInput, LayoutGrid } from 'lucide-react';
import { AssetCard } from './AssetCard.js';
import { TagInput } from './TagInput.js';
import { Spinner } from './Spinner.js';
import { ModelViewer } from './ModelViewer.js';
import { Modal } from './Modal.js';
import { api } from '../lib/api.js';
import type { AssetOut, FolderOut, ProjectOut, ProjectOverrides } from '../types/index.js';

interface AssetGridProps {
  assets: AssetOut[];
  folders: FolderOut[];
  loading: boolean;
  onUpdate: (updated: AssetOut) => void;
  onDelete: (id: string) => void;
  // Project mode
  projectMode?: boolean;
  onEditOverrides?: (asset: AssetOut) => void;
  projectAssetOverrides?: Record<string, ProjectOverrides>;
  projects?: ProjectOut[];
  onAddToProject?: (assetId: string, projectId: string) => void;
}

export function AssetGrid({
  assets, folders, loading, onUpdate, onDelete,
  projectMode, onEditOverrides, projectAssetOverrides,
  projects, onAddToProject,
}: AssetGridProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewAsset, setPreviewAsset] = useState<AssetOut | null>(null);
  const [batchTagMode, setBatchTagMode] = useState(false);
  const [batchTags, setBatchTags] = useState<string[]>([]);
  const [batchCategoryMode, setBatchCategoryMode] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Single-asset delete — soft-deletes (moves to trash)
  async function handleAssetDelete(id: string) {
    try {
      await api.assets.delete(id);
      onDelete(id);
    } catch {}
  }

  async function executeBatchDelete() {
    setBatchDeleting(true);
    for (const id of selected) {
      try {
        await api.assets.delete(id);
        onDelete(id);
      } catch {}
    }
    setBatchDeleting(false);
    setBatchDeleteOpen(false);
    setSelected(new Set());
  }

  async function handleBatchTag() {
    for (const id of selected) {
      try {
        const asset = assets.find((a) => a.id === id);
        if (!asset) continue;
        const merged = Array.from(new Set([...asset.tags, ...batchTags]));
        const updated = await api.assets.updateTags(id, merged);
        onUpdate(updated);
      } catch {}
    }
    setBatchTags([]);
    setBatchTagMode(false);
    setSelected(new Set());
  }

  async function handleBatchMove(folderId: string | null) {
    for (const id of selected) {
      try {
        const updated = await api.assets.moveToFolder(id, folderId);
        onUpdate(updated);
      } catch {}
    }
    setSelected(new Set());
  }

  async function handleBatchCategory(category: string | null) {
    for (const id of selected) {
      try {
        const updated = await api.assets.setCategory(id, category);
        onUpdate(updated);
      } catch {}
    }
    setBatchCategoryMode(false);
    setSelected(new Set());
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-400">
        <p className="text-lg font-medium">No files here</p>
        <p className="text-sm mt-1">Upload files or import from your NAS mount</p>
      </div>
    );
  }

  return (
    <>
      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 px-3 py-2.5 bg-accent/10 dark:bg-accent/20 rounded-xl border border-accent/30">
          <span className="text-sm font-medium text-accent">{selected.size} selected</span>
          <div className="flex-1" />

          {batchTagMode ? (
            <>
              <div className="w-56">
                <TagInput tags={batchTags} onChange={setBatchTags} placeholder="Tags to add..." />
              </div>
              <button
                onClick={handleBatchTag}
                className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                Apply tags
              </button>
              <button
                onClick={() => { setBatchTagMode(false); setBatchTags([]); }}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </>
          ) : batchCategoryMode ? (
            <>
              <span className="text-sm text-gray-600 dark:text-gray-300">Set category:</span>
              {([
                { value: null, label: 'Auto-detect' },
                { value: '3dmodel', label: '3D Models' },
                { value: '2d', label: '2D Designs' },
              ] as { value: string | null; label: string }[]).map(({ value, label }) => (
                <button
                  key={String(value)}
                  onClick={() => handleBatchCategory(value)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  {label}
                </button>
              ))}
              <button
                onClick={() => setBatchCategoryMode(false)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { setBatchTagMode(true); setBatchCategoryMode(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Tag size={14} /> Add tags
              </button>
              <button
                onClick={() => { setBatchCategoryMode(true); setBatchTagMode(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <LayoutGrid size={14} /> Set category
              </button>
              {!projectMode && (
                <div className="relative group">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700">
                    <FolderInput size={14} /> Move to...
                  </button>
                  <div className="absolute right-0 top-full mt-1 hidden group-hover:block w-44 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-20 animate-fade-in">
                    <button
                      onClick={() => handleBatchMove(null)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
                    >
                      No folder
                    </button>
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => handleBatchMove(f.id)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => setBatchDeleteOpen(true)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border ${
                  projectMode
                    ? 'border-orange-300 dark:border-orange-700 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20'
                    : 'border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                }`}
              >
                <Trash2 size={14} /> {projectMode ? 'Remove' : 'Delete'}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Grid */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {assets.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            folders={folders}
            selected={selected.has(asset.id)}
            onSelect={() => toggleSelect(asset.id)}
            onUpdate={onUpdate}
            onPreview={() => setPreviewAsset(asset)}
            projectMode={projectMode}
            hasOverrides={!!(projectAssetOverrides?.[asset.id] && (
              Object.keys(projectAssetOverrides[asset.id].printer ?? {}).length > 0 ||
              Object.keys(projectAssetOverrides[asset.id].laser ?? {}).length > 0 ||
              Object.keys(projectAssetOverrides[asset.id].vinyl ?? {}).length > 0
            ))}
            onEditOverrides={onEditOverrides ? () => onEditOverrides(asset) : undefined}
            projects={projects}
            onAddToProject={onAddToProject ? (projectId) => onAddToProject(asset.id, projectId) : undefined}
            // project mode: parent handles remove-from-project API call; normal mode: we soft-delete
            onDelete={projectMode ? () => onDelete(asset.id) : () => handleAssetDelete(asset.id)}
          />
        ))}
      </div>

      {previewAsset && (
        <ModelViewer
          asset={previewAsset}
          onClose={() => setPreviewAsset(null)}
          onUpdate={(updated) => { onUpdate(updated); setPreviewAsset(updated); }}
        />
      )}

      {/* Batch delete modal */}
      {batchDeleteOpen && (
        <Modal
          title={projectMode ? `Remove ${selected.size} file${selected.size !== 1 ? 's' : ''} from project?` : `Delete ${selected.size} file${selected.size !== 1 ? 's' : ''}?`}
          onClose={() => setBatchDeleteOpen(false)}
        >
          <div className="p-1 space-y-4">
            {projectMode ? (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  The selected files will be removed from this project. They will remain in your vault.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setBatchDeleteOpen(false)}
                    className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => executeBatchDelete()}
                    disabled={batchDeleting}
                    className="px-4 py-1.5 text-sm rounded bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-60"
                  >
                    {batchDeleting ? 'Removing…' : 'Remove from project'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Move {selected.size} file{selected.size !== 1 ? 's' : ''} to trash?
                  You can restore them or permanently delete from the Trash view.
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => executeBatchDelete()}
                    disabled={batchDeleting}
                    className="w-full flex flex-col items-start px-4 py-3 rounded-lg border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 text-left"
                  >
                    <span className="text-sm font-medium text-red-600 dark:text-red-400">
                      {batchDeleting ? 'Moving to trash…' : 'Move to trash'}
                    </span>
                    <span className="text-xs text-gray-400 mt-0.5">Files can be restored from the Trash in the sidebar</span>
                  </button>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => setBatchDeleteOpen(false)}
                    className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
