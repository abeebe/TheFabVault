import { useMemo } from 'react';
import { Modal } from './Modal.js';
import { PartRow } from './PartRow.js';
import type { SubAssemblyOut, SubAssemblyPartOut } from '../types/index.js';

interface Props {
  rootNode: SubAssemblyOut;
  allNodes: SubAssemblyOut[];
  allParts: SubAssemblyPartOut[];
  onClose: () => void;
  // Passed straight through to PartRow's onUpdated — must be awaited there
  // before its `saving` state clears (see PartRow.tsx), so this needs to
  // return the actual promise, not `void`.
  onUpdatePart: (part: SubAssemblyPartOut) => Promise<void>;
  onRemovePart: (subAssemblyId: string, assetId: string) => void;
  onEditOverrides: (part: SubAssemblyPartOut) => void;
  onPreview: (part: SubAssemblyPartOut) => void;
}

// A flattened pick list for one sub-assembly, including everything nested
// under its descendants (opening Dome pulls in Dome Ring's parts too),
// sorted incomplete-first with completed placements collapsed at the
// bottom so a 90%-done branch doesn't force scrolling past done rows to
// find the few that are left (Reid's UX spec, 4.12).
export function PrintNextModal({
  rootNode, allNodes, allParts, onClose, onUpdatePart, onRemovePart, onEditOverrides, onPreview,
}: Props) {
  const { incomplete, completed, needed, done, nameById } = useMemo(() => {
    const childrenOf = new Map<string | null, SubAssemblyOut[]>();
    for (const sa of allNodes) {
      const key = sa.parentId;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key)!.push(sa);
    }
    const subtreeIds = new Set<string>([rootNode.id]);
    const stack = [rootNode.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const child of childrenOf.get(id) ?? []) {
        if (!subtreeIds.has(child.id)) { subtreeIds.add(child.id); stack.push(child.id); }
      }
    }
    const nameById = new Map(allNodes.map((n) => [n.id, n.name]));
    const relevant = allParts.filter((p) => subtreeIds.has(p.subAssemblyId));
    const incomplete = relevant.filter((p) => p.printedCount < p.quantity);
    const completed = relevant.filter((p) => p.printedCount >= p.quantity);
    const needed = relevant.reduce((sum, p) => sum + p.quantity, 0);
    const done = relevant.reduce((sum, p) => sum + Math.min(p.printedCount, p.quantity), 0);
    return { incomplete, completed, needed, done, nameById };
  }, [rootNode.id, allNodes, allParts]);

  // A small "which sub-bag to reach for" tag when a row belongs to a
  // descendant rather than the node that was opened directly.
  function locationLabel(part: SubAssemblyPartOut): string | undefined {
    if (part.subAssemblyId === rootNode.id) return undefined;
    return nameById.get(part.subAssemblyId);
  }

  return (
    <Modal title={`Print next: ${rootNode.name}`} onClose={onClose} wide>
      <div className="flex flex-col gap-1">
        {incomplete.length === 0 && completed.length === 0 && (
          <p className="text-sm text-gray-400 italic px-2 py-6 text-center">Nothing placed here yet.</p>
        )}
        {incomplete.length === 0 && completed.length > 0 && (
          <p className="text-sm text-gray-400 italic px-2 py-4 text-center">Everything here is printed.</p>
        )}
        {incomplete.map((part) => (
          <PartRow
            key={`${part.subAssemblyId}:${part.asset.id}`}
            part={part}
            onUpdated={onUpdatePart}
            onRemoved={() => onRemovePart(part.subAssemblyId, part.asset.id)}
            onEditOverrides={() => onEditOverrides(part)}
            onPreview={() => onPreview(part)}
            locationLabel={locationLabel(part)}
          />
        ))}

        {completed.length > 0 && (
          <details className="mt-2">
            <summary className="text-xs font-medium text-gray-400 cursor-pointer px-2 py-1">
              Completed ({completed.length})
            </summary>
            <div className="mt-1 space-y-0.5">
              {completed.map((part) => (
                <PartRow
                  key={`${part.subAssemblyId}:${part.asset.id}`}
                  part={part}
                  onUpdated={onUpdatePart}
                  onRemoved={() => onRemovePart(part.subAssemblyId, part.asset.id)}
                  onEditOverrides={() => onEditOverrides(part)}
                  onPreview={() => onPreview(part)}
                  locationLabel={locationLabel(part)}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400">
        {done} of {needed} printed for {rootNode.name} (including nested)
      </div>
    </Modal>
  );
}
