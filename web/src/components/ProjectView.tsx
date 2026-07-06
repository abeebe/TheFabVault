import { useState, useEffect, useCallback } from 'react';
import { Pencil, Trash2, Plus, FolderOpen, X } from 'lucide-react';
import { useProjectDetail } from '../hooks/useProjects.js';
import { useManifest } from '../hooks/useManifest.js';
import { AssetGrid } from './AssetGrid.js';
import { AssetOverridesModal } from './AssetOverridesModal.js';
import { AssetPicker } from './AssetPicker.js';
import { ManifestView } from './ManifestView.js';
import { AssignToSubAssemblyModal } from './AssignToSubAssemblyModal.js';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { PrinterSettingsForm, LaserSettingsForm, VinylSettingsForm } from './SettingsForm.js';
import type {
  FolderOut, ProjectAssetOut, ProjectOverrides,
  PrinterSettings, LaserSettings, VinylSettings,
} from '../types/index.js';
import { api } from '../lib/api.js';

type SettingsTab = 'printer' | 'laser' | 'vinyl';
type ContentTab = 'manifest' | 'ungrouped';

interface Props {
  projectId: string;
  folders: FolderOut[];
  onDeleted: () => void;
  onProjectUpdated: () => void;
}

export function ProjectView({ projectId, folders, onDeleted, onProjectUpdated }: Props) {
  const { project, loading, refresh, removeAsset, updateOverrides } = useProjectDetail(projectId);
  // One manifest fetch shared by both the Manifest tab and the Ungrouped
  // tab's "Add to sub-assembly" picker (Reid's UX spec, section 7 — the
  // whole tree loads once per project, not once per tab).
  const {
    manifest, loading: manifestLoading, error: manifestError, refresh: refreshManifest,
  } = useManifest(project?.hasManifest ? projectId : null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('printer');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState('');
  const [saving, setSaving] = useState(false);

  const [overridesAsset, setOverridesAsset] = useState<ProjectAssetOut | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addAssetMode, setAddAssetMode] = useState(false);
  const [contentTab, setContentTab] = useState<ContentTab>('manifest');
  const [assignTarget, setAssignTarget] = useState<string[] | null>(null); // ungrouped asset ids being assigned
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [creatingFirstSubAssembly, setCreatingFirstSubAssembly] = useState(false);
  const [firstSubAssemblyName, setFirstSubAssemblyName] = useState('');

  const bannerKey = `tfv-manifest-banner-dismissed-${projectId}`;
  useEffect(() => {
    try { setBannerDismissed(localStorage.getItem(bannerKey) === '1'); } catch { /* ignore */ }
  }, [bannerKey]);

  // Local settings copies for editing
  const [printerDraft, setPrinterDraft] = useState<PrinterSettings>({});
  const [laserDraft, setLaserDraft] = useState<LaserSettings>({});
  const [vinylDraft, setVinylDraft] = useState<VinylSettings>({});

  function openSettings() {
    if (!project) return;
    setPrinterDraft({ ...project.printerSettings });
    setLaserDraft({ ...project.laserSettings });
    setVinylDraft({ ...project.vinylSettings });
    setSettingsOpen(true);
  }

  async function saveSettings() {
    if (!project) return;
    setSaving(true);
    try {
      await api.projects.update(project.id, {
        printerSettings: printerDraft,
        laserSettings: laserDraft,
        vinylSettings: vinylDraft,
      });
      await refresh();
      onProjectUpdated();
      setSettingsOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function saveName() {
    if (!project || !nameValue.trim()) { setEditingName(false); return; }
    await api.projects.update(project.id, { name: nameValue.trim() });
    await refresh();
    onProjectUpdated();
    setEditingName(false);
  }

  async function saveDesc() {
    if (!project) { setEditingDesc(false); return; }
    await api.projects.update(project.id, { description: descValue || undefined });
    await refresh();
    setEditingDesc(false);
  }

  async function handleDelete() {
    if (!project) return;
    await api.projects.delete(project.id);
    onDeleted();
  }

  const handleRemoveAsset = useCallback(async (id: string) => {
    await removeAsset(id);
    onProjectUpdated();
  }, [removeAsset, onProjectUpdated]);

  // Ungrouped tab's own remove action: remove-from-project, with an
  // option to also trash the asset (reuses the existing deleted_at
  // soft-delete). Handles errant imports and folder-overlap dupes without
  // a manifest detour (PRD, "ungrouped pool has its own remove action").
  const handleTrashFromProject = useCallback(async (id: string) => {
    await removeAsset(id);
    try {
      await api.assets.delete(id);
    } catch (err) {
      console.error('[ProjectView] Failed to trash asset after removing from project:', err);
    }
    onProjectUpdated();
  }, [removeAsset, onProjectUpdated]);

  const handleUpdateOverrides = useCallback(async (overrides: ProjectOverrides) => {
    if (!overridesAsset) return;
    await updateOverrides(overridesAsset.id, overrides);
    setOverridesAsset(null);
  }, [overridesAsset, updateOverrides]);

  async function handleManifestChanged() {
    await refresh(); // project header (percent-printed, ungrouped count)
    onProjectUpdated(); // sidebar's per-project percent badge
  }

  async function handleAssignToSubAssembly(subAssemblyId: string) {
    if (!assignTarget) return;
    await api.manifest.addParts(subAssemblyId, assignTarget);
    setAssignTarget(null);
    await refresh();
    await refreshManifest();
    onProjectUpdated();
  }

  async function handleCreateFirstSubAssembly() {
    const name = firstSubAssemblyName.trim();
    if (!name || !project) return;
    await api.manifest.createSubAssembly(project.id, { name });
    setCreatingFirstSubAssembly(false);
    setFirstSubAssemblyName('');
    await refresh();
    await refreshManifest();
    onProjectUpdated();
  }

  function dismissBanner() {
    setBannerDismissed(true);
    try { localStorage.setItem(bannerKey, '1'); } catch { /* ignore */ }
  }

  if (loading || !project) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const settingsTabs: { id: SettingsTab; label: string }[] = [
    { id: 'printer', label: 'Printer' },
    { id: 'laser', label: 'Laser' },
    { id: 'vinyl', label: 'Vinyl' },
  ];

  // First-time enablement banner (Reid's UX spec, 4.13) — a project with
  // files but no manifest yet has no other way to discover this feature.
  // One-time dismiss per project, not permanently account-wide, since
  // this is a one-shot nudge, not a recurring notice.
  const showBanner = !project.hasManifest && project.assetCount > 0 && !bannerDismissed;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Project header */}
      <div className="px-5 py-4 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                autoFocus
                className="text-xl font-bold w-full bg-transparent border-b border-accent outline-none text-gray-900 dark:text-gray-100"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
              />
            ) : (
              <h2
                className="text-xl font-bold text-gray-900 dark:text-gray-100 cursor-pointer hover:text-accent flex items-center gap-2 group"
                onClick={() => { setNameValue(project.name); setEditingName(true); }}
              >
                {project.name}
                <Pencil size={14} className="opacity-0 group-hover:opacity-100 text-gray-400" />
              </h2>
            )}

            {editingDesc ? (
              <input
                autoFocus
                className="mt-1 text-sm w-full bg-transparent border-b border-accent outline-none text-gray-500 dark:text-gray-400"
                value={descValue}
                placeholder="Add a description…"
                onChange={(e) => setDescValue(e.target.value)}
                onBlur={saveDesc}
                onKeyDown={(e) => { if (e.key === 'Enter') saveDesc(); if (e.key === 'Escape') setEditingDesc(false); }}
              />
            ) : (
              <p
                className="mt-1 text-sm text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 group flex items-center gap-1"
                onClick={() => { setDescValue(project.description ?? ''); setEditingDesc(true); }}
              >
                {project.description || <span className="italic text-gray-300 dark:text-gray-600">Add description…</span>}
                <Pencil size={12} className="opacity-0 group-hover:opacity-100" />
              </p>
            )}

            <div className="mt-2 flex flex-wrap gap-1">
              {project.tags.map((tag) => (
                <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={openSettings}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Settings
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              title="Delete project"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {/* Settings summary */}
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-400">
          {project.printerSettings.material && (
            <span className="flex items-center gap-1">
              <span className="font-medium text-gray-600 dark:text-gray-300">Printer:</span>
              {project.printerSettings.material}
              {project.printerSettings.nozzleTemp && ` · ${project.printerSettings.nozzleTemp}°C`}
              {project.printerSettings.layerHeight && ` · ${project.printerSettings.layerHeight}mm`}
            </span>
          )}
          {project.laserSettings.material && (
            <span className="flex items-center gap-1">
              <span className="font-medium text-gray-600 dark:text-gray-300">Laser:</span>
              {project.laserSettings.material}
              {project.laserSettings.powerPercent && ` · ${project.laserSettings.powerPercent}%`}
            </span>
          )}
          {project.vinylSettings.material && (
            <span className="flex items-center gap-1">
              <span className="font-medium text-gray-600 dark:text-gray-300">Vinyl:</span>
              {project.vinylSettings.material}
            </span>
          )}
        </div>

        {/* Manifest summary line — only once a manifest exists. Kept,
            unmodified below this point for projects with zero
            sub_assemblies (PRD's "kept as-is" guarantee, made visually
            true, not just true in the database). */}
        {project.hasManifest && (
          <div className="mt-3 flex items-center gap-2">
            {project.manifestPercent === null ? (
              <>
                <div className="h-1.5 w-32 rounded-full bg-gray-100 dark:bg-gray-700 border border-dashed border-gray-300 dark:border-gray-600 flex-shrink-0" />
                <span className="text-xs text-gray-400">No parts placed yet</span>
              </>
            ) : (
              <>
                <div className="h-1.5 w-32 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden flex-shrink-0">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, project.manifestPercent)}%` }} />
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {project.manifestPercent}% printed
                  {project.assetCount > 0 && ` · ${project.assetCount} file${project.assetCount === 1 ? '' : 's'} still ungrouped`}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {project.hasManifest ? (
        <>
          {/* Tab strip */}
          <div className="px-5 pt-2 flex items-center gap-1 bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <button
              onClick={() => setContentTab('manifest')}
              className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                contentTab === 'manifest'
                  ? 'bg-accent text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              Manifest
            </button>
            <button
              onClick={() => setContentTab('ungrouped')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                contentTab === 'ungrouped'
                  ? 'bg-accent text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              Ungrouped
              <span className={`text-[10px] px-1.5 py-0 rounded-full ${contentTab === 'ungrouped' ? 'bg-white/20' : 'bg-gray-200 dark:bg-gray-600'}`}>
                {project.assetCount}
              </span>
            </button>
            <div className="flex-1" />
            <button
              onClick={() => setAddAssetMode(true)}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover pb-2"
            >
              <Plus size={13} /> Add files
            </button>
          </div>

          {contentTab === 'manifest' ? (
            <ManifestView
              project={project}
              manifest={manifest}
              loading={manifestLoading}
              error={manifestError}
              refresh={refreshManifest}
              onManifestChanged={handleManifestChanged}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-5">
              {project.assets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-gray-400">
                  <FolderOpen size={40} className="mb-3 opacity-30" />
                  <p className="text-sm">Everything is organized into the manifest.</p>
                </div>
              ) : (
                <AssetGrid
                  assets={project.assets}
                  folders={folders}
                  loading={false}
                  onUpdate={() => refresh()}
                  onDelete={handleRemoveAsset}
                  onTrashFromProject={handleTrashFromProject}
                  projectMode
                  onEditOverrides={(asset) => setOverridesAsset(asset as ProjectAssetOut)}
                  projectAssetOverrides={Object.fromEntries(project.assets.map((a) => [a.id, a.overrides]))}
                  subAssemblies={manifest?.subAssemblies ?? []}
                  onOpenAssignToSubAssembly={(assetIds) => setAssignTarget(assetIds)}
                />
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Breadcrumb bar — unchanged from the pre-manifest flat path */}
          <div className="px-5 py-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <span className="text-gray-900 dark:text-gray-100 font-medium">{project.name}</span>
            <div className="flex-1" />
            <span className="text-xs">{project.assetCount} {project.assetCount === 1 ? 'file' : 'files'}</span>
            <button
              onClick={() => setAddAssetMode(true)}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover"
            >
              <Plus size={13} />
              Add files
            </button>
          </div>

          {showBanner && (
            <div className="mx-5 mt-3 flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-accent/10 border border-accent/30 flex-shrink-0">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                This project has {project.assetCount} file{project.assetCount === 1 ? '' : 's'}. Break it into sub-assemblies to track build progress by section.
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setCreatingFirstSubAssembly(true)}
                  className="px-3 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover whitespace-nowrap"
                >
                  Create first sub-assembly
                </button>
                <button onClick={dismissBanner} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Asset grid */}
          <div className="flex-1 overflow-y-auto p-5">
            {project.assets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-gray-400">
                <FolderOpen size={40} className="mb-3 opacity-30" />
                <p className="text-sm">No files in this project yet.</p>
                <button
                  onClick={() => setAddAssetMode(true)}
                  className="mt-3 text-sm text-accent hover:text-accent-hover"
                >
                  Add files from vault
                </button>
              </div>
            ) : (
              <AssetGrid
                assets={project.assets}
                folders={folders}
                loading={false}
                onUpdate={() => refresh()}
                onDelete={handleRemoveAsset}
                onTrashFromProject={handleTrashFromProject}
                projectMode
                onEditOverrides={(asset) => setOverridesAsset(asset as ProjectAssetOut)}
                projectAssetOverrides={Object.fromEntries(project.assets.map((a) => [a.id, a.overrides]))}
              />
            )}
          </div>
        </>
      )}

      {/* Settings modal */}
      {settingsOpen && (
        <Modal title="Project Settings" onClose={() => setSettingsOpen(false)} wide>
          <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-700">
            {settingsTabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setSettingsTab(t.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                  settingsTab === t.id
                    ? 'bg-accent text-white'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="min-h-[300px]">
            {settingsTab === 'printer' && <PrinterSettingsForm settings={printerDraft} onChange={setPrinterDraft} />}
            {settingsTab === 'laser' && <LaserSettingsForm settings={laserDraft} onChange={setLaserDraft} />}
            {settingsTab === 'vinyl' && <VinylSettingsForm settings={vinylDraft} onChange={setVinylDraft} />}
          </div>

          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button onClick={() => setSettingsOpen(false)} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              onClick={saveSettings}
              disabled={saving}
              className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </Modal>
      )}

      {/* Overrides modal (flat/Ungrouped-tab assets) */}
      {overridesAsset && project && (
        <AssetOverridesModal
          project={project}
          asset={overridesAsset}
          onSave={handleUpdateOverrides}
          onClose={() => setOverridesAsset(null)}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <Modal title="Delete project?" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            This will delete the project and all its settings. Files in the vault are not deleted.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              onClick={handleDelete}
              className="px-4 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600"
            >
              Delete project
            </button>
          </div>
        </Modal>
      )}

      {/* Add assets picker */}
      {addAssetMode && project && (
        <AssetPicker
          existingAssetIds={new Set(project.assets.map((a) => a.id))}
          onAdd={(ids) => api.projects.addAssets(project.id, ids)}
          onDone={() => { setAddAssetMode(false); refresh(); onProjectUpdated(); }}
          onClose={() => setAddAssetMode(false)}
        />
      )}

      {/* Assign-to-sub-assembly modal, triggered from the Ungrouped tab */}
      {assignTarget && (
        <AssignToSubAssemblyModal
          subAssemblies={manifest?.subAssemblies ?? []}
          assetCount={assignTarget.length}
          onClose={() => setAssignTarget(null)}
          onAssign={handleAssignToSubAssembly}
        />
      )}

      {/* First sub-assembly creation, triggered from the enablement banner */}
      {creatingFirstSubAssembly && (
        <Modal title="Create first sub-assembly" onClose={() => setCreatingFirstSubAssembly(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sub-assembly name</label>
              <input
                autoFocus
                value={firstSubAssemblyName}
                onChange={(e) => setFirstSubAssemblyName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFirstSubAssembly(); }}
                placeholder="e.g. Right Foot"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreatingFirstSubAssembly(false)} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                onClick={handleCreateFirstSubAssembly}
                disabled={!firstSubAssemblyName.trim()}
                className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
              >
                Create
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
