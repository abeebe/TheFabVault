import { useState } from 'react';
import { Search, Boxes } from 'lucide-react';
import { Modal } from './Modal.js';
import type { SubAssemblyOut } from '../types/index.js';

interface Props {
  subAssemblies: SubAssemblyOut[];
  assetCount: number; // how many Ungrouped files are being assigned
  onClose: () => void;
  onAssign: (subAssemblyId: string) => Promise<void>;
}

// Search-to-filter single-select list, used from the Ungrouped tab both as
// a per-card menu action and as the batch-selection action (Reid's UX
// spec, 4.10). A flat flyout doesn't scale once a project has dozens of
// nested nodes — this is a small modal instead, deliberately NOT a nested
// tree, since typed search already collapses the need for indentation here.
export function AssignToSubAssemblyModal({ subAssemblies, assetCount, onClose, onAssign }: Props) {
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  const filtered = filter
    ? subAssemblies.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
    : subAssemblies;

  async function handleConfirm() {
    if (!selectedId) return;
    setAssigning(true);
    try {
      await onAssign(selectedId);
      onClose();
    } finally {
      setAssigning(false);
    }
  }

  return (
    <Modal title="Add to sub-assembly" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-400">
          {assetCount} file{assetCount === 1 ? '' : 's'} will be placed at quantity 1. Adjust quantity afterward from the part row.
        </p>

        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            autoFocus
            type="text"
            placeholder="Search sub-assemblies..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <div className="max-h-64 overflow-y-auto space-y-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 italic px-2 py-4 text-center">
              {subAssemblies.length === 0
                ? 'No sub-assemblies yet — create one from the Manifest tab first.'
                : 'No matches.'}
            </p>
          ) : (
            filtered.map((sa) => (
              <button
                key={sa.id}
                onClick={() => setSelectedId(sa.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                  selectedId === sa.id
                    ? 'bg-accent/10 border border-accent/30 text-accent'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700 border border-transparent text-gray-700 dark:text-gray-200'
                }`}
              >
                <Boxes size={14} className="flex-shrink-0 text-gray-400" />
                <span className="truncate flex-1">{sa.name}</span>
                {sa.rollup.percent !== null && (
                  <span className="text-[10px] text-gray-400 flex-shrink-0">{sa.rollup.percent}%</span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedId || assigning}
            className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {assigning ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
