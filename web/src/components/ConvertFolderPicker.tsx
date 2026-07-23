import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen, CheckCircle } from 'lucide-react';
import type { FolderOut } from '../types/index.js';

// Single-select folder tree for the convert wizard (#2175 rework).
// Deliberately NOT FolderTree.tsx (the sidebar's CRUD/drag-drop tree) —
// this picker has a completely different job: pick ONE anchor folder to
// convert, nothing else. No rename/delete/create/drag-drop affordances
// belong here; reusing that component would mean stripping all of that
// back out, which is more code than writing the ~80 lines this needs
// from scratch.
//
// Aaron's spec (#2175): bare-GUID-named leaf folders are never pickable
// rows — the recursive backend already pulls their contents into
// whichever named ancestor gets converted, so surfacing 1,678 GUID rows
// in the pick list would just recreate the exact "useless" flat-list
// complaint this rework exists to fix. FolderOut.isBareGuid (server-
// computed, api/src/services/modelConvert.ts's isBareGuidName) is the
// single source of truth for that filter — never re-derive the GUID
// regex client-side, so this can never drift from Mode B's actual
// eligibility rule.
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

interface NodeProps extends ConvertFolderPickerProps {
  folder: FolderOut;
  depth: number;
}

function Node({ folder, depth, folders, selectedId, onSelect, convertedByFolder }: NodeProps) {
  const [expanded, setExpanded] = useState(false);

  // Bare-GUID children are filtered out here, not just at the root —
  // this is the actual "hide" mechanism: a bare-GUID folder never
  // appears as a node anywhere in the tree, at any depth, so there's
  // nothing to expand into and no row to accidentally select.
  const children = folders
    .filter((f) => f.parentId === folder.id && !f.isBareGuid)
    .sort(byName);
  const hasChildren = children.length > 0;
  const isSelected = selectedId === folder.id;
  const converted = convertedByFolder.get(folder.id) ?? [];

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${
          isSelected
            ? 'bg-accent/15 text-accent'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-200'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(folder.id)}
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

        <span className="flex-1 truncate text-xs font-medium">{folder.name}</span>

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
          folders={folders}
          selectedId={selectedId}
          onSelect={onSelect}
          convertedByFolder={convertedByFolder}
        />
      ))}
    </div>
  );
}

export function ConvertFolderPicker({ folders, selectedId, onSelect, convertedByFolder }: ConvertFolderPickerProps) {
  const roots = folders.filter((f) => f.parentId === null && !f.isBareGuid).sort(byName);

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
          folders={folders}
          selectedId={selectedId}
          onSelect={onSelect}
          convertedByFolder={convertedByFolder}
        />
      ))}
    </div>
  );
}
