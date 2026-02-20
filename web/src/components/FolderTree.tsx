import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Plus, MoreHorizontal, Edit2, Trash2, FolderPlus } from 'lucide-react';
import type { FolderOut } from '../types/index.js';

interface FolderTreeProps {
  folders: FolderOut[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string, parentId?: string) => void;
  onRename: (id: string, name: string) => void;
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
  onDelete: (id: string) => void;
}

function FolderItem({
  folder, children, allFolders, depth, selectedId, onSelect, onCreate, onRename, onDelete,
}: FolderItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(folder.name);
  const [addingChild, setAddingChild] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const isSelected = selectedId === folder.id;
  const hasChildren = children.length > 0;

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
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${
          isSelected
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

      {/* Children */}
      {expanded && children.map((child) => (
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
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

export function FolderTree({ folders, selectedId, onSelect, onCreate, onRename, onDelete }: FolderTreeProps) {
  const [addingRoot, setAddingRoot] = useState(false);
  const [newName, setNewName] = useState('');

  const rootFolders = folders.filter((f) => !f.parentId);

  function handleAddRoot() {
    const trimmed = newName.trim();
    if (trimmed) onCreate(trimmed);
    setAddingRoot(false);
    setNewName('');
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* All Files */}
      <button
        onClick={() => onSelect(null)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
          selectedId === null
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
