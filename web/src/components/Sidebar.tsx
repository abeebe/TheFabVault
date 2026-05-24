import { useState } from 'react';
import { Settings, Download, File, X, Plus, Layers, ChevronDown, ChevronRight, Box, Zap, Trash2, Heart } from 'lucide-react';
import { FolderTree } from './FolderTree.js';
import { TagBadge } from './TagInput.js';
import { api } from '../lib/api.js';
import { Sparkles } from 'lucide-react';
import type { AssetOut, FolderOut, ProjectOut, SetOut } from '../types/index.js';
import type { AssetStats } from '../hooks/useAssetStats.js';

function formatVaultSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// Match FolderTree's ASSET_DRAG_MIME — keep in sync.
const ASSET_DRAG_MIME = 'application/x-tfv-asset-ids';

interface SidebarProps {
  folders: FolderOut[];
  assets: AssetOut[];
  // Category counts across the whole vault (not just the loaded page).
  assetStats: AssetStats;
  selectedFolderId: string | null;
  selectedTags: string[];
  onFolderSelect: (id: string | null) => void;
  onTagToggle: (tag: string) => void;
  onFolderCreate: (name: string, parentId?: string) => void;
  onFolderRename: (id: string, name: string) => void;
  onFolderMove: (id: string, parentId: string | null) => void;
  onFolderDelete: (id: string) => void;
  // Drag-drop: assets dropped onto a folder row → move them there;
  // dropped onto a project row → add them to that project;
  // dropped onto a set row → add them to that set.
  onAssetsDropToFolder: (assetIds: string[], folderId: string | null) => void;
  onAssetsDropToProject: (assetIds: string[], projectId: string) => void;
  onAssetsDropToSet: (assetIds: string[], setId: string) => void;
  // Sets
  sets?: SetOut[];
  selectedSetId?: string | null;
  onSetSelect?: (id: string) => void;
  onOpenSetSuggestions?: () => void;
  onImportScan: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  trashCount?: number;
  // Projects
  projects?: ProjectOut[];
  selectedProjectId?: string | null;
  onProjectSelect?: (id: string) => void;
  onProjectCreate?: () => void;
  // Categories
  selectedCategory?: '3dmodel' | '2d' | 'uncategorized' | null;
  onCategorySelect?: (category: '3dmodel' | '2d' | 'uncategorized' | null) => void;
  // Favorites
  showFavoritesOnly?: boolean;
  onFavoritesToggle?: () => void;
}

export function Sidebar({
  folders,
  assets,
  assetStats,
  selectedFolderId,
  selectedTags,
  onFolderSelect,
  onTagToggle,
  onFolderCreate,
  onFolderRename,
  onFolderMove,
  onFolderDelete,
  onAssetsDropToFolder,
  onAssetsDropToProject,
  onAssetsDropToSet,
  sets,
  selectedSetId,
  onSetSelect,
  onOpenSetSuggestions,
  onImportScan,
  onOpenSettings,
  onOpenTrash,
  trashCount = 0,
  projects,
  selectedProjectId,
  onProjectSelect,
  onProjectCreate,
  selectedCategory,
  onCategorySelect,
  showFavoritesOnly,
  onFavoritesToggle,
}: SidebarProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [setsExpanded, setSetsExpanded] = useState(true);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [dragOverSetId, setDragOverSetId] = useState<string | null>(null);

  function handleSetDragOver(e: React.DragEvent, setId: string) {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dragOverSetId !== setId) setDragOverSetId(setId);
  }
  function handleSetDragLeave(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    setDragOverSetId(null);
  }
  function handleSetDrop(e: React.DragEvent, setId: string) {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    e.preventDefault();
    setDragOverSetId(null);
    try {
      const ids = JSON.parse(e.dataTransfer.getData(ASSET_DRAG_MIME)) as string[];
      if (Array.isArray(ids) && ids.length > 0) onAssetsDropToSet(ids, setId);
    } catch {/* ignore */}
  }

  function handleProjectDragOver(e: React.DragEvent, projectId: string) {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dragOverProjectId !== projectId) setDragOverProjectId(projectId);
  }
  function handleProjectDragLeave(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    setDragOverProjectId(null);
  }
  function handleProjectDrop(e: React.DragEvent, projectId: string) {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    e.preventDefault();
    setDragOverProjectId(null);
    try {
      const ids = JSON.parse(e.dataTransfer.getData(ASSET_DRAG_MIME)) as string[];
      if (Array.isArray(ids) && ids.length > 0) onAssetsDropToProject(ids, projectId);
    } catch {/* malformed payload — ignore */}
  }

  async function handleScan() {
    setScanning(true);
    setScanResult(null);
    try {
      const result = await api.import.scan();
      setScanResult(result);
      onImportScan();
    } catch {}
    setScanning(false);
  }

  // Collect all unique tags from assets
  const allTags = Array.from(new Set(assets.flatMap((a) => a.tags))).sort();

  return (
    <aside className="flex flex-col h-full bg-surface-2 border-r border-gray-200 dark:border-gray-700 w-56 flex-shrink-0">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-bold">TFV</span>
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-tight">TheFabricatorsVault</p>
            <p className="text-[10px] text-gray-400 italic leading-tight truncate">Light it up · Stick it on · Print it out</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-4">
        {/* Folders section */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1.5">Folders</p>
          <FolderTree
            folders={folders}
            selectedId={selectedFolderId}
            onSelect={onFolderSelect}
            onCreate={onFolderCreate}
            onRename={onFolderRename}
            onMove={onFolderMove}
            onAssetsDrop={onAssetsDropToFolder}
            onDelete={onFolderDelete}
          />
        </div>

        {/* Category Sections */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1.5">Categories</p>

          {/* Favorites */}
          <button
            onClick={onFavoritesToggle}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
              showFavoritesOnly
                ? 'bg-red-50 dark:bg-red-900/20 text-red-500 font-medium'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <Heart size={14} className="flex-shrink-0" fill={showFavoritesOnly ? 'currentColor' : 'none'} />
            <span>Favorites</span>
            <span className="ml-auto text-[10px] text-gray-400">
              {assetStats.favorites}
            </span>
          </button>

          {/* 3D Models */}
          <button
            onClick={() => onCategorySelect?.(selectedCategory === '3dmodel' ? null : '3dmodel')}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
              selectedCategory === '3dmodel'
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <Box size={14} className="flex-shrink-0" />
            <span>3D Models</span>
            <span className="ml-auto text-[10px] text-gray-400">
              {assetStats.threeDmodel}
            </span>
          </button>

          {/* 2D Designs */}
          <button
            onClick={() => onCategorySelect?.(selectedCategory === '2d' ? null : '2d')}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
              selectedCategory === '2d'
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <Zap size={14} className="flex-shrink-0" />
            <span>2D Designs</span>
            <span className="ml-auto text-[10px] text-gray-400">
              {assetStats.twoD}
            </span>
          </button>

          {/* Uncategorized */}
          <button
            onClick={() => onCategorySelect?.(selectedCategory === 'uncategorized' ? null : 'uncategorized')}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
              selectedCategory === 'uncategorized'
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <File size={14} className="flex-shrink-0" />
            <span>Uncategorized</span>
            <span className="ml-auto text-[10px] text-gray-400">
              {assetStats.uncategorized}
            </span>
          </button>
        </div>

        {/* Projects section */}
        {projects !== undefined && (
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <button
                onClick={() => setProjectsExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-600 dark:hover:text-gray-200"
              >
                {projectsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Projects
              </button>
              {onProjectCreate && (
                <button
                  onClick={onProjectCreate}
                  title="New project"
                  className="p-0.5 rounded text-gray-400 hover:text-accent hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <Plus size={13} />
                </button>
              )}
            </div>

            {projectsExpanded && (
              <div className="flex flex-col gap-0.5">
                {projects.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-gray-400 italic">No projects yet</p>
                ) : (
                  projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onProjectSelect?.(p.id)}
                      onDragOver={(e) => handleProjectDragOver(e, p.id)}
                      onDragLeave={handleProjectDragLeave}
                      onDrop={(e) => handleProjectDrop(e, p.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
                        dragOverProjectId === p.id
                          ? 'bg-accent/25 ring-2 ring-accent/60'
                          : selectedProjectId === p.id
                            ? 'bg-accent/10 text-accent font-medium'
                            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                    >
                      <Layers size={13} className="flex-shrink-0 text-gray-400" />
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto text-[10px] text-gray-400">{p.assetCount}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Sets section — lightweight grouping (no settings/overrides
            unlike Projects). Sidebar mirrors the Projects shape: a
            header with expand toggle + auto-detect button, then a
            list of set rows that accept asset drops. */}
        {sets !== undefined && (
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <button
                onClick={() => setSetsExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-600 dark:hover:text-gray-200"
              >
                {setsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Sets
              </button>
              {onOpenSetSuggestions && (
                <button
                  onClick={onOpenSetSuggestions}
                  title="Auto-detect sets from filenames"
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-accent"
                >
                  <Sparkles size={12} />
                </button>
              )}
            </div>

            {setsExpanded && (
              <div className="flex flex-col gap-0.5">
                {sets.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-gray-400 italic">No sets yet</p>
                ) : (
                  sets.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onSetSelect?.(s.id)}
                      onDragOver={(e) => handleSetDragOver(e, s.id)}
                      onDragLeave={handleSetDragLeave}
                      onDrop={(e) => handleSetDrop(e, s.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
                        dragOverSetId === s.id
                          ? 'bg-accent/25 ring-2 ring-accent/60'
                          : selectedSetId === s.id
                            ? 'bg-accent/10 text-accent font-medium'
                            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                    >
                      {s.coverThumbUrl ? (
                        <img src={s.coverThumbUrl} alt="" className="w-4 h-4 rounded object-cover flex-shrink-0" />
                      ) : (
                        <Sparkles size={13} className="flex-shrink-0 text-gray-400" />
                      )}
                      <span className="truncate">{s.name}</span>
                      <span className="ml-auto text-[10px] text-gray-400">{s.assetCount}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Tags section */}
        {allTags.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-2 mb-1.5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tags</p>
              {selectedTags.length > 0 && (
                <button
                  onClick={() => selectedTags.forEach(onTagToggle)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 px-2">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => onTagToggle(tag)}
                  className={`transition-opacity ${selectedTags.includes(tag) ? 'ring-2 ring-accent/50 ring-offset-1' : 'opacity-80 hover:opacity-100'}`}
                >
                  <TagBadge tag={tag} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div className="px-3 py-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
        {/* Vault totals */}
        <div className="px-3 py-1.5 text-[11px] text-gray-500 dark:text-gray-400 flex items-center justify-between">
          <span>{assetStats.total.toLocaleString()} files</span>
          <span>{formatVaultSize(assetStats.totalSize)}</span>
        </div>

        {/* Folder download */}
        {selectedFolderId && (
          <a
            href={api.folders.downloadUrl(selectedFolderId)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <Download size={14} /> Download folder
          </a>
        )}

        {/* Trash */}
        <button
          onClick={onOpenTrash}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <Trash2 size={14} />
          Trash
          {trashCount > 0 && (
            <span className="ml-auto text-[10px] bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 rounded-full px-1.5 py-0.5 leading-none">
              {trashCount}
            </span>
          )}
        </button>

        {/* Network / Admin settings */}
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <Settings size={14} />
          Settings
        </button>

        {/* Build version — confirms which deploy you're looking at. Set
            at build time in vite.config.ts. Hover for build timestamp. */}
        <div
          className="px-3 pt-1 text-center text-[10px] font-mono text-gray-400 dark:text-gray-500 select-text"
          title={`Built ${import.meta.env.VITE_BUILD_TIME ?? 'unknown'}`}
        >
          {import.meta.env.VITE_GIT_SHA ?? 'dev'}
        </div>
      </div>
    </aside>
  );
}
