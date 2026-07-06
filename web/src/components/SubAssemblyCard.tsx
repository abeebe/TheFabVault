import { ChevronRight, Boxes } from 'lucide-react';
import type { SubAssemblyOut } from '../types/index.js';

interface Props {
  subAssembly: SubAssemblyOut;
  childCount: number;
  onClick: () => void;
}

// Visual sibling of AssetCard (same rounded-xl border card language) but
// distinct content: name, progress bar, "12/18 printed", and a structure
// badge so it's scannable in under 3 seconds whether this card is a branch
// or a leaf before clicking in (Reid's UX spec, section 4.6).
export function SubAssemblyCard({ subAssembly, childCount, onClick }: Props) {
  const { rollup } = subAssembly;
  const pct = rollup.percent;

  return (
    <button
      onClick={onClick}
      className="group flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-surface-2 hover:border-gray-300 dark:hover:border-gray-600 transition-all text-left p-3 gap-2"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate flex-1" title={subAssembly.name}>
          {subAssembly.name}
        </p>
        <ChevronRight
          size={16}
          className="text-gray-300 dark:text-gray-600 group-hover:text-accent group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-0.5"
        />
      </div>

      {/* Progress bar — dashed/empty when nothing's been placed yet, since
          "no parts placed yet" is a different fact from "0% of something
          real" (never render a filled-to-zero bar for that case). */}
      {pct === null ? (
        <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 border border-dashed border-gray-300 dark:border-gray-600" />
      ) : (
        <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {pct === null ? 'No parts yet' : `${rollup.done}/${rollup.needed} printed`}
        </span>
        {childCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-gray-400 flex-shrink-0">
            <Boxes size={11} />
            {childCount} sub-assembl{childCount === 1 ? 'y' : 'ies'}
          </span>
        )}
      </div>
    </button>
  );
}
