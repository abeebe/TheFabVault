import { useState, useEffect, useRef, useCallback } from 'react';
import { History, Upload, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { Spinner } from './Spinner.js';
import type { AssetOut, VersionOut } from '../types/index.js';

interface VersionPanelProps {
  asset: AssetOut;
  onAssetUpdated: (updated: AssetOut) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function VersionPanel({ asset, onAssetUpdated }: VersionPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<VersionOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [noteText, setNoteText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.assets.getVersions(asset.id);
      setVersions(result.versions);
    } catch {}
    setLoading(false);
  }, [asset.id]);

  useEffect(() => {
    if (expanded) loadVersions();
  }, [expanded, loadVersions]);

  function handleFileSelected(file: File) {
    setPendingFile(file);
    setShowNoteInput(true);
    setNoteText('');
  }

  async function handleUploadConfirm() {
    if (!pendingFile) return;
    setUploading(true);
    setShowNoteInput(false);
    try {
      const result = await api.assets.uploadVersion(asset.id, pendingFile, noteText || undefined);
      onAssetUpdated(result.asset);
      await loadVersions();
    } catch {}
    setUploading(false);
    setPendingFile(null);
    setNoteText('');
  }

  async function handleRestore(versionId: string) {
    setActioningId(versionId);
    try {
      const result = await api.assets.restoreVersion(asset.id, versionId);
      onAssetUpdated(result.asset);
      await loadVersions();
    } catch {}
    setActioningId(null);
  }

  async function handleDeleteVersion(versionId: string) {
    setActioningId(versionId);
    try {
      await api.assets.deleteVersion(asset.id, versionId);
      setVersions((prev) => prev.filter((v) => v.id !== versionId));
    } catch {}
    setActioningId(null);
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700">
      {/* Header toggle */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <History size={14} className="text-gray-400" />
        Version History
        {versions.length > 0 && (
          <span className="ml-auto text-xs text-gray-400 font-normal">
            {versions.length} archived version{versions.length !== 1 ? 's' : ''}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Upload new version */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => { if (e.target.files?.[0]) handleFileSelected(e.target.files[0]); }}
          />

          {showNoteInput ? (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 space-y-2">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-200">
                Uploading: <span className="text-accent">{pendingFile?.name}</span>
              </p>
              <input
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Version note (optional)"
                className="w-full text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleUploadConfirm(); if (e.key === 'Escape') { setShowNoteInput(false); setPendingFile(null); } }}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleUploadConfirm}
                  className="flex-1 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover transition-colors"
                >
                  Archive current & upload
                </button>
                <button
                  onClick={() => { setShowNoteInput(false); setPendingFile(null); }}
                  className="px-3 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500 dark:text-gray-400 hover:border-accent hover:text-accent transition-colors disabled:opacity-60"
            >
              {uploading ? <Spinner size="sm" /> : <Upload size={13} />}
              {uploading ? 'Uploading…' : 'Upload new version'}
            </button>
          )}

          {/* Current version marker */}
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-accent/5 border border-accent/20">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">Current</span>
                <span className="text-xs text-gray-500 truncate">{asset.filename}</span>
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{formatBytes(asset.size)}</p>
            </div>
          </div>

          {/* Archived versions */}
          {loading ? (
            <div className="flex justify-center py-2"><Spinner size="sm" /></div>
          ) : versions.length === 0 ? (
            <p className="text-xs text-gray-400 italic text-center py-1">
              No previous versions — upload one above to start tracking
            </p>
          ) : (
            <div className="space-y-1.5">
              {versions.map((v) => {
                const isActioning = actioningId === v.id;
                return (
                  <div key={v.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/40 border border-gray-200 dark:border-gray-700">
                    <div className="flex-shrink-0 w-6 h-6 rounded bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
                      <span className="text-[10px] font-bold text-gray-500 dark:text-gray-300">v{v.versionNum}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{v.filename}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {formatBytes(v.size)} · {formatDate(v.createdAt)}
                        {v.notes && <span className="ml-1 italic">· {v.notes}</span>}
                      </p>
                    </div>
                    {isActioning ? (
                      <Spinner size="sm" />
                    ) : (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => handleRestore(v.id)}
                          title="Restore this version"
                          className="p-1.5 rounded text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        >
                          <RotateCcw size={12} />
                        </button>
                        <button
                          onClick={() => handleDeleteVersion(v.id)}
                          title="Delete this version"
                          className="p-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
