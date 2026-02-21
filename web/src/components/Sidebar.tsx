import { useState } from 'react';
import { RefreshCw, Download, Tag, X, Plus, Layers, ChevronDown, ChevronRight } from 'lucide-react';
import { FolderTree } from './FolderTree.js';
import { TagBadge } from './TagInput.js';
import { api } from '../lib/api.js';
import type { AssetOut, FolderOut, ProjectOut } from '../types/index.js';

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
  // Projects
  projects?: ProjectOut[];
  selectedProjectId?: string | null;
  onProjectSelect?: (id: string) => void;
  onProjectCreate?: () => void;
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
  projects,
  selectedProjectId,
  onProjectSelect,
  onProjectCreate,
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

        {/* Mount import scan */}
        <button
          onClick={handleScan}
          disabled={scanning}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'Scanning...' : 'Scan NAS mount'}
        </button>

        {scanResult && (
          <p className="text-xs text-gray-400 px-3">
            {scanResult.imported} imported, {scanResult.skipped} skipped
          </p>
        )}
      </div>
    </aside>
  );
}
