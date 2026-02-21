import { useState, useCallback } from 'react';
import {
  ChevronDown, ChevronRight, Pencil, Trash2, Plus, FolderOpen, X,
} from 'lucide-react';
import { useProjectDetail } from '../hooks/useProjects.js';
import { AssetGrid } from './AssetGrid.js';
import { AssetOverridesModal } from './AssetOverridesModal.js';
import { TagInput } from './TagInput.js';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { PrinterSettingsForm, LaserSettingsForm, VinylSettingsForm } from './SettingsForm.js';
import type {
  FolderOut, ProjectAssetOut, ProjectOverrides,
  PrinterSettings, LaserSettings, VinylSettings,
} from '../types/index.js';
import { api } from '../lib/api.js';

type SettingsTab = 'printer' | 'laser' | 'vinyl';

interface Props {
  projectId: string;
  folders: FolderOut[];
  onDeleted: () => void;
  onProjectUpdated: () => void;
}

export function ProjectView({ projectId, folders, onDeleted, onProjectUpdated }: Props) {
  const { project, loading, refresh, removeAsset, updateOverrides } = useProjectDetail(projectId);

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
  }, [removeAsset]);

  const handleUpdateOverrides = useCallback(async (overrides: ProjectOverrides) => {
    if (!overridesAsset) return;
    await updateOverrides(overridesAsset.id, overrides);
    setOverridesAsset(null);
  }, [overridesAsset, updateOverrides]);

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
      </div>

      {/* Breadcrumb bar */}
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
            onUpdate={(updated) => {
              refresh();
            }}
            onDelete={handleRemoveAsset}
            projectMode
            onEditOverrides={(asset) => setOverridesAsset(asset as ProjectAssetOut)}
            projectAssetOverrides={Object.fromEntries(project.assets.map((a) => [a.id, a.overrides]))}
          />
        )}
      </div>

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

      {/* Overrides modal */}
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
    </div>
  );
}
