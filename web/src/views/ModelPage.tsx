import { useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Pencil, Trash2, Download, Plus, X,
  Lock, Globe, FileBox, Image as ImageIcon, FileText, File as FileIcon,
} from 'lucide-react';
import { useModel } from '../hooks/useModels.js';
import { ModelViewer } from '../components/ModelViewer.js';
import { AssetPicker } from '../components/AssetPicker.js';
import { TagInput, TagBadge } from '../components/TagInput.js';
import { Modal } from '../components/Modal.js';
import { Spinner } from '../components/Spinner.js';
import { renderMarkdown, isSafeUrl } from '../lib/markdown.js';
import { api } from '../lib/api.js';
import type { AssetOut } from '../types/index.js';
import type {
  ModelDetailOut, ModelFileOut, ModelUpdateBody, ModelVisibility,
  PrintProfileOut, PrintProfileCreateBody, PrintProfileUpdateBody,
} from '../lib/api.js';

type Tab = 'overview' | 'files' | 'profiles';
type FileRole = 'part' | 'image' | 'doc' | 'other';

const ROLE_LABELS: Record<FileRole, string> = { part: 'Parts', image: 'Images', doc: 'Docs', other: 'Other' };
const ROLE_ORDER: FileRole[] = ['part', 'image', 'doc', 'other'];
// Extensions ModelViewer already knows how to render in its 3D/GCode
// path (mirrors ModelViewer.tsx's own STL_EXTS/GCODE_EXTS) -- used only
// to decide which "part" files get a quick-access button in Overview;
// ModelViewer itself does the real dispatch once opened.
const PRINTABLE_RE = /\.(stl|obj|3mf|gcode|gc|g)$/i;

function getRoleIcon(role: FileRole) {
  if (role === 'part') return <FileBox size={16} className="text-blue-400 flex-shrink-0" />;
  if (role === 'image') return <ImageIcon size={16} className="text-green-400 flex-shrink-0" />;
  if (role === 'doc') return <FileText size={16} className="text-orange-400 flex-shrink-0" />;
  return <FileIcon size={16} className="text-gray-400 flex-shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Image gallery carousel ─────────────────────────────────────────────────
// Main frame + thumbnail strip; clicking the main frame opens the full
// ModelViewer modal (rating/meta/versions) for that asset -- reused
// exactly as AssetGrid/SetView already do, not re-implemented here.

function Gallery({ images, onExpand }: { images: ModelFileOut[]; onExpand: (asset: AssetOut) => void }) {
  const [index, setIndex] = useState(0);

  if (images.length === 0) {
    return (
      <div className="flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-xl text-gray-400" style={{ aspectRatio: '4/3' }}>
        <div className="text-center">
          <ImageIcon size={32} className="mx-auto mb-2" />
          <p className="text-sm">No images yet</p>
        </div>
      </div>
    );
  }

  const currentIndex = Math.min(index, images.length - 1);
  const current = images[currentIndex];
  const mainUrl = api.assets.thumbUrl(current.asset) ?? api.assets.fileUrl(current.asset);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative bg-gray-100 dark:bg-gray-900 rounded-xl overflow-hidden" style={{ aspectRatio: '4/3' }}>
        <img
          src={mainUrl}
          alt={current.label || current.asset.originalName || current.asset.filename}
          className="w-full h-full object-contain cursor-pointer"
          onClick={() => onExpand(current.asset)}
        />
        {images.length > 1 && (
          <>
            <button
              onClick={() => setIndex((i) => (i - 1 + images.length) % images.length)}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
              aria-label="Previous image"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              onClick={() => setIndex((i) => (i + 1) % images.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
              aria-label="Next image"
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((img, i) => {
            const t = api.assets.thumbUrl(img.asset);
            return (
              <button
                key={img.assetId}
                onClick={() => setIndex(i)}
                className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
                  i === currentIndex ? 'border-accent' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                {t
                  ? <img src={t} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full bg-gray-200 dark:bg-gray-700" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 3D viewer quick-access row ──────────────────────────────────────────────
// Reuses ModelViewer/GCodeViewer exactly as they already work elsewhere
// (AssetGrid, SetView) -- clicking a part opens the same preview modal,
// which internally picks ThreeViewer or GCodeViewer by extension. No new
// viewer code, just a row of buttons into the existing one.

function PartsQuickView({ parts, onView }: { parts: ModelFileOut[]; onView: (asset: AssetOut) => void }) {
  const printable = parts.filter((p) => PRINTABLE_RE.test(p.asset.filename));
  if (printable.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5">3D / print files</h2>
      <div className="flex flex-wrap gap-2">
        {printable.map((p) => (
          <button
            key={p.assetId}
            onClick={() => onView(p.asset)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <FileBox size={14} className="text-blue-400" />
            {p.label || p.asset.originalName || p.asset.filename}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Edit details modal ──────────────────────────────────────────────────────
// One combined modal for every structured field on the model (title,
// tags, visibility, category, source attribution) rather than AssetCard's
// pattern of a separate inline-edit toggle per field -- that pattern is
// exactly what made AssetCard grow to 543 LOC, and a model has more
// editable fields than an asset, not fewer. Description stays outside
// this modal (see ModelPage body) since markdown deserves more room than
// a modal affords.
//
// Known gap: categoryId is a raw text field, not a picker. There is no
// GET /categories endpoint yet (the categories table + seed exist
// server-side per the plan, but no route exposes the list to the
// client) -- out of scope for this ticket to add server-side, and adding
// a client-only picker without it would just be a dropdown with nothing
// to select. Flagged in the completion report as a follow-up for Kit.
function EditDetailsModal({
  model, onSave, onClose,
}: {
  model: ModelDetailOut;
  onSave: (body: ModelUpdateBody) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(model.title);
  const [tags, setTags] = useState<string[]>(model.tags);
  const [visibility, setVisibility] = useState<ModelVisibility>(model.visibility);
  const [categoryId, setCategoryId] = useState(model.categoryId ?? '');
  const [sourceSite, setSourceSite] = useState(model.sourceSite ?? '');
  const [sourceAuthor, setSourceAuthor] = useState(model.sourceAuthor ?? '');
  const [sourceUrl, setSourceUrl] = useState(model.sourceUrl ?? '');
  const [license, setLicense] = useState(model.license ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSaving(true);
    try {
      await onSave({
        title: trimmedTitle,
        tags,
        visibility,
        categoryId: categoryId.trim() || null,
        sourceSite: sourceSite.trim() || null,
        sourceAuthor: sourceAuthor.trim() || null,
        sourceUrl: sourceUrl.trim() || null,
        license: license.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  const inputClass = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent';

  return (
    <Modal title="Edit model details" onClose={onClose}>
      <div className="p-1 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags</label>
          <TagInput tags={tags} onChange={setTags} />
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Visibility</label>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as ModelVisibility)} className={inputClass}>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Category ID <span className="font-normal text-gray-400">(no picker yet)</span>
            </label>
            <input
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              placeholder="leave blank for none"
              className={inputClass}
            />
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-gray-500 dark:text-gray-400 select-none">Source attribution (optional)</summary>
          <div className="mt-2 space-y-2">
            <input value={sourceSite} onChange={(e) => setSourceSite(e.target.value)} placeholder="Source site (e.g. Printables)" className={inputClass} />
            <input value={sourceAuthor} onChange={(e) => setSourceAuthor(e.target.value)} placeholder="Original author" className={inputClass} />
            <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="Source URL" className={inputClass} />
            <input value={license} onChange={(e) => setLicense(e.target.value)} placeholder="License (e.g. CC-BY-NC)" className={inputClass} />
          </div>
        </details>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving}
            className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Print profile add/edit modal ────────────────────────────────────────────

function ProfileModal({
  profile, onSave, onClose,
}: {
  profile: PrintProfileOut | null;
  onSave: (body: PrintProfileCreateBody | PrintProfileUpdateBody) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [printer, setPrinter] = useState(profile?.printer ?? '');
  const [material, setMaterial] = useState(profile?.material ?? '');
  const [nozzle, setNozzle] = useState(profile?.nozzle ?? '');
  const [layerHeight, setLayerHeight] = useState(profile?.layerHeight != null ? String(profile.layerHeight) : '');
  const [infill, setInfill] = useState(profile?.infill != null ? String(profile.infill) : '');
  const [supports, setSupports] = useState(profile?.supports ?? false);
  const [notes, setNotes] = useState(profile?.notes ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    try {
      await onSave({
        name: trimmedName,
        printer: printer.trim() || undefined,
        material: material.trim() || undefined,
        nozzle: nozzle.trim() || undefined,
        layerHeight: layerHeight.trim() ? Number(layerHeight) : undefined,
        infill: infill.trim() ? Number(infill) : undefined,
        supports,
        notes: notes.trim() || undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  const inputClass = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent';

  return (
    <Modal title={profile ? 'Edit print profile' : 'Add print profile'} onClose={onClose}>
      <div className="p-1 space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Draft PLA" className={inputClass} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Printer</label>
            <input value={printer} onChange={(e) => setPrinter(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Material</label>
            <input value={material} onChange={(e) => setMaterial(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Nozzle</label>
            <input value={nozzle} onChange={(e) => setNozzle(e.target.value)} placeholder="0.4mm" className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Layer height (mm)</label>
            <input type="number" step="0.01" value={layerHeight} onChange={(e) => setLayerHeight(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Infill (%)</label>
            <input type="number" step="1" value={infill} onChange={(e) => setInfill(e.target.value)} className={inputClass} />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={supports} onChange={(e) => setSupports(e.target.checked)} />
              Supports
            </label>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? 'Saving…' : profile ? 'Save' : 'Add profile'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ModelPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    model, loading, error, refresh, update, attachExisting, uploadFiles,
    detachFile, setCover, createProfile, updateProfile, deleteProfile,
  } = useModel(id ?? null);

  const [tab, setTab] = useState<Tab>('overview');
  const [previewAsset, setPreviewAsset] = useState<AssetOut | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDetachId, setConfirmDetachId] = useState<string | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<PrintProfileOut | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (loading && !model) {
    return <div className="flex h-full items-center justify-center bg-surface"><Spinner size="lg" /></div>;
  }

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="text-center text-gray-500 dark:text-gray-400">
          {error ? (
            <>
              <p className="text-sm text-red-400">Failed to load model: {error}</p>
              <button onClick={refresh} className="mt-2 text-xs text-accent hover:underline">Retry</button>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Model not found</p>
              <Link to="/library" className="text-xs text-accent hover:underline mt-1 inline-block">Back to Library</Link>
            </>
          )}
        </div>
      </div>
    );
  }

  const images = model.files.filter((f) => f.role === 'image');
  const parts = model.files.filter((f) => f.role === 'part');
  const filesByRole: Record<FileRole, ModelFileOut[]> = { part: [], image: [], doc: [], other: [] };
  for (const f of model.files) filesByRole[f.role].push(f);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.models.delete(model!.id);
      navigate('/library');
    } catch (err) {
      console.error('[ModelPage] Failed to delete model:', err);
      alert(`Couldn't delete model: ${err instanceof Error ? err.message : String(err)}`);
      setDeleting(false);
    }
  }

  async function handleDetach(assetId: string) {
    try {
      await detachFile(assetId);
    } catch (err) {
      console.error('[ModelPage] Failed to remove file:', err);
      alert(`Couldn't remove file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConfirmDetachId(null);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      await uploadFiles(files);
    } catch (err) {
      console.error('[ModelPage] Failed to upload files:', err);
      alert(`Couldn't upload: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function startEditDescription() {
    setDescDraft(model!.description ?? '');
    setEditingDescription(true);
  }

  async function saveDescription() {
    await update({ description: descDraft || null });
    setEditingDescription(false);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface">
      {/* Header */}
      <div className="px-5 py-4 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Link to="/library" className="text-xs text-gray-400 hover:text-accent inline-flex items-center gap-1 mb-1">
              <ChevronLeft size={12} /> Library
            </Link>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2 flex-wrap">
              {model.title}
              <button
                onClick={() => setEditOpen(true)}
                className="p-1 rounded text-gray-400 hover:text-accent hover:bg-gray-100 dark:hover:bg-gray-700"
                title="Edit details"
              >
                <Pencil size={14} />
              </button>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                  model.visibility === 'private'
                    ? 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                    : 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                }`}
              >
                {model.visibility === 'private' ? <Lock size={10} /> : <Globe size={10} />}
                {model.visibility}
              </span>
            </h1>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {model.tags.map((t) => <TagBadge key={t} tag={t} />)}
              {model.tags.length === 0 && (
                <span className="text-xs italic text-gray-300 dark:text-gray-600">No tags</span>
              )}
            </div>
          </div>

          <button
            onClick={() => setConfirmDeleteOpen(true)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0"
            title="Delete model"
          >
            <Trash2 size={15} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {(['overview', 'files', 'profiles'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                tab === t
                  ? 'bg-accent text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {t === 'files' ? `Files (${model.fileCount})` : t === 'profiles' ? `Profiles (${model.profiles.length})` : 'Overview'}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'overview' && (
          <div className="max-w-3xl space-y-6">
            <Gallery images={images} onExpand={setPreviewAsset} />
            <PartsQuickView parts={parts} onView={setPreviewAsset} />

            <div>
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Description</h2>
                {!editingDescription && (
                  <button onClick={startEditDescription} className="text-xs text-accent hover:underline flex items-center gap-1">
                    <Pencil size={11} /> Edit
                  </button>
                )}
              </div>
              {editingDescription ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    rows={8}
                    placeholder="Markdown supported: **bold**, *italic*, `code`, [links](url), lists, # headings"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                  />
                  <div className="flex gap-2">
                    <button onClick={saveDescription} className="px-3 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover">
                      Save
                    </button>
                    <button
                      onClick={() => setEditingDescription(false)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : model.description ? (
                renderMarkdown(model.description)
              ) : (
                <p className="text-sm italic text-gray-300 dark:text-gray-600">No description yet.</p>
              )}
            </div>

            {(model.sourceUrl || model.sourceAuthor || model.sourceSite || model.license) && (
              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5 border-t border-gray-100 dark:border-gray-700 pt-3">
                {model.sourceSite && <p>Source: {model.sourceSite}</p>}
                {model.sourceAuthor && <p>Author: {model.sourceAuthor}</p>}
                {model.sourceUrl && (
                  // sourceUrl is free text (Edit Details modal today;
                  // third-party import metadata once Phase C lands) --
                  // same untrusted-input class as a markdown link, so it
                  // gets the exact same scheme guard, not a second copy
                  // of the check. Kit's #2157 review caught this
                  // rendering unchecked (javascript: URLs landed as a
                  // real clickable anchor); see markdown.test.tsx-style
                  // regression coverage in ModelPage.test.tsx.
                  <p>
                    URL: {isSafeUrl(model.sourceUrl) ? (
                      <a href={model.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                        {model.sourceUrl}
                      </a>
                    ) : (
                      <span title="Unrecognized/unsafe URL scheme -- not rendered as a link">{model.sourceUrl}</span>
                    )}
                  </p>
                )}
                {model.license && <p>License: {model.license}</p>}
              </div>
            )}
          </div>
        )}

        {tab === 'files' && (
          <div className="max-w-3xl space-y-5">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Plus size={14} /> Attach from vault
              </button>
              <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
                <Plus size={14} /> {uploading ? 'Uploading…' : 'Upload files'}
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileUpload} disabled={uploading} />
              </label>
              <div className="flex-1" />
              {model.fileCount > 0 && (
                <a
                  href={api.models.downloadUrl(model.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <Download size={14} /> Download all (.zip)
                </a>
              )}
            </div>

            {model.fileCount === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                <p className="text-sm">No files attached yet.</p>
              </div>
            ) : (
              ROLE_ORDER.map((role) => filesByRole[role].length > 0 && (
                <div key={role}>
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
                    {ROLE_LABELS[role]}
                  </h3>
                  <div className="space-y-1">
                    {filesByRole[role].map((f) => (
                      <div key={f.assetId} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-2">
                        {getRoleIcon(f.role)}
                        <button
                          onClick={() => setPreviewAsset(f.asset)}
                          className="flex-1 min-w-0 text-left text-sm text-gray-900 dark:text-gray-100 truncate hover:text-accent"
                          title={f.asset.originalName || f.asset.filename}
                        >
                          {f.label || f.asset.originalName || f.asset.filename}
                        </button>
                        <span className="text-xs text-gray-400 flex-shrink-0">{formatSize(f.asset.size)}</span>
                        {f.role === 'image' && model.coverAssetId !== f.assetId && (
                          <button
                            onClick={() => setCover(f.assetId)}
                            className="text-xs text-gray-400 hover:text-accent flex-shrink-0"
                            title="Set as cover image"
                          >
                            Set cover
                          </button>
                        )}
                        {f.role === 'image' && model.coverAssetId === f.assetId && (
                          <span className="text-[10px] text-accent flex-shrink-0">Cover</span>
                        )}
                        <a
                          href={api.assets.fileUrl(f.asset)}
                          download={f.asset.filename}
                          className="p-1 rounded text-gray-400 hover:text-accent hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
                          title="Download"
                        >
                          <Download size={14} />
                        </a>
                        {confirmDetachId === f.assetId ? (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => handleDetach(f.assetId)} className="text-xs text-red-500 hover:underline">Remove</button>
                            <button onClick={() => setConfirmDetachId(null)} className="text-xs text-gray-400 hover:underline">Cancel</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDetachId(f.assetId)}
                            className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 flex-shrink-0"
                            title="Remove from model (file stays in vault)"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'profiles' && (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Print profiles</h2>
              <button
                onClick={() => { setEditingProfile(null); setProfileModalOpen(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Plus size={14} /> Add profile
              </button>
            </div>

            {model.profiles.length === 0 ? (
              <p className="text-sm italic text-gray-300 dark:text-gray-600">No print profiles yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
                      <th className="py-1.5 pr-3">Name</th>
                      <th className="py-1.5 pr-3">Printer</th>
                      <th className="py-1.5 pr-3">Material</th>
                      <th className="py-1.5 pr-3">Nozzle</th>
                      <th className="py-1.5 pr-3">Layer</th>
                      <th className="py-1.5 pr-3">Infill</th>
                      <th className="py-1.5 pr-3">Supports</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {model.profiles.map((p) => (
                      <tr key={p.id} className="border-b border-gray-100 dark:border-gray-800">
                        <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{p.name}</td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{p.printer || '—'}</td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{p.material || '—'}</td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{p.nozzle || '—'}</td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{p.layerHeight != null ? `${p.layerHeight} mm` : '—'}</td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{p.infill != null ? `${p.infill}%` : '—'}</td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{p.supports ? 'Yes' : 'No'}</td>
                        <td className="py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => { setEditingProfile(p); setProfileModalOpen(true); }}
                            className="p-1 rounded text-gray-400 hover:text-accent hover:bg-gray-100 dark:hover:bg-gray-700"
                            title="Edit profile"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => deleteProfile(p.id)}
                            className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                            title="Delete profile"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {previewAsset && (
        <ModelViewer
          asset={previewAsset}
          onClose={() => setPreviewAsset(null)}
          // Non-blocking note from Kit's #2157 review: this only updates
          // local previewAsset state (so the open modal reflects an
          // edit made inside it, e.g. rating/rename), not model.files --
          // a rename/rating change made here won't show in the Gallery
          // thumbnail strip or Files rows until the page refetches
          // (navigate away and back, or any other mutation that
          // triggers useModel's refresh). Low impact today; worth a
          // real fix (thread onUpdate through to update model.files
          // locally, or just call refresh()) if this starts mattering.
          onUpdate={(updated) => setPreviewAsset(updated)}
        />
      )}

      {pickerOpen && (
        <AssetPicker
          title="Attach files to model"
          existingAssetIds={new Set(model.files.map((f) => f.assetId))}
          onAdd={(assetIds) => attachExisting(assetIds)}
          onDone={() => setPickerOpen(false)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {editOpen && (
        <EditDetailsModal
          model={model}
          onSave={async (body) => { await update(body); setEditOpen(false); }}
          onClose={() => setEditOpen(false)}
        />
      )}

      {profileModalOpen && (
        <ProfileModal
          profile={editingProfile}
          onSave={async (body) => {
            if (editingProfile) await updateProfile(editingProfile.id, body as PrintProfileUpdateBody);
            else await createProfile(body as PrintProfileCreateBody);
            setProfileModalOpen(false);
          }}
          onClose={() => setProfileModalOpen(false)}
        />
      )}

      {confirmDeleteOpen && (
        <Modal title="Delete model?" onClose={() => setConfirmDeleteOpen(false)}>
          <div className="p-1 space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              This moves the model to trash — it hides it from the Library. The files it references stay in your vault untouched.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteOpen(false)}
                className="px-4 py-1.5 text-sm rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Delete model'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
