import { useState } from 'react';
import { ChevronRight, Plus, MoreHorizontal, Edit2, Trash2, FolderPlus, Boxes } from 'lucide-react';
import { Modal } from './Modal.js';
import { DeleteSubAssemblyConfirmModal } from './DeleteSubAssemblyConfirmModal.js';
import type { SubAssemblyOut, SubAssemblyPartOut } from '../types/index.js';

// Distinct MIME so this drag never gets picked up by FolderTree's own
// folder-drag handlers (or vice versa) if both happen to be open — same
// isolation pattern FolderTree already uses against GlobalDropZone.
const SUBASSEMBLY_DRAG_MIME = 'application/x-tfv-subassembly-id';

const byName = (a: SubAssemblyOut, b: SubAssemblyOut) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Walks up the tree to determine if `ancestorId` is an ancestor of
// `descendantId`. Ported verbatim from FolderTree.tsx's isAncestorOf — the
// same self-referential parent_id shape, same instant client-side cycle
// rejection (no drop-target highlight, no error message) before the
// server's authoritative check ever runs.
function isAncestorOf(all: SubAssemblyOut[], ancestorId: string, descendantId: string): boolean {
  if (ancestorId === descendantId) return true;
  const byId = new Map(all.map((s) => [s.id, s]));
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

interface Props {
  subAssemblies: SubAssemblyOut[];
  parts: SubAssemblyPartOut[];
  onClose: () => void;
  onCreate: (name: string, parentId?: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onMove: (id: string, parentId: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  // Ancestor ids (root to node, inclusive) to pre-expand when opened from a
  // specific node's "..." menu, so Aaron doesn't lose his place.
  initialExpanded?: string[];
}

export function OrganizeModeModal({
  subAssemblies, parts, onClose, onCreate, onRename, onMove, onDelete, initialExpanded,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(initialExpanded ?? []));
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubAssemblyOut | null>(null);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleMove(id: string, parentId: string | null) {
    try {
      await onMove(id, parentId);
    } catch (err) {
      console.error('[OrganizeModeModal] Move failed:', err);
      // A drag that visually looked accepted but silently did nothing
      // would be a genuine "did that work?" moment — surface the server's
      // authoritative rejection (client guard missed something, or a
      // stale drag) as a transient message (Reid's UX spec, 4.11).
      setError(err instanceof Error ? err.message : "Couldn't move sub-assembly");
      setTimeout(() => setError(null), 4000);
    }
  }

  const rootNodes = subAssemblies.filter((s) => !s.parentId).sort(byName);

  return (
    <Modal title="Organize sub-assemblies" onClose={onClose} wide>
      <div className="flex flex-col gap-2">
        {error && (
          <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <TopLevelDropTarget subAssemblies={subAssemblies} onMove={handleMove} />

        <div className="space-y-0.5 max-h-[55vh] overflow-y-auto">
          {rootNodes.length === 0 ? (
            <p className="text-sm text-gray-400 italic px-2 py-4">No sub-assemblies yet.</p>
          ) : (
            rootNodes.map((sa) => (
              <SubAssemblyTreeItem
                key={sa.id}
                node={sa}
                allNodes={subAssemblies}
                depth={0}
                expanded={expanded}
                onToggleExpanded={toggleExpanded}
                onCreate={onCreate}
                onRename={onRename}
                onMove={handleMove}
                onRequestDelete={setDeleteTarget}
              />
            ))
          )}
        </div>

        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <NewRootInput onCreate={onCreate} />
        </div>
      </div>

      {deleteTarget && (
        <DeleteSubAssemblyConfirmModal
          target={deleteTarget}
          allNodes={subAssemblies}
          allParts={parts}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => { await onDelete(deleteTarget.id); setDeleteTarget(null); }}
        />
      )}
    </Modal>
  );
}

// Mirrors FolderTree's "All Files" root drop target — dropping a
// sub-assembly here un-parents it (sets parentId to null).
function TopLevelDropTarget({
  subAssemblies, onMove,
}: { subAssemblies: SubAssemblyOut[]; onMove: (id: string, parentId: string | null) => void }) {
  const [dragOver, setDragOver] = useState(false);

  function isAccepted(e: React.DragEvent) { return e.dataTransfer.types.includes(SUBASSEMBLY_DRAG_MIME); }

  return (
    <div
      onDragOver={(e) => {
        if (!isAccepted(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => { if (!isAccepted(e)) return; setDragOver(false); }}
      onDrop={(e) => {
        if (!isAccepted(e)) return;
        e.preventDefault();
        setDragOver(false);
        const draggedId = e.dataTransfer.getData(SUBASSEMBLY_DRAG_MIME);
        if (!draggedId) return;
        const dragged = subAssemblies.find((s) => s.id === draggedId);
        if (!dragged || dragged.parentId === null) return;
        onMove(draggedId, null);
      }}
      className={`px-3 py-2 rounded-lg text-xs font-medium border border-dashed transition-colors ${
        dragOver
          ? 'bg-accent/25 ring-2 ring-accent/60 border-accent text-accent'
          : 'border-gray-300 dark:border-gray-600 text-gray-400'
      }`}
    >
      Top level — drop here to un-parent
    </div>
  );
}

function NewRootInput({ onCreate }: { onCreate: (name: string, parentId?: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  async function submit() {
    const trimmed = name.trim();
    setAdding(false);
    if (trimmed) await onCreate(trimmed);
    setName('');
  }

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
      >
        <Plus size={14} /> New top-level sub-assembly
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAdding(false); setName(''); } }}
      onBlur={submit}
      placeholder="Sub-assembly name..."
      className="w-full text-sm bg-white dark:bg-gray-700 border border-accent rounded px-2 py-1.5 outline-none text-gray-900 dark:text-gray-100"
    />
  );
}

interface TreeItemProps {
  node: SubAssemblyOut;
  allNodes: SubAssemblyOut[];
  depth: number;
  expanded: Set<string>;
  onToggleExpanded: (id: string) => void;
  onCreate: (name: string, parentId?: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onMove: (id: string, parentId: string | null) => void;
  onRequestDelete: (node: SubAssemblyOut) => void;
}

// Organize Mode shows structure only — name, child count via nesting, drag
// handles. No quantity/printed-count here; that's Build Mode's job (Reid's
// UX spec, section 5).
function SubAssemblyTreeItem({
  node, allNodes, depth, expanded, onToggleExpanded, onCreate, onRename, onMove, onRequestDelete,
}: TreeItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(node.name);
  const [addingChild, setAddingChild] = useState(false);
  const [newChildName, setNewChildName] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const children = allNodes.filter((n) => n.parentId === node.id).sort(byName);
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(node.id);

  function handleDragStart(e: React.DragEvent) {
    e.stopPropagation();
    e.dataTransfer.setData(SUBASSEMBLY_DRAG_MIME, node.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function isAccepted(e: React.DragEvent) { return e.dataTransfer.types.includes(SUBASSEMBLY_DRAG_MIME); }

  function handleDragOver(e: React.DragEvent) {
    if (!isAccepted(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) setDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    if (!isAccepted(e)) return;
    setDragOver(false);
  }
  function handleDrop(e: React.DragEvent) {
    if (!isAccepted(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const draggedId = e.dataTransfer.getData(SUBASSEMBLY_DRAG_MIME);
    if (!draggedId || draggedId === node.id) return;
    // Client-side cycle guard — instant rejection, no drop-target
    // highlight in the first place, no error message needed (the server's
    // validateReparent is the authoritative backstop for anything this
    // client check somehow misses).
    if (node.parentId === draggedId || isAncestorOf(allNodes, draggedId, node.id)) return;
    onMove(draggedId, node.id);
    if (!expanded.has(node.id)) onToggleExpanded(node.id); // reveal the moved node in place
  }

  async function handleRename() {
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== node.name) await onRename(node.id, trimmed);
    setEditing(false);
  }

  async function handleAddChild() {
    const trimmed = newChildName.trim();
    setAddingChild(false);
    if (trimmed) {
      await onCreate(trimmed, node.id);
      if (!expanded.has(node.id)) onToggleExpanded(node.id);
    }
    setNewChildName('');
  }

  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`group relative flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm transition-colors ${
          dragOver
            ? 'bg-accent/25 ring-2 ring-accent/60'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-200'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <button
          onClick={() => onToggleExpanded(node.id)}
          className={`transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''} ${!hasChildren ? 'opacity-0 pointer-events-none' : ''}`}
        >
          <ChevronRight size={14} />
        </button>

        <Boxes size={14} className="flex-shrink-0 text-accent" />

        {editing ? (
          <input
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setEditing(false); setEditVal(node.name); }
            }}
            onBlur={handleRename}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-xs bg-white dark:bg-gray-700 border border-accent rounded px-1 outline-none text-gray-900 dark:text-gray-100"
          />
        ) : (
          <span className="flex-1 truncate text-xs font-medium">{node.name}</span>
        )}

        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => setAddingChild(true)} title="Add child" className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500">
            <FolderPlus size={12} />
          </button>
          <button onClick={() => setMenuOpen((v) => !v)} className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500">
            <MoreHorizontal size={12} />
          </button>
        </div>

        {menuOpen && (
          <div
            className="absolute right-2 top-8 z-30 w-40 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 text-sm animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { setEditing(true); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              <Edit2 size={12} /> Rename
            </button>
            <button
              onClick={() => { onRequestDelete(node); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}
      </div>

      {addingChild && (
        <div style={{ paddingLeft: `${8 + (depth + 1) * 16 + 14}px` }} className="pr-2 py-1">
          <input
            value={newChildName}
            onChange={(e) => setNewChildName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddChild(); if (e.key === 'Escape') { setAddingChild(false); setNewChildName(''); } }}
            onBlur={handleAddChild}
            autoFocus
            placeholder="Sub-assembly name..."
            className="w-full text-xs bg-white dark:bg-gray-700 border border-accent rounded px-2 py-1 outline-none text-gray-900 dark:text-gray-100"
          />
        </div>
      )}

      {isExpanded && children.map((child) => (
        <SubAssemblyTreeItem
          key={child.id}
          node={child}
          allNodes={allNodes}
          depth={depth + 1}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
          onCreate={onCreate}
          onRename={onRename}
          onMove={onMove}
          onRequestDelete={onRequestDelete}
        />
      ))}
    </div>
  );
}
