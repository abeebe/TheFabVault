import { useState } from 'react';
import { Settings, Download, File, X, Plus, Layers, ChevronDown, ChevronRight, Box, Zap, Trash2, Heart } from 'lucide-react';
import { FolderTree } from './FolderTree.js';
import { TagBadge } from './TagInput.js';
import { api } from '../lib/api.js';
import type { AssetOut, FolderOut, ProjectOut } from '../types/index.js';

type Category = '3dmodel' | '2d' | 'uncategorized';

function getAssetCategory(asset: AssetOut): Category {
  // Explicit DB override takes priority
  if (asset.category === '3dmodel') return '3dmodel';
  if (asset.category === '2d') return '2d';
  // Auto-detect from extension
  const ext = asset.filename.split('.').pop()?.toLowerCase();
  if (ext && ['.stl', '.obj', '.3mf'].includes(`.${ext}`)) return '3dmodel';
  if (ext && ['.svg', '.dxf'].includes(`.${ext}`)) return '2d';
  return 'uncategorized';
}

interface SidebarProps {
  folders: FolderOut[];
  assets: AssetOut[];
  selectedFolderId: string | null;
  selectedTags: string[];
  onFolderSelect: (id: string | null) => void;
  onTagToggle: (tag: string) => void;
  onFolderCreate: (name: string, parentId?: string) => void;
  onFolderRename: (id: string, name: string) => void;
  onFolderDelete: (id: string) => void;
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
  selectedFolderId,
  selectedTags,
  onFolderSelect,
  onTagToggle,
  onFolderCreate,
  onFolderRename,
  onFolderDelete,
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
              {assets.filter((a) => a.isFavorite).length}
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
              {assets.filter((a) => getAssetCategory(a) === '3dmodel').length}
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
              {assets.filter((a) => getAssetCategory(a) === '2d').length}
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
              {assets.filter((a) => getAssetCategory(a) === 'uncategorized').length}
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
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left ${
                        selectedProjectId === p.id
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
      </div>
    </aside>
  );
}
