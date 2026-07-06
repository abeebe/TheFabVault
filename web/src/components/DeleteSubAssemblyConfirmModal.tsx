import { useState } from 'react';
import { Modal } from './Modal.js';
import type { SubAssemblyOut, SubAssemblyPartOut } from '../types/index.js';

// Blast radius for a delete confirm — every descendant sub-assembly (not
// including the node itself) and every part placement across the node and
// its whole subtree. Computed client-side against the already-loaded flat
// manifest arrays, no extra network round-trip (Reid's UX spec, section 7).
function computeBlastRadius(all: SubAssemblyOut[], parts: SubAssemblyPartOut[], rootId: string) {
  const childrenOf = new Map<string | null, SubAssemblyOut[]>();
  for (const sa of all) {
    const key = sa.parentId;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(sa);
  }
  const subtreeIds = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const child of childrenOf.get(id) ?? []) {
      if (!subtreeIds.has(child.id)) { subtreeIds.add(child.id); stack.push(child.id); }
    }
  }
  const nestedCount = subtreeIds.size - 1; // exclude the root itself
  const partCount = parts.filter((p) => subtreeIds.has(p.subAssemblyId)).length;
  return { nestedCount, partCount };
}

interface Props {
  target: SubAssemblyOut;
  allNodes: SubAssemblyOut[];
  allParts: SubAssemblyPartOut[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

// Reused from both Build Mode's node-header "..." menu and Organize Mode's
// per-row delete action (Reid's UX spec, 4.5.2 and 4.11) — one copy of the
// blast-radius copy logic, not two independent implementations that could
// drift.
export function DeleteSubAssemblyConfirmModal({ target, allNodes, allParts, onClose, onConfirm }: Props) {
  const [deleting, setDeleting] = useState(false);
  const blastRadius = computeBlastRadius(allNodes, allParts, target.id);

  async function handleConfirm() {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal title={`Delete '${target.name}'?`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        {blastRadius.nestedCount === 0 && blastRadius.partCount === 0 && (
          <>It has no parts placed. This can&apos;t be undone.</>
        )}
        {blastRadius.nestedCount === 0 && blastRadius.partCount > 0 && (
          <>
            {blastRadius.partCount} part placement{blastRadius.partCount === 1 ? '' : 's'} will be removed.
            Files not placed anywhere else in this project return to Ungrouped; a file also used in another
            sub-assembly stays organized there. Printed-count progress on{' '}
            {blastRadius.partCount === 1 ? 'that placement' : 'those placements'} will be lost. Files stay in your vault.
          </>
        )}
        {blastRadius.nestedCount > 0 && (
          <>
            This also deletes {blastRadius.nestedCount} nested sub-assembl{blastRadius.nestedCount === 1 ? 'y' : 'ies'} and
            removes {blastRadius.partCount} part placement{blastRadius.partCount === 1 ? '' : 's'} across all of them.
            Printed-count progress on those placements will be lost. Files stay in your vault: files not placed
            anywhere else in this project return to Ungrouped, files also used in another sub-assembly stay
            organized there.
          </>
        )}
      </p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={deleting}
          className="px-4 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-60"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}
