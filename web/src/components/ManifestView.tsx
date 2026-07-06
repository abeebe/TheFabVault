import { useState } from 'react';
import {
  ChevronRight, Plus, MoreHorizontal, Trash2, Edit2, ListChecks, LayoutList,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { SubAssemblyCard } from './SubAssemblyCard.js';
import { PartRow } from './PartRow.js';
import { AssetPicker } from './AssetPicker.js';
import { OrganizeModeModal } from './OrganizeModeModal.js';
import { PrintNextModal } from './PrintNextModal.js';
import { DeleteSubAssemblyConfirmModal } from './DeleteSubAssemblyConfirmModal.js';
import { AssetOverridesModal } from './AssetOverridesModal.js';
import { ModelViewer } from './ModelViewer.js';
import { Spinner } from './Spinner.js';
import type {
  ProjectDetailOut, SubAssemblyOut, SubAssemblyPartOut, AssetOut, ManifestOut,
} from '../types/index.js';

type SortMode = 'manual' | 'incomplete';

interface Props {
  project: ProjectDetailOut;
  // Owned by ProjectView (one fetch shared by both the Manifest and
  // Ungrouped tabs — the Ungrouped tab's "Add to sub-assembly" picker
  // needs the sub-assemblies list too, so the whole-tree fetch lives one
  // level up rather than being refetched per tab switch).
  manifest: ManifestOut | null;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  // Lets ProjectView refresh the project header (percent-printed,
  // ungrouped count) and the sidebar's per-project percent badge whenever
  // the manifest changes underneath this view.
  onManifestChanged: () => void;
}

// Build Mode: breadcrumb drill-down that never renders more than one
// node's neighborhood at a time (Reid's UX spec, section 5 — this is the
// mechanism that keeps a 500-part tree navigable; the working set is
// always "one node's neighborhood," never the whole tree). The whole
// manifest is fetched once (by ProjectView); every drill-down below is
// pure client-side state against that already-loaded flat data.
export function ManifestView({ project, manifest, loading, error, refresh, onManifestChanged }: Props) {
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [breadcrumbPath, setBreadcrumbPath] = useState<string[]>([]); // ancestor ids, root -> current
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try {
      return (localStorage.getItem(`tfv-manifest-sort-${project.id}`) as SortMode) || 'manual';
    } catch {
      return 'manual';
    }
  });
  const [previewAsset, setPreviewAsset] = useState<AssetOut | null>(null);
  const [overridesPart, setOverridesPart] = useState<SubAssemblyPartOut | null>(null);
  const [addPartsOpen, setAddPartsOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [printNextOpen, setPrintNextOpen] = useState(false);
  const [editingNodeName, setEditingNodeName] = useState(false);
  const [nodeNameVal, setNodeNameVal] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SubAssemblyOut | null>(null);

  function persistSortMode(mode: SortMode) {
    setSortMode(mode);
    try { localStorage.setItem(`tfv-manifest-sort-${project.id}`, mode); } catch { /* ignore */ }
  }

  async function notifyChanged() {
    await refresh();
    onManifestChanged();
  }

  // Same family as the ProjectView fix (see its comment): `loading` from
  // useManifest also flips true on every background refetch (every edit's
  // notifyChanged -> refresh()), and blanking this whole view to a
  // spinner on each one is the identical "loading masks a state-bearing
  // subtree" bug, just for the manifest fetch instead of the project
  // fetch. `!manifest` alone still covers the real first-load case:
  // useManifest is only ever consumed here (verified), manifest starts
  // null, and the mount effect's refresh() doesn't populate it before
  // this first render runs.
  if (!manifest) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  // A silently-empty manifest would be indistinguishable from "Aaron's
  // tracked progress just vanished" — a visible retry beats a quiet
  // fallback here (Reid's UX spec, section 6).
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400">
        <p className="text-sm">Couldn&apos;t load the build manifest.</p>
        <button onClick={refresh} className="text-sm text-accent hover:text-accent-hover">Retry</button>
      </div>
    );
  }

  const { subAssemblies, parts } = manifest;
  const currentNode = currentNodeId ? subAssemblies.find((s) => s.id === currentNodeId) ?? null : null;
  const childrenOfCurrent = subAssemblies.filter((s) => (currentNodeId ? s.parentId === currentNodeId : !s.parentId));
  const directParts = currentNodeId ? parts.filter((p) => p.subAssemblyId === currentNodeId) : [];

  function sortNodes(nodes: SubAssemblyOut[]): SubAssemblyOut[] {
    const bySortOrder = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    if (sortMode !== 'incomplete') return bySortOrder;
    return bySortOrder.sort((a, b) => {
      const aDone = a.rollup.percent === 100;
      const bDone = b.rollup.percent === 100;
      if (aDone === bDone) return 0;
      return aDone ? 1 : -1;
    });
  }

  function drillInto(node: SubAssemblyOut) {
    setCurrentNodeId(node.id);
    setBreadcrumbPath((prev) => [...prev, node.id]);
  }

  function jumpToRoot() {
    setCurrentNodeId(null);
    setBreadcrumbPath([]);
  }

  function jumpToAncestor(id: string) {
    const idx = breadcrumbPath.indexOf(id);
    if (idx === -1) return;
    setBreadcrumbPath(breadcrumbPath.slice(0, idx + 1));
    setCurrentNodeId(id);
  }

  async function handleCreateSubAssembly(name: string, parentId?: string) {
    await api.manifest.createSubAssembly(project.id, { name, parentId });
    await notifyChanged();
  }

  async function handleRenameSubAssembly(id: string, name: string) {
    await api.manifest.updateSubAssembly(id, { name });
    await notifyChanged();
  }

  async function handleMoveSubAssembly(id: string, parentId: string | null) {
    await api.manifest.updateSubAssembly(id, { parentId });
    await notifyChanged();
  }

  async function handleDeleteSubAssembly(id: string) {
    await api.manifest.deleteSubAssembly(id);
    // If we deleted the node we're drilled into (or an ancestor of it, via
    // Organize Mode), back out to the deepest still-existing ancestor
    // instead of pointing Build Mode at a node that no longer exists.
    if (currentNodeId === id || breadcrumbPath.includes(id)) {
      const idx = breadcrumbPath.indexOf(id);
      if (idx <= 0) {
        jumpToRoot();
      } else {
        setBreadcrumbPath(breadcrumbPath.slice(0, idx));
        setCurrentNodeId(breadcrumbPath[idx - 1]);
      }
    }
    await notifyChanged();
  }

  async function handlePartRemoved(subAssemblyId: string, assetId: string) {
    await api.manifest.removePart(subAssemblyId, assetId);
    await notifyChanged();
  }

  async function saveNodeName() {
    if (!currentNode || !nodeNameVal.trim()) { setEditingNodeName(false); return; }
    await handleRenameSubAssembly(currentNode.id, nodeNameVal.trim());
    setEditingNodeName(false);
  }

  const headerPct = currentNode ? currentNode.rollup.percent : manifest.projectRollup.percent;
  const headerDone = currentNode ? currentNode.rollup.done : manifest.projectRollup.done;
  const headerNeeded = currentNode ? currentNode.rollup.needed : manifest.projectRollup.needed;

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb bar — depth is shown as a flat, clickable path of
          names, never as cascading indentation. That's the specific
          mechanism that keeps drill-down navigable at any depth (Reid's
          UX spec, 4.5). */}
      <div className="px-5 py-2 flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0 flex-wrap">
        <button
          onClick={jumpToRoot}
          className={`hover:text-gray-700 dark:hover:text-gray-200 ${!currentNode ? 'text-gray-900 dark:text-gray-100 font-medium' : ''}`}
        >
          {project.name}
        </button>
        {breadcrumbPath.map((id, i) => {
          const node = subAssemblies.find((s) => s.id === id);
          if (!node) return null;
          const isLast = i === breadcrumbPath.length - 1;
          return (
            <span key={id} className="flex items-center gap-1.5">
              <ChevronRight size={12} className="text-gray-300 dark:text-gray-600" />
              <button
                onClick={() => jumpToAncestor(id)}
                className={`hover:text-gray-700 dark:hover:text-gray-200 ${isLast ? 'text-gray-900 dark:text-gray-100 font-medium' : ''}`}
              >
                {node.name}
              </button>
            </span>
          );
        })}
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={() => persistSortMode('manual')}
            className={`px-2 py-1 rounded ${sortMode === 'manual' ? 'bg-accent/10 text-accent font-medium' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
          >
            Manual order
          </button>
          <button
            onClick={() => persistSortMode('incomplete')}
            className={`px-2 py-1 rounded ${sortMode === 'incomplete' ? 'bg-accent/10 text-accent font-medium' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
          >
            Incomplete first
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Current node header — only when drilled in; the project root
            has nowhere to go "back" to, so no header block is needed
            there beyond the card grid itself (Reid's UX spec, 4.4). */}
        {currentNode && (
          <div className="mb-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                {editingNodeName ? (
                  <input
                    autoFocus
                    className="text-lg font-bold bg-transparent border-b border-accent outline-none text-gray-900 dark:text-gray-100"
                    value={nodeNameVal}
                    onChange={(e) => setNodeNameVal(e.target.value)}
                    onBlur={saveNodeName}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveNodeName(); if (e.key === 'Escape') setEditingNodeName(false); }}
                  />
                ) : (
                  <h3
                    className="text-lg font-bold text-gray-900 dark:text-gray-100 cursor-pointer hover:text-accent flex items-center gap-2 group"
                    onClick={() => { setNodeNameVal(currentNode.name); setEditingNodeName(true); }}
                  >
                    {currentNode.name}
                    <Edit2 size={13} className="opacity-0 group-hover:opacity-100 text-gray-400" />
                  </h3>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {headerPct === null ? 'No parts placed yet' : `${headerDone}/${headerNeeded} printed`}
                </p>
                {headerPct !== null && (
                  <div className="mt-1.5 h-1.5 w-48 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, headerPct)}%` }} />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setAddPartsOpen(true)}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  + Add parts
                </button>
                <button
                  onClick={() => setPrintNextOpen(true)}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <ListChecks size={13} /> Print this next
                </button>
                <NodeMenu
                  onRename={() => { setNodeNameVal(currentNode.name); setEditingNodeName(true); }}
                  onOrganize={() => setOrganizeOpen(true)}
                  onDelete={() => setDeleteTarget(currentNode)}
                />
              </div>
            </div>
          </div>
        )}

        {!currentNode && (
          <div className="flex items-center justify-end mb-3">
            <button onClick={() => setOrganizeOpen(true)} className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent">
              <LayoutList size={13} /> Organize...
            </button>
          </div>
        )}

        {/* Child sub-assembly cards — each showing its own mini progress
            bar, so "Right Foot 18/18, Left Foot 4/18" is visible before
            drilling further (Reid's UX spec, 4.4-4.5). */}
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {sortNodes(childrenOfCurrent).map((sa) => (
            <SubAssemblyCard
              key={sa.id}
              subAssembly={sa}
              childCount={subAssemblies.filter((s) => s.parentId === sa.id).length}
              onClick={() => drillInto(sa)}
            />
          ))}
          <AddSubAssemblyTile onCreate={(name) => handleCreateSubAssembly(name, currentNodeId ?? undefined)} />
        </div>

        {/* Direct part rows for the current node */}
        {currentNode && (
          <>
            {directParts.length === 0 && childrenOfCurrent.length > 0 && (
              <p className="text-xs text-gray-400 italic mb-2">No parts placed directly in {currentNode.name}</p>
            )}
            {directParts.length === 0 && childrenOfCurrent.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                <p className="text-sm mb-3">Nothing here yet.</p>
                <button onClick={() => setAddPartsOpen(true)} className="text-sm text-accent hover:text-accent-hover">
                  + Add parts
                </button>
              </div>
            )}
            {directParts.length > 0 && (
              <div className="space-y-0.5">
                {directParts.map((part) => (
                  <PartRow
                    key={part.asset.id}
                    part={part}
                    onUpdated={() => notifyChanged()}
                    onRemoved={() => handlePartRemoved(part.subAssemblyId, part.asset.id)}
                    onEditOverrides={() => setOverridesPart(part)}
                    onPreview={() => setPreviewAsset(part.asset)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {previewAsset && (
        <ModelViewer
          asset={previewAsset}
          onClose={() => setPreviewAsset(null)}
          onUpdate={(updated) => setPreviewAsset(updated)}
        />
      )}

      {overridesPart && (
        <AssetOverridesModal
          project={project}
          asset={{ ...overridesPart.asset, overrides: overridesPart.overrides }}
          onSave={async (overrides) => {
            await api.manifest.updatePartOverrides(overridesPart.subAssemblyId, overridesPart.asset.id, overrides);
            await notifyChanged();
          }}
          onClose={() => setOverridesPart(null)}
        />
      )}

      {addPartsOpen && currentNode && (
        <AssetPicker
          title={`Add parts to ${currentNode.name}`}
          // Scoped to directParts (this node only), NOT project-wide. This
          // is deliberate, not an oversight: a literal reading of Reid's UX
          // spec 4.9 ("exclude assets already in the manifest") would hide
          // an asset project-wide once placed anywhere, making it
          // impossible to place a shared part into a second sub-assembly —
          // that would violate Aaron's locked invariant that shared parts
          // are links, not exclusive placements (see the PRD boundary-rule
          // comment atop routes/subAssemblies.ts). The narrower, per-node
          // exclusion is what resolves that spec-vs-invariant contradiction
          // in favor of the invariant. Do not "correct" this back to a
          // project-wide filter.
          existingAssetIds={new Set(directParts.map((p) => p.asset.id))}
          onAdd={(ids) => api.manifest.addParts(currentNode.id, ids)}
          onDone={() => { setAddPartsOpen(false); notifyChanged(); }}
          onClose={() => setAddPartsOpen(false)}
        />
      )}

      {organizeOpen && (
        <OrganizeModeModal
          subAssemblies={subAssemblies}
          parts={parts}
          initialExpanded={breadcrumbPath}
          onClose={() => setOrganizeOpen(false)}
          onCreate={handleCreateSubAssembly}
          onRename={handleRenameSubAssembly}
          onMove={handleMoveSubAssembly}
          onDelete={handleDeleteSubAssembly}
        />
      )}

      {printNextOpen && currentNode && (
        <PrintNextModal
          rootNode={currentNode}
          allNodes={subAssemblies}
          allParts={parts}
          onClose={() => setPrintNextOpen(false)}
          onUpdatePart={() => notifyChanged()}
          onRemovePart={handlePartRemoved}
          onEditOverrides={(part) => setOverridesPart(part)}
          onPreview={(part) => setPreviewAsset(part.asset)}
        />
      )}

      {deleteTarget && (
        <DeleteSubAssemblyConfirmModal
          target={deleteTarget}
          allNodes={subAssemblies}
          allParts={parts}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => { await handleDeleteSubAssembly(deleteTarget.id); setDeleteTarget(null); }}
        />
      )}
    </div>
  );
}

function NodeMenu({ onRename, onOrganize, onDelete }: { onRename: () => void; onOrganize: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-20 w-40 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 text-sm animate-fade-in">
          <button onClick={() => { onRename(); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">
            <Edit2 size={13} /> Rename
          </button>
          <button onClick={() => { onOrganize(); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">
            <LayoutList size={13} /> Organize...
          </button>
          <button onClick={() => { onDelete(); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400">
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

// Always the last item in a child-card grid (root or drilled-in) — covers
// the common case of adding one more sibling without ever leaving Build
// Mode (Reid's UX spec, 4.8). Organize Mode exists for restructuring, not
// for this routine act.
function AddSubAssemblyTile({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
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
        className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 hover:border-accent hover:text-accent transition-colors p-3 gap-1 min-h-[92px]"
      >
        <Plus size={18} />
        <span className="text-xs">New sub-assembly</span>
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-accent p-3 flex items-center min-h-[92px]">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAdding(false); setName(''); } }}
        onBlur={submit}
        placeholder="Sub-assembly name..."
        className="w-full text-sm bg-transparent outline-none text-gray-900 dark:text-gray-100"
      />
    </div>
  );
}
