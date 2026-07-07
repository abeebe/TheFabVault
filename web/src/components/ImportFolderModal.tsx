import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Boxes, FolderInput } from 'lucide-react';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { api } from '../lib/api.js';
import { sha256Hex } from '../lib/uploadStore.js';
import { deriveRelativeSegments, isJunkFile } from '../lib/pathSegments.js';
import { buildResolutions, type ScannedFile } from '../lib/importPlan.js';
import {
  buildPreviewTree, flattenTree, buildNodeIndex, pathKey, isExcluded, isIndeterminate, computeIncludedTotals,
  type PreviewNode,
} from '../lib/importPreviewTree.js';
import { startImport } from '../lib/importStore.js';
import type { SubAssemblyOut } from '../types/index.js';

// Folder-tree auto-import — Scan + Preview phases (Reid's UX spec,
// sections 6.1-6.2). Commit + Result are NOT rendered by this component —
// once "Start import" is clicked, this modal hands off to the persistent
// importStore and unmounts itself; <ImportPanel /> (mounted once at the
// App root, mirroring <UploadPanel />) owns the Commit/Result UI from
// then on, so progress survives navigation and this dialog closing
// (Reid's UX spec, section 8's architecture note).
//
// Nothing is written to the server during Scan/Preview — closing this
// modal at any point before "Start import" simply discards the in-
// progress scan, no cleanup needed.

const HASH_CONCURRENCY = 4;
const DEDUP_DETAIL_THRESHOLD_DEFAULT_OPEN = false;

interface Props {
  files: File[]; // raw FileList contents from the webkitdirectory input
  projectId: string;
  // null = project root, a sub-assembly id = launched from inside a
  // drilled-in node (Reid's UX spec, section 3's targetParentId).
  targetParentId: string | null;
  // "Ungrouped" at project root, or the drilled-in node's name — used by
  // the degenerate flat-import copy (section 6.2).
  targetLabel: string;
  existingSubAssemblies: SubAssemblyOut[];
  onClose: () => void;
}

type ScanPhase = 'scanning' | 'preview';

export function ImportFolderModal({ files, projectId, targetParentId, targetLabel, existingSubAssemblies, onClose }: Props) {
  const [phase, setPhase] = useState<ScanPhase>('scanning');
  const [hashedCount, setHashedCount] = useState(0);
  const [scanned, setScanned] = useState<ScannedFile[]>([]);
  const [flatFiles, setFlatFiles] = useState<ScannedFile[]>([]); // segments === []
  const [junkSkipped, setJunkSkipped] = useState(0);
  const [rootFolderName, setRootFolderName] = useState('');
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [dedupDetailOpen, setDedupDetailOpen] = useState(DEDUP_DETAIL_THRESHOLD_DEFAULT_OPEN);

  // ─── Scan phase ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function runScan() {
      const usable = files.filter((f) => !isJunkFile(f.name));
      setJunkSkipped(files.length - usable.length);
      if (usable.length > 0) {
        // @ts-ignore — webkitRelativePath is not in the standard File type
        setRootFolderName(deriveRelativeSegments(usable[0].webkitRelativePath || usable[0].name).rootFolderName);
      }

      const results: ScannedFile[] = new Array(usable.length);
      let cursor = 0;
      let doneCount = 0;

      async function worker() {
        while (true) {
          const idx = cursor++;
          if (idx >= usable.length) return;
          const file = usable[idx];
          // @ts-ignore — webkitRelativePath is not in the standard File type
          const relPath: string = file.webkitRelativePath || file.name;
          const { segments } = deriveRelativeSegments(relPath);

          let hash = '';
          try {
            hash = await sha256Hex(file);
          } catch {
            // Hash failure shouldn't block the import — treat as new,
            // matching uploadStore.ts's existing fallback (Reid's UX
            // spec, section 10's "hash check fails" row).
            hash = `unhashable-${idx}-${file.name}-${file.size}`;
          }

          let vaultAssetId: string | null = null;
          try {
            const check = await api.assets.checkHash(hash);
            if (check.exists && check.asset) vaultAssetId = check.asset.id;
          } catch {
            // Treat as new on check failure too — same fallback posture.
          }

          if (cancelled) return;
          results[idx] = { file, segments, hash, vaultAssetId };
          doneCount += 1;
          setHashedCount(doneCount);
        }
      }

      await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, usable.length) }, () => worker()));
      if (cancelled) return;

      const tree = results.filter((r) => r.segments.length > 0);
      const flat = results.filter((r) => r.segments.length === 0);
      setScanned(tree);
      setFlatFiles(flat);
      setPhase('preview');
    }

    void runScan();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // files is a snapshot from the moment the picker fired — never re-scan on re-render

  // ─── Preview tree (derived) ─────────────────────────────────────────────────

  const previewRoots = useMemo(
    () => buildPreviewTree(scanned.map((s) => s.segments), existingSubAssemblies, targetParentId),
    [scanned, existingSubAssemblies, targetParentId],
  );

  // Default expand depth: first two levels open (Reid's UX spec, section
  // 6.2) — seeded once when the tree first becomes available.
  useEffect(() => {
    if (phase !== 'preview') return;
    const flat = flattenTree(previewRoots);
    setExpandedKeys(new Set(flat.filter((n) => n.depth <= 1).map((n) => n.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const totals = useMemo(() => computeIncludedTotals(previewRoots, excludedKeys), [previewRoots, excludedKeys]);
  const nodeIndex = useMemo(() => buildNodeIndex(previewRoots), [previewRoots]);
  const includedFlatCount = flatFiles.length; // flat files aren't excludable via the tree checkboxes

  const dedupCount = scanned.filter((s) => s.vaultAssetId).length + flatFiles.filter((f) => f.vaultAssetId).length;
  const totalScannedFiles = scanned.length + flatFiles.length;
  const newUploadCount = totalScannedFiles - dedupCount;

  function toggleNode(node: PreviewNode) {
    setExcludedKeys((prev) => {
      const next = new Set(prev);
      const currentlyExcluded = isExcluded(node, prev);
      if (currentlyExcluded) {
        // Only meaningful to un-exclude a DIRECTLY excluded node — a node
        // excluded only via an ancestor has no key of its own in the set,
        // and the checkbox is disabled for that case (see PreviewRow).
        next.delete(node.key);
      } else {
        next.add(node.key);
      }
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function handleStartImport() {
    const includedTreeFiles = scanned.filter((s) => {
      const node = nodeIndex.get(pathKey(s.segments));
      return node ? !isExcluded(node, excludedKeys) : true;
    });
    const included = [...includedTreeFiles, ...flatFiles];
    const resolutions = buildResolutions(included);

    // Fire-and-forget — startImport()'s promise doesn't resolve until the
    // ENTIRE batch finishes (up to 500 files), so awaiting it here would
    // freeze this modal on a disabled "Starting…" button for the whole
    // import while ImportPanel's own full-screen Modal renders underneath
    // it at the same time (two stacked overlays). importStore is a
    // module-level external store: ImportPanel (mounted once at the App
    // root) picks up the running job the instant setState fires inside
    // startImport, independent of this component's lifecycle, so we can
    // close immediately and hand off — matching Reid's UX spec, section 8's
    // "the modal demotes to the pill on Start."
    //
    // The .catch() below is a safety net, not a fix for an expected
    // failure: every per-file error is already caught and recorded inside
    // startImport itself (see processOne's try/catch in importStore.ts),
    // so this should never fire. But since we're not awaiting the
    // returned promise, any error that DID somehow escape that internal
    // handling would otherwise surface as an unhandled promise rejection
    // with nothing the user could act on.
    void startImport({
      projectId,
      parentSubAssemblyId: targetParentId,
      folderName: rootFolderName || 'Import',
      resolutions,
      newSubAssemblyTotal: totals.includedNewCount,
      mergedSubAssemblyTotal: totals.includedMergeCount,
    }).catch((err) => {
      console.error('[ImportFolderModal] startImport failed unexpectedly:', err);
    });

    onClose();
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (phase === 'scanning') {
    const total = files.length || 1;
    return (
      <Modal title={`Import folder: ${rootFolderName || '…'}`} onClose={onClose} wide>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Scanning {files.length} file{files.length === 1 ? '' : 's'} for duplicates… {hashedCount}/{files.length}
          </p>
          <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-150"
              style={{ width: `${(hashedCount / total) * 100}%` }}
            />
          </div>
        </div>
      </Modal>
    );
  }

  // Zero valid files — everything selected was OS junk.
  if (totalScannedFiles === 0) {
    return (
      <Modal title={`Import folder: ${rootFolderName || 'folder'}`} onClose={onClose}>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            No importable files found in {rootFolderName || 'this folder'}. Only OS system files were detected.
          </p>
          <div className="flex justify-end">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Degenerate case — no folder structure detected at all (every file
  // sits directly in the picked folder).
  const noStructureDetected = previewRoots.length === 0;

  const startLabel = noStructureDetected
    ? `Upload ${totalScannedFiles} file${totalScannedFiles === 1 ? '' : 's'}`
    : `Start import (${totals.includedFileCount + includedFlatCount} file${(totals.includedFileCount + includedFlatCount) === 1 ? '' : 's'})`;

  return (
    <Modal title={`Import folder: ${rootFolderName} (${totalScannedFiles} file${totalScannedFiles === 1 ? '' : 's'})`} onClose={onClose} wide>
      <div className="flex flex-col gap-4 p-5">
        {junkSkipped > 0 && (
          <p className="text-xs text-gray-400">
            {junkSkipped} OS system file{junkSkipped === 1 ? '' : 's'} skipped automatically.
          </p>
        )}

        {!noStructureDetected && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Detected {totals.includedNewCount + totals.includedMergeCount} sub-assembl{(totals.includedNewCount + totals.includedMergeCount) === 1 ? 'y' : 'ies'},
            up to {totals.maxDepth} level{totals.maxDepth === 1 ? '' : 's'} deep, {totals.includedFileCount + includedFlatCount} file{(totals.includedFileCount + includedFlatCount) === 1 ? '' : 's'} total
          </p>
        )}

        {/* Dedup summary — always visible when at least one file matches
            the vault (Reid's UX spec, section 6.2). */}
        {dedupCount > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-2 px-3 py-2">
            <button
              onClick={() => setDedupDetailOpen((v) => !v)}
              className="w-full flex items-center justify-between text-sm text-gray-700 dark:text-gray-200"
            >
              <span>
                {newUploadCount} new upload{newUploadCount === 1 ? '' : 's'} · {dedupCount} already in your vault (will be linked, not re-uploaded)
              </span>
              <ChevronRight size={14} className={`transition-transform text-gray-400 ${dedupDetailOpen ? 'rotate-90' : ''}`} />
            </button>
            {dedupDetailOpen && (
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1 border-t border-gray-200 dark:border-gray-700 pt-2">
                {[...scanned, ...flatFiles].filter((s) => s.vaultAssetId).map((s, i) => (
                  <p key={i} className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {s.file.name}, already in vault
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {noStructureDetected ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            No folder structure detected inside {rootFolderName}. These {totalScannedFiles} file{totalScannedFiles === 1 ? '' : 's'} will be uploaded directly into &apos;{targetLabel}&apos; as flat files, the same as a regular multi-file upload.
          </p>
        ) : (
          <div className="max-h-[45vh] overflow-y-auto space-y-0.5 border border-gray-200 dark:border-gray-700 rounded-lg p-2">
            {[...previewRoots].sort((a, b) => a.name.localeCompare(b.name)).map((node) => (
              <PreviewRow
                key={node.key}
                node={node}
                excludedKeys={excludedKeys}
                expandedKeys={expandedKeys}
                onToggleNode={toggleNode}
                onToggleExpanded={toggleExpanded}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-700">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
          Cancel
        </button>
        <button
          onClick={handleStartImport}
          disabled={(totals.includedFileCount + includedFlatCount) === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FolderInput size={14} />
          {startLabel}
        </button>
      </div>
    </Modal>
  );
}

function PreviewRow({
  node, excludedKeys, expandedKeys, onToggleNode, onToggleExpanded,
}: {
  node: PreviewNode;
  excludedKeys: Set<string>;
  expandedKeys: Set<string>;
  onToggleNode: (node: PreviewNode) => void;
  onToggleExpanded: (key: string) => void;
}) {
  const excluded = isExcluded(node, excludedKeys);
  const indeterminate = isIndeterminate(node, excludedKeys);
  const hasExcludedAncestor = excluded && !excludedKeys.has(node.key);
  const isExpanded = expandedKeys.has(node.key);
  const hasChildren = node.children.length > 0;
  const sortedChildren = [...node.children].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm ${excluded ? 'opacity-40' : ''}`}
        style={{ paddingLeft: `${8 + node.depth * 16}px` }}
      >
        <button
          onClick={() => onToggleExpanded(node.key)}
          className={`transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''} ${!hasChildren ? 'opacity-0 pointer-events-none' : ''}`}
        >
          <ChevronRight size={14} />
        </button>

        <input
          type="checkbox"
          checked={!excluded}
          disabled={hasExcludedAncestor}
          ref={(el) => { if (el) el.indeterminate = indeterminate; }}
          onChange={() => onToggleNode(node)}
          className="w-4 h-4 accent-accent flex-shrink-0"
        />

        <Boxes size={14} className="flex-shrink-0 text-accent" />
        <span className="flex-1 truncate font-medium text-gray-800 dark:text-gray-200">{node.name}</span>

        {node.willMerge && (
          <span className="text-[10px] px-1.5 py-0 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 flex-shrink-0">
            existing, will merge
          </span>
        )}

        <span className="text-xs text-gray-400 flex-shrink-0">
          {node.directFileCount} file{node.directFileCount === 1 ? '' : 's'}
        </span>
      </div>

      {isExpanded && sortedChildren.map((child) => (
        <PreviewRow
          key={child.key}
          node={child}
          excludedKeys={excludedKeys}
          expandedKeys={expandedKeys}
          onToggleNode={onToggleNode}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
    </div>
  );
}

// Shared by all four entry points (ProjectView pre-manifest breadcrumb +
// banner, ManifestView root toolbar + drilled-in action row) — hides the
// webkitdirectory picker input, opens ImportFolderModal once a folder is
// chosen. Reid's UX spec, section 3 and section 9's reuse map (ports
// UploadZone.tsx's hidden-input + ref + .click() pattern).
export function ImportFolderButton({
  projectId, targetParentId, targetLabel, existingSubAssemblies, label, className,
}: {
  projectId: string;
  targetParentId: string | null;
  targetLabel: string;
  existingSubAssemblies: SubAssemblyOut[];
  label: string;
  className: string;
}) {
  const [pickedFiles, setPickedFiles] = useState<File[] | null>(null);

  return (
    <>
      <label className={className}>
        <FolderInput size={13} />
        {label}
        <input
          type="file"
          multiple
          // @ts-ignore — webkitdirectory is not in TS's File input types
          webkitdirectory=""
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) setPickedFiles(Array.from(e.target.files));
            e.target.value = ''; // allow re-picking the same folder later
          }}
        />
      </label>

      {pickedFiles && (
        <ImportFolderModal
          files={pickedFiles}
          projectId={projectId}
          targetParentId={targetParentId}
          targetLabel={targetLabel}
          existingSubAssemblies={existingSubAssemblies}
          onClose={() => setPickedFiles(null)}
        />
      )}
    </>
  );
}
