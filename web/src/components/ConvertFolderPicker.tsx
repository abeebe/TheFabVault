import { useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, CheckCircle } from 'lucide-react';
import type { FolderOut } from '../types/index.js';

// Single-select folder tree for the convert wizard (#2175 rework).
// Deliberately NOT FolderTree.tsx (the sidebar's CRUD/drag-drop tree) —
// this picker has a completely different job: pick ONE anchor folder to
// convert, nothing else. No rename/delete/create/drag-drop affordances
// belong here; reusing that component would mean stripping all of that
// back out, which is more code than writing this from scratch.
//
// Aaron's spec (#2175): bare-GUID-named LEAF folders are never pickable
// rows — the recursive backend already pulls their contents into
// whichever named ancestor gets converted, so surfacing 1,678 GUID rows
// in the pick list would just recreate the exact "useless" flat-list
// complaint this rework exists to fix.
//
// #2175 fold-in (Kit's review finding): the first version of this file
// hid EVERY bare-GUID folder outright, including non-leaf ones — a
// bare-GUID folder that itself CONTAINS named descendants never
// rendered at all, so nothing under it (however deep) could ever be
// reached or selected. That's not the "leaf" Aaron's spec means to
// hide. Fix, decided over the alternative (hoisting a bare-GUID
// folder's named descendants up to render as if they were direct
// children of the nearest named ancestor): render such a folder as a
// non-pickable PASS-THROUGH node — still visible, still expandable, its
// own name replaced with a muted "(unnamed folder)" label so it doesn't
// reintroduce GUID clutter, but clicking it toggles expand instead of
// selecting it (selectedId can never equal its id, so it's never
// pickable as an anchor). Chosen over hoisting because it's the more
// obvious implementation: the tree you see always matches the real
// parent/child structure one level at a time, with no separate
// "flatten past N bare-GUID hops to find the next named layer"
// traversal to get right and keep right as folders move around — it's
// also more honest about what's actually there (a real intermediate
// folder exists, it's just unnamed) rather than silently pretending it
// doesn't. A bare-GUID folder with NO named descendant anywhere in its
// own subtree is still hidden entirely, exactly as before — that IS the
// actual "leaf" case Aaron's spec means, and hiding it is still correct
// (nothing reachable through it is ever pickable, so showing it would
// just be clutter with a dead end at the bottom).
const byName = (a: FolderOut, b: FolderOut) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

interface ConvertFolderPickerProps {
  folders: FolderOut[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  // folderId -> models already converted from it (sourceFolderId), same
  // client-side-built map ConvertWizardPage already had pre-#2175 —
  // still useful here as a "you've been here before" signal while
  // browsing, independent of the review step's own alreadyConverted
  // check on the specific selected folder/children.
  convertedByFolder: Map<string, Array<{ id: string; title: string }>>;
}

// Sentinel key for the root level in childrenByParent — folder ids are
// real UUIDs, so this can never collide with one.
const ROOT_KEY = '__root__';

function buildChildrenByParent(folders: FolderOut[]): Map<string, FolderOut[]> {
  const map = new Map<string, FolderOut[]>();
  for (const f of folders) {
    const key = f.parentId ?? ROOT_KEY;
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return map;
}

// For every folder, does its subtree contain at least one named (non-
// bare-GUID) folder anywhere below it? Memoized single pass over the
// whole tree, cycle-guarded the same "in-progress" way FolderTree.tsx's
// isAncestorOf guards its own walk with a `seen` set — folders.parent_id
// is server-guarded against cycles (routes/folders.ts's PATCH walk-up
// check), but this renders off whatever the client was handed, so it
// shouldn't be able to hang on malformed data either.
function computeHasNamedDescendant(childrenByParent: Map<string, FolderOut[]>): Map<string, boolean> {
  const memo = new Map<string, boolean>();
  const inProgress = new Set<string>();

  function resolve(folderId: string): boolean {
    if (memo.has(folderId)) return memo.get(folderId)!;
    if (inProgress.has(folderId)) return false; // cycle guard — treat as a dead end, don't hang
    inProgress.add(folderId);
    const children = childrenByParent.get(folderId) ?? [];
    const result = children.some((c) => !c.isBareGuid || resolve(c.id));
    inProgress.delete(folderId);
    memo.set(folderId, result);
    return result;
  }

  for (const child of childrenByParent.values()) {
    for (const folder of child) resolve(folder.id);
  }
  return memo;
}

// The actual "hide" rule: a child is rendered unless it's a bare-GUID
// folder with no named descendant anywhere in its own subtree.
function visibleChildren(
  childrenByParent: Map<string, FolderOut[]>,
  parentKey: string,
  hasNamedDescendant: Map<string, boolean>,
): FolderOut[] {
  const all = childrenByParent.get(parentKey) ?? [];
  return all.filter((f) => !f.isBareGuid || hasNamedDescendant.get(f.id)).sort(byName);
}

interface NodeProps {
  folder: FolderOut;
  depth: number;
  childrenByParent: Map<string, FolderOut[]>;
  hasNamedDescendant: Map<string, boolean>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  convertedByFolder: Map<string, Array<{ id: string; title: string }>>;
}

function Node({
  folder, depth, childrenByParent, hasNamedDescendant, selectedId, onSelect, convertedByFolder,
}: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  // Pass-through container (see file header): a bare-GUID folder is
  // never pickable, even when it's rendered (because it has a named
  // descendant worth reaching).
  const pickable = !folder.isBareGuid;

  const children = visibleChildren(childrenByParent, folder.id, hasNamedDescendant);
  const hasChildren = children.length > 0;
  const isSelected = pickable && selectedId === folder.id;
  const converted = pickable ? (convertedByFolder.get(folder.id) ?? []) : [];

  function handleRowClick() {
    if (pickable) onSelect(folder.id);
    else setExpanded((v) => !v); // pass-through row: a click just drills in, never selects
  }

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${
          !pickable
            ? 'italic text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700/30'
            : isSelected
              ? 'bg-accent/15 text-accent'
              : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-200'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleRowClick}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className={`transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''} ${!hasChildren ? 'opacity-0 pointer-events-none' : ''}`}
        >
          <ChevronRight size={14} />
        </button>

        {expanded || isSelected
          ? <FolderOpen size={15} className="flex-shrink-0 text-yellow-500" />
          : <Folder size={15} className="flex-shrink-0 text-yellow-500" />}

        <span className="flex-1 truncate text-xs font-medium">
          {pickable ? folder.name : '(unnamed folder)'}
        </span>

        {converted.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full flex-shrink-0">
            <CheckCircle size={10} />
            Converted{converted.length > 1 ? ` (${converted.length}×)` : ''}
          </span>
        )}
      </div>

      {expanded && children.map((child) => (
        <Node
          key={child.id}
          folder={child}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          hasNamedDescendant={hasNamedDescendant}
          selectedId={selectedId}
          onSelect={onSelect}
          convertedByFolder={convertedByFolder}
        />
      ))}
    </div>
  );
}

export function ConvertFolderPicker({ folders, selectedId, onSelect, convertedByFolder }: ConvertFolderPickerProps) {
  const childrenByParent = useMemo(() => buildChildrenByParent(folders), [folders]);
  const hasNamedDescendant = useMemo(() => computeHasNamedDescendant(childrenByParent), [childrenByParent]);
  const roots = visibleChildren(childrenByParent, ROOT_KEY, hasNamedDescendant);

  if (roots.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
        No named folders in the vault yet.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-1">
      {roots.map((folder) => (
        <Node
          key={folder.id}
          folder={folder}
          depth={0}
          childrenByParent={childrenByParent}
          hasNamedDescendant={hasNamedDescendant}
          selectedId={selectedId}
          onSelect={onSelect}
          convertedByFolder={convertedByFolder}
        />
      ))}
    </div>
  );
}
