import { useState, useEffect, useRef } from 'react';
import {
  Download, Trash2, Tag, FolderInput, Edit2, FileBox,
  Image, File, MoreVertical, CheckSquare, Square,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { TagBadge, TagInput } from './TagInput.js';
import { Spinner } from './Spinner.js';
import type { AssetOut, FolderOut } from '../types/index.js';

interface AssetCardProps {
  asset: AssetOut;
  folders: FolderOut[];
  selected: boolean;
  onSelect: () => void;
  onUpdate: (updated: AssetOut) => void;
  onDelete: () => void;
  onPreview: () => void;
}

function getFileIcon(mime: string, filename: string) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (['.stl', '.obj', '.3mf', '.step', '.stp'].includes(ext)) return <FileBox size={28} className="text-blue-400" />;
  if (mime.startsWith('image/') || ['.svg', '.dxf'].includes(ext)) return <Image size={28} className="text-green-400" />;
  return <File size={28} className="text-gray-400" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AssetCard({ asset, folders, selected, onSelect, onUpdate, onDelete, onPreview }: AssetCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(asset.originalName || asset.filename);
  const [editingTags, setEditingTags] = useState(false);
  const [tags, setTags] = useState(asset.tags);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Poll for thumbnail while pending
  useEffect(() => {
    if (asset.thumbStatus !== 'pending') return;
    const interval = setInterval(async () => {
      try {
        const updated = await api.assets.get(asset.id);
        if (updated.thumbStatus !== 'pending') {
          onUpdate(updated);
          clearInterval(interval);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [asset.id, asset.thumbStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  async function handleRename() {
    const trimmed = nameVal.trim();
    if (!trimmed || trimmed === (asset.originalName || asset.filename)) {
      setEditingName(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.assets.updateMeta(asset.id, { title: trimmed });
      onUpdate(updated);
    } catch {}
    setEditingName(false);
    setSaving(false);
  }

  async function handleTagsSave() {
    try {
      const updated = await api.assets.updateTags(asset.id, tags);
      onUpdate(updated);
    } catch {}
    setEditingTags(false);
  }

  async function handleMove(folderId: string | null) {
    try {
      const updated = await api.assets.moveToFolder(asset.id, folderId);
      onUpdate(updated);
    } catch {}
    setShowMoveMenu(false);
    setMenuOpen(false);
  }

  function handleDownload() {
    const url = api.assets.fileUrl(asset);
    const a = document.createElement('a');
    a.href = url;
    a.download = asset.filename;
    a.click();
    setMenuOpen(false);
  }

  const thumbUrl = api.assets.thumbUrl(asset);

  return (
    <div
      className={`group relative flex flex-col rounded-xl overflow-hidden border transition-all cursor-pointer
        ${selected
          ? 'border-accent ring-2 ring-accent/30 bg-surface-2'
          : 'border-gray-200 dark:border-gray-700 bg-surface-2 hover:border-gray-300 dark:hover:border-gray-600'
        }`}
      onDoubleClick={onPreview}
    >
      {/* Selection checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {selected
          ? <CheckSquare size={18} className="text-accent" />
          : <Square size={18} className="text-gray-400" />
        }
      </button>

      {/* Thumbnail area */}
      <div
        className="relative bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden"
        style={{ aspectRatio: '1' }}
        onClick={onPreview}
      >
        {asset.thumbStatus === 'done' && thumbUrl ? (
          <img
            src={thumbUrl}
            alt={asset.filename}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : asset.thumbStatus === 'pending' ? (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <Spinner size="md" />
            <span className="text-xs">Generating preview...</span>
          </div>
        ) : asset.thumbStatus === 'failed' ? (
          <div className="flex flex-col items-center gap-2 text-gray-400 p-4">
            {getFileIcon(asset.mime, asset.filename)}
            <span className="text-xs text-center">{asset.filename}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-400 p-4">
            {getFileIcon(asset.mime, asset.filename)}
            <span className="text-xs text-center text-gray-500">{asset.mime.split('/')[1]?.toUpperCase() || 'FILE'}</span>
          </div>
        )}
      </div>

      {/* Info area */}
      <div className="flex flex-col p-3 gap-1.5 flex-1">
        {/* Filename / editable title */}
        {editingName ? (
          <div className="flex gap-1">
            <input
              ref={nameRef}
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') { setEditingName(false); setNameVal(asset.originalName || asset.filename); }
              }}
              onBlur={handleRename}
              autoFocus
              className="flex-1 text-xs rounded px-1.5 py-1 bg-white dark:bg-gray-700 border border-accent outline-none text-gray-900 dark:text-gray-100"
            />
            {saving && <Spinner size="sm" />}
          </div>
        ) : (
          <p
            className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate"
            title={asset.originalName || asset.filename}
            onDoubleClick={(e) => { e.stopPropagation(); setEditingName(true); }}
          >
            {asset.originalName || asset.filename}
          </p>
        )}

        {/* Size */}
        <p className="text-xs text-gray-400">{formatSize(asset.size)}</p>

        {/* Tags */}
        {editingTags ? (
          <div onClick={(e) => e.stopPropagation()}>
            <TagInput
              tags={tags}
              onChange={setTags}
            />
            <div className="flex gap-1 mt-1">
              <button
                onClick={handleTagsSave}
                className="text-xs px-2 py-0.5 rounded bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => { setTags(asset.tags); setEditingTags(false); }}
                className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1 min-h-[20px]">
            {asset.tags.map((t) => <TagBadge key={t} tag={t} />)}
          </div>
        )}
      </div>

      {/* Context menu button */}
      <div
        ref={menuRef}
        className="absolute top-2 right-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-600 transition-all text-gray-600 dark:text-gray-300"
        >
          <MoreVertical size={16} />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-7 z-20 w-44 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 text-sm animate-fade-in">
            <button
              onClick={() => { setEditingName(true); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              <Edit2 size={14} /> Rename
            </button>
            <button
              onClick={() => { setEditingTags(true); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              <Tag size={14} /> Edit tags
            </button>
            <div className="relative">
              <button
                onClick={() => setShowMoveMenu((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
              >
                <FolderInput size={14} /> Move to folder
              </button>
              {showMoveMenu && (
                <div className="absolute right-full top-0 w-44 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 max-h-48 overflow-y-auto animate-fade-in">
                  <button
                    onClick={() => handleMove(null)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
                  >
                    No folder
                  </button>
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => handleMove(f.id)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${
                        f.id === asset.folderId
                          ? 'text-accent font-medium'
                          : 'text-gray-700 dark:text-gray-200'
                      }`}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <hr className="my-1 border-gray-200 dark:border-gray-700" />
            <button
              onClick={handleDownload}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              <Download size={14} /> Download
            </button>
            <button
              onClick={() => { onDelete(); setMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
