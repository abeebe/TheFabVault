import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Plus, MoreHorizontal, Edit2, Trash2, FolderPlus } from 'lucide-react';
import type { FolderOut } from '../types/index.js';

// Custom MIME used for in-app folder drags. Distinct from 'Files' so
// GlobalDropZone (window-level file-drop overlay) ignores folder drags.
const FOLDER_DRAG_MIME = 'application/x-tfv-folder-id';
// Set by AssetCard during a card drag — payload is a JSON array of
// asset IDs (the dragged card alone, or the full multi-selection).
export const ASSET_DRAG_MIME = 'application/x-tfv-asset-ids';

const byName = (a: FolderOut, b: FolderOut) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

interface FolderTreeProps {
  folders: FolderOut[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string, parentId?: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  onAssetsDrop: (assetIds: string[], folderId: string | null) => void;
  onDelete: (id: string) => void;
}

interface FolderItemProps {
  folder: FolderOut;
  children: FolderOut[];
  allFolders: FolderOut[];
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string, parentId?: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  onAssetsDrop: (assetIds: string[], folderId: string | null) => void;
  onDelete: (id: string) => void;
}

// Walks up the folder tree to determine if `ancestorId` is an ancestor
// of `descendantId`. Used to reject drops that would create a cycle
// before sending the request — gives instant visual feedback (no
// drop-target highlight) instead of a server error.
function isAncestorOf(allFolders: FolderOut[], ancestorId: string, descendantId: string): boolean {
  if (ancestorId === descendantId) return true;
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  let cursor: string | null = byId.get(descendantId)?.parentId ?? null;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === ancestorId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

function FolderItem({
  folder, children, allFolders, depth, selectedId, onSelect, onCreate, onRename, onMove, onAssetsDrop, onDelete,
}: FolderItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(folder.name);
  const [addingChild, setAddingChild] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const isSelected = selectedId === folder.id;
  const hasChildren = children.length > 0;

  function handleDragStart(e: React.DragEvent) {
    e.stopPropagation();
    e.dataTransfer.setData(FOLDER_DRAG_MIME, folder.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function isAcceptedDrag(e: React.DragEvent): 'folder' | 'asset' | null {
    if (e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return 'folder';
    if (e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return 'asset';
    return null;
  }

  function handleDragOver(e: React.DragEvent) {
    // Only react to in-app folder/asset drags. File drops are handled
    // by GlobalDropZone at the App root.
    if (!isAcceptedDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!isAcceptedDrag(e)) return;
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    const kind = isAcceptedDrag(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    if (kind === 'folder') {
      const draggedId = e.dataTransfer.getData(FOLDER_DRAG_MIME);
      if (!draggedId || draggedId === folder.id) return;
      // No-op if already this folder's child, and reject cycles client-
      // side for instant feedback (server enforces too).
      if (folder.parentId === draggedId || isAncestorOf(allFolders, draggedId, folder.id)) return;
      onMove(draggedId, folder.id);
      setExpanded(true); // reveal the moved folder in place
    } else {
      try {
        const ids = JSON.parse(e.dataTransfer.getData(ASSET_DRAG_MIME)) as string[];
        if (Array.isArray(ids) && ids.length > 0) onAssetsDrop(ids, folder.id);
      } catch {/* malformed payload — ignore */}
    }
  }

  function handleRename() {
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== folder.name) onRename(folder.id, trimmed);
    setEditing(false);
  }

  function handleAddChild() {
    const trimmed = newFolderName.trim();
    if (trimmed) {
      onCreate(trimmed, folder.id);
      setExpanded(true);
    }
    setAddingChild(false);
    setNewFolderName('');
  }

  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${
          dragOver
            ? 'bg-accent/25 ring-2 ring-accent/60'
            : isSelected
              ? 'bg-accent/15 text-accent'
              : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-200'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => { onSelect(folder.id); if (hasChildren) setExpanded((v) => !v); }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className={`transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''} ${!hasChildren ? 'opacity-0 pointer-events-none' : ''}`}
        >
          <ChevronRight size={14} />
        </button>

        {expanded || isSelected
          ? <FolderOpen size={15} className="flex-shrink-0 text-yellow-500" />
          : <Folder size={15} className="flex-shrink-0 text-yellow-500" />
        }

        {editing ? (
          <input
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setEditing(false); setEditVal(folder.name); }
            }}
            onBlur={handleRename}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-xs bg-white dark:bg-gray-700 border border-accent rounded px-1 outline-none text-gray-900 dark:text-gray-100"
          />
        ) : (
          <span className="flex-1 truncate text-xs font-medium">{folder.name}</span>
        )}

        {/* Folder actions */}
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => setAddingChild(true)}
            title="Add subfolder"
            className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500"
          >
            <FolderPlus size={12} />
          </button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500"
          >
            <MoreHorizontal size={12} />
          </button>
        </div>

        {menuOpen && (
          <div
            className="absolute right-2 z-30 w-36 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 text-sm animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { setEditing(true); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              <Edit2 size={12} /> Rename
            </button>
            <button
              onClick={() => { onDelete(folder.id); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}
      </div>

      {/* New child folder input */}
      {addingChild && (
        <div style={{ paddingLeft: `${8 + (depth + 1) * 16 + 14}px` }} className="pr-2 py-1">
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddChild();
              if (e.key === 'Escape') { setAddingChild(false); setNewFolderName(''); }
            }}
            onBlur={handleAddChild}
            autoFocus
            placeholder="Folder name..."
            className="w-full text-xs bg-white dark:bg-gray-700 border border-accent rounded px-2 py-1 outline-none text-gray-900 dark:text-gray-100"
          />
        </div>
      )}

      {/* Children — sorted alphabetically */}
      {expanded && [...children].sort(byName).map((child) => (
        <FolderItem
          key={child.id}
          folder={child}
          children={allFolders.filter((f) => f.parentId === child.id)}
          allFolders={allFolders}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          onCreate={onCreate}
          onRename={onRename}
          onMove={onMove}
          onAssetsDrop={onAssetsDrop}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

export function FolderTree({ folders, selectedId, onSelect, onCreate, onRename, onMove, onAssetsDrop, onDelete }: FolderTreeProps) {
  const [addingRoot, setAddingRoot] = useState(false);
  const [newName, setNewName] = useState('');
  const [rootDragOver, setRootDragOver] = useState(false);

  const rootFolders = folders.filter((f) => !f.parentId).sort(byName);

  // "All Files" drop target — folder drop moves the dragged folder to
  // root; asset drop clears each asset's folder_id (moves to vault root).
  function rootDragKind(e: React.DragEvent): 'folder' | 'asset' | null {
    if (e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return 'folder';
    if (e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return 'asset';
    return null;
  }
  function handleRootDragOver(e: React.DragEvent) {
    if (!rootDragKind(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!rootDragOver) setRootDragOver(true);
  }
  function handleRootDragLeave(e: React.DragEvent) {
    if (!rootDragKind(e)) return;
    setRootDragOver(false);
  }
  function handleRootDrop(e: React.DragEvent) {
    const kind = rootDragKind(e);
    if (!kind) return;
    e.preventDefault();
    setRootDragOver(false);
    if (kind === 'folder') {
      const draggedId = e.dataTransfer.getData(FOLDER_DRAG_MIME);
      if (!draggedId) return;
      const dragged = folders.find((f) => f.id === draggedId);
      if (!dragged || dragged.parentId === null) return;
      onMove(draggedId, null);
    } else {
      try {
        const ids = JSON.parse(e.dataTransfer.getData(ASSET_DRAG_MIME)) as string[];
        if (Array.isArray(ids) && ids.length > 0) onAssetsDrop(ids, null);
      } catch {/* malformed payload — ignore */}
    }
  }

  function handleAddRoot() {
    const trimmed = newName.trim();
    if (trimmed) onCreate(trimmed);
    setAddingRoot(false);
    setNewName('');
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* All Files — also acts as a drop target to move folders to root. */}
      <button
        onClick={() => onSelect(null)}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
          rootDragOver
            ? 'bg-accent/25 ring-2 ring-accent/60'
            : selectedId === null
              ? 'bg-accent/15 text-accent font-medium'
              : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/50'
        }`}
      >
        <FolderOpen size={15} className="text-accent" />
        All Files
      </button>

      {/* Folder list */}
      <div className="relative">
        {rootFolders.map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            children={folders.filter((f) => f.parentId === folder.id)}
            allFolders={folders}
            depth={0}
            selectedId={selectedId}
            onSelect={onSelect}
            onCreate={onCreate}
            onRename={onRename}
            onMove={onMove}
            onAssetsDrop={onAssetsDrop}
            onDelete={onDelete}
          />
        ))}
      </div>

      {/* New root folder */}
      {addingRoot ? (
        <div className="px-2 py-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddRoot();
              if (e.key === 'Escape') { setAddingRoot(false); setNewName(''); }
            }}
            onBlur={handleAddRoot}
            autoFocus
            placeholder="Folder name..."
            className="w-full text-xs bg-white dark:bg-gray-700 border border-accent rounded px-2 py-1 outline-none text-gray-900 dark:text-gray-100"
          />
        </div>
      ) : (
        <button
          onClick={() => setAddingRoot(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
        >
          <Plus size={14} /> New folder
        </button>
      )}
    </div>
  );
}
