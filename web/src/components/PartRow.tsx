import { useState } from 'react';
import { FileBox, Image, File, MoreVertical, Sliders, X } from 'lucide-react';
import { api } from '../lib/api.js';
import type { SubAssemblyPartOut } from '../types/index.js';

interface PartRowProps {
  part: SubAssemblyPartOut;
  onUpdated: (part: SubAssemblyPartOut) => void;
  onRemoved: () => void;
  onEditOverrides: () => void;
  onPreview: () => void;
  // "Print this next" reuses this same row but tags which descendant
  // sub-assembly a placement actually lives in (Reid's UX spec, 4.12).
  locationLabel?: string;
}

function getFileIcon(filename: string) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (['.stl', '.obj', '.3mf', '.step', '.stp', '.lys', '.ctb', '.photon'].includes(ext)) {
    return <FileBox size={18} className="text-blue-400" />;
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.dxf', '.cdr', '.ai', '.eps', '.pdf', '.lbrn', '.lbrn2'].includes(ext)) {
    return <Image size={18} className="text-green-400" />;
  }
  return <File size={18} className="text-gray-400" />;
}

// Above this quantity, a numeric stepper reads better than a row of tap
// targets — the PRD's own suggested threshold (Reid's UX spec, 4.7).
const SEGMENT_THRESHOLD = 12;

export function PartRow({ part, onUpdated, onRemoved, onEditOverrides, onPreview, locationLabel }: PartRowProps) {
  const [editingQty, setEditingQty] = useState(false);
  const [qtyVal, setQtyVal] = useState(String(part.quantity));
  const [editingCount, setEditingCount] = useState(false);
  const [countVal, setCountVal] = useState(String(part.printedCount));
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saving, setSaving] = useState(false);

  const thumbUrl = api.assets.thumbUrl(part.asset);
  const filename = part.asset.originalName || part.asset.filename;

  async function saveQuantity() {
    const n = parseInt(qtyVal, 10);
    setEditingQty(false);
    if (!Number.isInteger(n) || n < 1 || n === part.quantity) { setQtyVal(String(part.quantity)); return; }
    setSaving(true);
    try {
      const updated = await api.manifest.updatePart(part.subAssemblyId, part.asset.id, { quantity: n });
      onUpdated(updated);
    } catch (err) {
      console.error('[PartRow] Failed to update quantity:', err);
      setQtyVal(String(part.quantity));
    } finally {
      setSaving(false);
    }
  }

  async function setPrintedCount(n: number) {
    if (n < 0) return;
    setSaving(true);
    try {
      const updated = await api.manifest.updatePart(part.subAssemblyId, part.asset.id, { printedCount: n });
      onUpdated(updated);
    } catch (err) {
      console.error('[PartRow] Failed to update printed count:', err);
    } finally {
      setSaving(false);
    }
  }

  async function saveCountDirect() {
    const n = parseInt(countVal, 10);
    setEditingCount(false);
    if (!Number.isInteger(n) || n < 0 || n === part.printedCount) { setCountVal(String(part.printedCount)); return; }
    await setPrintedCount(n);
  }

  // segmentIndex is 1-based (1..quantity). Clicking the already-active top
  // segment toggles DOWN by one instead of clearing to null — unlike
  // StarRating, 0 printed is a meaningful, distinct state from "unset"
  // here (Reid's UX spec, 4.7, the one deliberate behavior change from the
  // StarRating pattern this control otherwise reuses verbatim).
  function handleSegmentClick(segmentIndex: number) {
    const target = segmentIndex === part.printedCount ? segmentIndex - 1 : segmentIndex;
    setPrintedCount(target);
  }

  return (
    <div className="group relative flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
      <button
        onClick={onPreview}
        className="w-9 h-9 rounded bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 overflow-hidden"
      >
        {part.asset.thumbStatus === 'done' && thumbUrl ? (
          <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          getFileIcon(part.asset.filename)
        )}
      </button>

      <button onClick={onPreview} className="min-w-0 flex-1 text-left">
        <p className="text-sm text-gray-900 dark:text-gray-100 truncate" title={filename}>{filename}</p>
        {locationLabel && (
          <span className="text-[10px] px-1.5 py-0 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
            {locationLabel}
          </span>
        )}
      </button>

      {/* Quantity pill */}
      {editingQty ? (
        <input
          autoFocus
          type="number"
          min={1}
          value={qtyVal}
          onChange={(e) => setQtyVal(e.target.value)}
          onBlur={saveQuantity}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveQuantity();
            if (e.key === 'Escape') { setQtyVal(String(part.quantity)); setEditingQty(false); }
          }}
          className="w-14 text-xs text-center rounded px-1 py-0.5 bg-white dark:bg-gray-700 border border-accent outline-none text-gray-900 dark:text-gray-100"
        />
      ) : (
        <button
          onClick={() => { setQtyVal(String(part.quantity)); setEditingQty(true); }}
          className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 flex-shrink-0"
          title="Click to edit quantity"
        >
          ×{part.quantity}
        </button>
      )}

      {/* Printed-count control */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {part.quantity <= SEGMENT_THRESHOLD ? (
          <div className="flex items-center gap-0.5">
            {Array.from({ length: part.quantity }, (_, i) => i + 1).map((seg) => (
              <button
                key={seg}
                type="button"
                onClick={() => handleSegmentClick(seg)}
                disabled={saving}
                aria-label={`Set printed count to ${seg}`}
                className={`w-3.5 h-3.5 rounded-sm transition-colors ${
                  seg <= Math.min(part.printedCount, part.quantity)
                    ? 'bg-accent'
                    : 'bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500'
                }`}
              />
            ))}
            {part.printedCount > part.quantity && (
              <span className="ml-1 text-[10px] px-1 rounded bg-amber-400/90 text-amber-900 font-medium">
                +{part.printedCount - part.quantity} reprint
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPrintedCount(Math.max(0, part.printedCount - 1))}
              disabled={saving || part.printedCount <= 0}
              aria-label="Decrease printed count"
              className="w-5 h-5 flex items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40"
            >
              −
            </button>
            <button
              onClick={() => setPrintedCount(part.printedCount + 1)}
              disabled={saving}
              aria-label="Increase printed count"
              className="w-5 h-5 flex items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              +
            </button>
          </div>
        )}

        {editingCount ? (
          <input
            autoFocus
            type="number"
            min={0}
            value={countVal}
            onChange={(e) => setCountVal(e.target.value)}
            onBlur={saveCountDirect}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveCountDirect();
              if (e.key === 'Escape') { setCountVal(String(part.printedCount)); setEditingCount(false); }
            }}
            className="w-16 text-xs text-center rounded px-1 py-0.5 bg-white dark:bg-gray-700 border border-accent outline-none text-gray-900 dark:text-gray-100"
          />
        ) : (
          <button
            onClick={() => { setCountVal(String(part.printedCount)); setEditingCount(true); }}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-accent tabular-nums"
            title="Click to set printed count directly"
          >
            {part.printedCount} of {part.quantity}
          </button>
        )}
      </div>

      {/* Row menu */}
      <div className="relative flex-shrink-0">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-600 transition-all text-gray-600 dark:text-gray-300"
        >
          <MoreVertical size={15} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-7 z-20 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 text-sm animate-fade-in">
            {confirmRemove ? (
              <div className="px-3 py-2">
                <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">
                  Remove from this sub-assembly?
                </p>
                <p className="text-[11px] text-gray-400 mb-2">
                  The file returns to Ungrouped. Printed-count progress on this placement is lost.
                </p>
                <button
                  onClick={() => { onRemoved(); setConfirmRemove(false); setMenuOpen(false); }}
                  className="w-full text-left px-2 py-1.5 rounded text-xs text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 mb-1"
                >
                  Confirm remove
                </button>
                <button
                  onClick={() => setConfirmRemove(false)}
                  className="w-full text-left px-2 py-1 rounded text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => { onEditOverrides(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                >
                  <Sliders size={14} /> Edit overrides
                </button>
                <button
                  onClick={() => setConfirmRemove(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-orange-50 dark:hover:bg-orange-900/20 text-orange-600 dark:text-orange-400"
                >
                  <X size={14} /> Remove from this sub-assembly
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
