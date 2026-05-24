import { useEffect, useState } from 'react';
import { X, Sparkles, FolderOpen } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './Spinner.js';
import type { SetSuggestion } from '../types/index.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (count: number) => void;
}

// Modal that surfaces auto-detected set candidates and lets the user
// accept (with optional rename) or skip each one. Skips are not
// remembered — re-running suggest will surface them again unless
// the underlying files are already in a set.
export function SetSuggestions({ isOpen, onClose, onCreated }: Props) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<SetSuggestion[]>([]);
  const [decisions, setDecisions] = useState<Map<number, { keep: boolean; name: string }>>(new Map());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    api.sets.suggest()
      .then(({ suggestions: s }) => {
        setSuggestions(s);
        const initial = new Map<number, { keep: boolean; name: string }>();
        s.forEach((sug, i) => initial.set(i, { keep: true, name: sug.name }));
        setDecisions(initial);
      })
      .catch((err) => {
        console.error('[SetSuggestions] Failed to load:', err);
      })
      .finally(() => setLoading(false));
  }, [isOpen]);

  function toggleKeep(idx: number) {
    setDecisions((prev) => {
      const next = new Map(prev);
      const d = next.get(idx);
      if (d) next.set(idx, { ...d, keep: !d.keep });
      return next;
    });
  }

  function setName(idx: number, name: string) {
    setDecisions((prev) => {
      const next = new Map(prev);
      const d = next.get(idx);
      if (d) next.set(idx, { ...d, name });
      return next;
    });
  }

  async function createAll() {
    setCreating(true);
    let created = 0;
    try {
      for (let i = 0; i < suggestions.length; i++) {
        const decision = decisions.get(i);
        if (!decision?.keep || !decision.name.trim()) continue;
        try {
          await api.sets.create({
            name: decision.name.trim(),
            assetIds: suggestions[i].assetIds,
          });
          created++;
        } catch (err) {
          console.error(`[SetSuggestions] Failed to create "${decision.name}":`, err);
        }
      }
      onCreated(created);
      onClose();
    } finally {
      setCreating(false);
    }
  }

  if (!isOpen) return null;

  const keepCount = Array.from(decisions.values()).filter((d) => d.keep && d.name.trim()).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <Sparkles size={18} className="text-accent flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Auto-detect Sets</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Files grouped by shared filename stems (e.g. <span className="font-mono">_part_1</span>, <span className="font-mono">_supported</span>). Review and accept what looks right.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-12"><Spinner size="md" /></div>
          ) : suggestions.length === 0 ? (
            <div className="text-center py-12 px-5 text-sm text-gray-400">
              No obvious groupings detected. Files that already belong to a set are excluded.
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {suggestions.map((sug, i) => {
                const decision = decisions.get(i);
                if (!decision) return null;
                return (
                  <div key={i} className="px-5 py-3 flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={decision.keep}
                      onChange={() => toggleKeep(i)}
                      className="w-4 h-4 accent-accent flex-shrink-0 mt-1.5"
                    />
                    <div className="flex-1 min-w-0">
                      <input
                        value={decision.name}
                        onChange={(e) => setName(i, e.target.value)}
                        disabled={!decision.keep}
                        className="w-full bg-transparent border-b border-gray-200 dark:border-gray-700 focus:border-accent outline-none text-sm font-medium text-gray-900 dark:text-gray-100 disabled:opacity-50"
                      />
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                        <span>{sug.assetIds.length} files</span>
                        {sug.folderName && (
                          <>
                            <span>·</span>
                            <span className="flex items-center gap-1"><FolderOpen size={11} /> {sug.folderName}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex-shrink-0">
          <span className="text-xs text-gray-500">{keepCount} of {suggestions.length} selected</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={createAll}
              disabled={keepCount === 0 || creating}
              className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating…' : `Create ${keepCount} set${keepCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
