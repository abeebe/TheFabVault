import { useState } from 'react';
import { Trash2, Tag, FolderInput } from 'lucide-react';
import { AssetCard } from './AssetCard.js';
import { TagInput } from './TagInput.js';
import { Spinner } from './Spinner.js';
import { ModelViewer } from './ModelViewer.js';
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

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBatchDelete() {
    if (!window.confirm(`Delete ${selected.size} file(s)? This cannot be undone.`)) return;
    for (const id of selected) {
      try {
        await api.assets.delete(id);
        onDelete(id);
      } catch {}
    }
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
          ) : (
            <>
              <button
                onClick={() => setBatchTagMode(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Tag size={14} /> Add tags
              </button>
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
              <button
                onClick={handleBatchDelete}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                <Trash2 size={14} /> Delete
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
            onDelete={() => onDelete(asset.id)}
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
    </>
  );
}
