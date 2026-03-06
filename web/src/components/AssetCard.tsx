import { useState, useEffect, useRef } from 'react';
import {
  Download, Trash2, Tag, FolderInput, Edit2, FileBox,
  Image, File, MoreVertical, CheckSquare, Square, FolderPlus, Sliders, RefreshCw, LayoutGrid, Heart,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { TagBadge, TagInput } from './TagInput.js';
import { Spinner } from './Spinner.js';
import { StarRating } from './StarRating.js';
import type { AssetOut, FolderOut, ProjectOut } from '../types/index.js';

interface AssetCardProps {
  asset: AssetOut;
  folders: FolderOut[];
  selected: boolean;
  onSelect: () => void;
  onUpdate: (updated: AssetOut) => void;
  onPreview: () => void;
  // Delete:
  //   onDelete — moves to trash (normal mode) or removes from project (project mode)
  onDelete?: () => void;
  // Project mode extras
  projectMode?: boolean;
  hasOverrides?: boolean;
  onEditOverrides?: () => void;
  projects?: ProjectOut[];
  onAddToProject?: (projectId: string) => void;
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

export function AssetCard({
  asset, folders, selected, onSelect, onUpdate, onPreview,
  onDelete,
  projectMode, hasOverrides, onEditOverrides,
  projects, onAddToProject,
}: AssetCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(asset.originalName || asset.filename);
  const [editingTags, setEditingTags] = useState(false);
  const [tags, setTags] = useState(asset.tags);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rethumbing, setRethumbing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Poll for thumbnail while pending
  useEffect(() => {
    if (asset.thumbStatus !== 'pending') return;
    const interval = setInterval(async () => {
      try {
        const updated = await api.assets.get(asset.id);
        if (updated.thumbStatus !== 'pending') {
          console.log(`[AssetCard] Thumbnail generation complete for ${asset.id}: ${updated.thumbStatus}`);
          onUpdate(updated);
          clearInterval(interval);
        }
      } catch (err) {
        console.error(`[AssetCard] Failed to poll thumbnail for ${asset.id}:`, err);
      }
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

  async function handleRethumb() {
    setRethumbing(true);
    setMenuOpen(false);
    try {
      await api.assets.rethumb(asset.id);
      // Optimistically set to pending so the polling effect kicks in
      onUpdate({ ...asset, thumbStatus: 'pending' });
    } catch (err) {
      console.error('[AssetCard] rethumb error:', err);
    } finally {
      setRethumbing(false);
    }
  }

  async function handleSetCategory(category: string | null) {
    try {
      const updated = await api.assets.setCategory(asset.id, category);
      onUpdate(updated);
    } catch (err) {
      console.error('[AssetCard] setCategory error:', err);
    }
    setShowCategoryMenu(false);
    setMenuOpen(false);
  }

  const thumbUrl = api.assets.thumbUrl(asset);

  return (
    <div
      className={`group relative flex flex-col rounded-xl border transition-all cursor-pointer
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

      {/* Override badge */}
      {projectMode && hasOverrides && (
        <div className="absolute top-2 left-8 z-10">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-400/90 text-amber-900">
            overrides
          </span>
        </div>
      )}

      {/* Favorite heart */}
      <button
        onClick={async (e) => {
          e.stopPropagation();
          try {
            const updated = await api.assets.setFavorite(asset.id, !asset.isFavorite);
            onUpdate(updated);
          } catch {}
        }}
        title={asset.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        className={`absolute top-2 right-8 z-10 p-1 rounded transition-all ${
          asset.isFavorite
            ? 'opacity-100 text-red-500'
            : 'opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400'
        }`}
      >
        <Heart size={14} fill={asset.isFavorite ? 'currentColor' : 'none'} />
      </button>

      {/* Thumbnail area */}
      <div
        className="relative bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden rounded-t-xl"
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

        {/* Size + Rating */}
        <div className="flex items-center justify-between gap-1">
          <p className="text-xs text-gray-400">{formatSize(asset.size)}</p>
          <StarRating
            rating={asset.rating}
            size="sm"
            onChange={async (r) => {
              try {
                const updated = await api.assets.setRating(asset.id, r);
                onUpdate(updated);
              } catch {}
            }}
          />
        </div>

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
          <div className="absolute right-0 top-7 z-20 w-52 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 text-sm animate-fade-in">
            {confirmDelete ? (
              /* ── Inline delete confirmation ── */
              <div className="px-3 py-2">
                <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">
                  {projectMode ? 'Remove from project?' : 'Move to trash?'}
                </p>
                {!projectMode && (
                  <div className="flex flex-col gap-1 mb-2">
                    <button
                      onClick={() => { onDelete?.(); setConfirmDelete(false); setMenuOpen(false); }}
                      className="w-full text-left px-2 py-1.5 rounded text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      Move to trash
                    </button>
                  </div>
                )}
                {projectMode && (
                  <button
                    onClick={() => { onDelete?.(); setConfirmDelete(false); setMenuOpen(false); }}
                    className="w-full text-left px-2 py-1.5 rounded text-xs text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 mb-2"
                  >
                    Confirm remove
                  </button>
                )}
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="w-full text-left px-2 py-1 rounded text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  Cancel
                </button>
              </div>
            ) : (
              /* ── Normal menu ── */
              <>
                {projectMode && onEditOverrides && (
                  <>
                    <button
                      onClick={() => { onEditOverrides(); setMenuOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                    >
                      <Sliders size={14} /> Edit overrides
                    </button>
                    <hr className="my-1 border-gray-200 dark:border-gray-700" />
                  </>
                )}
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
                {/* Set category sub-menu */}
                <div>
                  <button
                    onClick={() => { setShowCategoryMenu((v) => !v); setShowMoveMenu(false); setShowProjectMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                  >
                    <LayoutGrid size={14} /> Set category
                  </button>
                  {showCategoryMenu && (
                    <div className="border-l-2 border-accent/30 ml-4 py-1 animate-fade-in">
                      {([
                        { value: null, label: 'Auto-detect' },
                        { value: '3dmodel', label: '3D Models' },
                        { value: '2d', label: '2D Designs' },
                      ] as { value: string | null; label: string }[]).map(({ value, label }) => (
                        <button
                          key={String(value)}
                          onClick={() => handleSetCategory(value)}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 ${
                            asset.category === value ? 'text-accent font-medium' : 'text-gray-700 dark:text-gray-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {!projectMode && (
                  <div>
                    <button
                      onClick={() => { setShowMoveMenu((v) => !v); setShowCategoryMenu(false); setShowProjectMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                    >
                      <FolderInput size={14} /> Move to folder
                    </button>
                    {showMoveMenu && (
                      <div className="border-l-2 border-accent/30 ml-4 py-1 max-h-48 overflow-y-auto animate-fade-in">
                        <button
                          onClick={() => handleMove(null)}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
                        >
                          No folder
                        </button>
                        {folders.map((f) => (
                          <button
                            key={f.id}
                            onClick={() => handleMove(f.id)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 ${
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
                )}
                {!projectMode && onAddToProject && projects && projects.length > 0 && (
                  <div>
                    <button
                      onClick={() => { setShowProjectMenu((v) => !v); setShowCategoryMenu(false); setShowMoveMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                    >
                      <FolderPlus size={14} /> Add to project
                    </button>
                    {showProjectMenu && (
                      <div className="border-l-2 border-accent/30 ml-4 py-1 max-h-48 overflow-y-auto animate-fade-in">
                        {projects.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => { onAddToProject(p.id); setShowProjectMenu(false); setMenuOpen(false); }}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <hr className="my-1 border-gray-200 dark:border-gray-700" />
                <button
                  onClick={handleRethumb}
                  disabled={rethumbing || asset.thumbStatus === 'pending'}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 disabled:opacity-50"
                >
                  <RefreshCw size={14} className={asset.thumbStatus === 'pending' ? 'animate-spin' : ''} />
                  {asset.thumbStatus === 'pending' ? 'Generating…' : 'Regenerate thumbnail'}
                </button>
                <button
                  onClick={handleDownload}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                >
                  <Download size={14} /> Download
                </button>
                {onDelete && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className={`w-full flex items-center gap-2 px-3 py-2 ${
                      projectMode
                        ? 'hover:bg-orange-50 dark:hover:bg-orange-900/20 text-orange-600 dark:text-orange-400'
                        : 'hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400'
                    }`}
                  >
                    <Trash2 size={14} /> {projectMode ? 'Remove from project' : 'Move to trash'}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
