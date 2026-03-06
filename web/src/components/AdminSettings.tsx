import { useState, useEffect } from 'react';
import {
  X, AlertCircle, CheckCircle, Loader,
  HardDrive, Wifi, WifiOff, Plus, Trash2, RefreshCw, Database, Copy,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { DuplicatesModal } from './DuplicatesModal.js';
import { OrphansModal } from './OrphansModal.js';
import type { AdminConfig, MountSlotStatus } from '../types/index.js';

interface AdminSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

interface MountForm {
  slot: 1 | 2 | 3;
  name: string;
  type: 'nfs' | 'smb';
  host: string;
  remote_path: string;
  username: string;
  password: string;
  mount_opts: string;
  enabled: boolean;
  role: 'import' | 'library';
}

const DEFAULT_FORM: MountForm = {
  slot: 1,
  name: '',
  type: 'nfs',
  host: '',
  remote_path: '',
  username: '',
  password: '',
  mount_opts: '',
  enabled: true,
  role: 'import',
};

export function AdminSettings({ isOpen, onClose }: AdminSettingsProps) {
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [showConfirmPath, setShowConfirmPath] = useState(false);
  const [showConfirmRestart, setShowConfirmRestart] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [deletedFromDupes, setDeletedFromDupes] = useState<string[]>([]);
  const [orphansOpen, setOrphansOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // ─── Mount state ───────────────────────────────────────────────────────────
  const [mounts, setMounts] = useState<MountSlotStatus[]>([]);
  const [mountsLoading, setMountsLoading] = useState(false);
  const [editingSlot, setEditingSlot] = useState<1 | 2 | 3 | null>(null);
  const [mountForm, setMountForm] = useState<MountForm>(DEFAULT_FORM);
  const [isSavingMount, setIsSavingMount] = useState(false);
  const [mountingSlot, setMountingSlot] = useState<number | null>(null);
  const [deletingSlot, setDeletingSlot] = useState<number | null>(null);
  const [showConfirmDeleteSlot, setShowConfirmDeleteSlot] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen && !config) {
      loadConfig();
      loadMounts();
    }
  }, [isOpen, config]);

  async function loadConfig() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.admin.getConfig();
      setConfig(data);
      setNewPath(data.storagePath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }

  async function loadMounts() {
    setMountsLoading(true);
    try {
      const data = await api.mounts.list();
      setMounts(data);
    } catch {
      // Non-fatal — mounts panel will show empty
    } finally {
      setMountsLoading(false);
    }
  }

  async function handleUpdateStoragePath() {
    if (!newPath.trim()) {
      setError('Storage path cannot be empty');
      return;
    }

    setIsUpdating(true);
    setError(null);
    try {
      await api.admin.updateStoragePath(newPath);
      setSuccessMessage('Storage path updated successfully');
      setShowConfirmPath(false);
      setTimeout(() => {
        loadConfig();
        setSuccessMessage(null);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update storage path');
    } finally {
      setIsUpdating(false);
    }
  }

  async function handleRestart() {
    setIsRestarting(true);
    setError(null);
    try {
      await api.admin.restart();
      setSuccessMessage('Restart signal sent. Application will restart shortly...');
      setShowConfirmRestart(false);
      setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send restart signal');
      setIsRestarting(false);
    }
  }

  // ─── Mount actions ─────────────────────────────────────────────────────────

  function openAddMount(slot: 1 | 2 | 3) {
    const existing = mounts.find((m) => m.slot === slot);
    if (existing?.config) {
      setMountForm({
        slot,
        name: existing.config.name,
        type: existing.config.type,
        host: existing.config.host,
        remote_path: existing.config.remote_path,
        username: existing.config.username ?? '',
        password: existing.config.password ?? '',
        mount_opts: existing.config.mount_opts ?? '',
        enabled: existing.config.enabled === 1,
        role: existing.config.role ?? 'import',
      });
    } else {
      setMountForm({ ...DEFAULT_FORM, slot });
    }
    setEditingSlot(slot);
  }

  async function handleSaveMount() {
    if (!mountForm.name.trim() || !mountForm.host.trim() || !mountForm.remote_path.trim()) {
      setError('Name, host, and remote path are required');
      return;
    }
    setIsSavingMount(true);
    setError(null);
    try {
      await api.mounts.save({
        slot: mountForm.slot,
        name: mountForm.name.trim(),
        type: mountForm.type,
        host: mountForm.host.trim(),
        remote_path: mountForm.remote_path.trim(),
        username: mountForm.username.trim() || undefined,
        password: mountForm.password.trim() || undefined,
        mount_opts: mountForm.mount_opts.trim() || undefined,
        enabled: mountForm.enabled,
        role: mountForm.role,
      });
      setEditingSlot(null);
      await loadMounts();
      // If role changed to/from library, storage path has changed — reload config
      if (mountForm.role === 'library') {
        await loadConfig();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mount config');
    } finally {
      setIsSavingMount(false);
    }
  }

  async function handleToggleMount(slot: 1 | 2 | 3, currentlyMounted: boolean) {
    setMountingSlot(slot);
    setError(null);
    try {
      if (currentlyMounted) {
        await api.mounts.unmount(slot);
      } else {
        await api.mounts.mount(slot);
      }
      await loadMounts();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to ${currentlyMounted ? 'unmount' : 'mount'} slot ${slot}`,
      );
    } finally {
      setMountingSlot(null);
    }
  }

  async function handleDeleteMount(slot: 1 | 2 | 3) {
    setDeletingSlot(slot);
    setError(null);
    try {
      await api.mounts.delete(slot);
      setShowConfirmDeleteSlot(null);
      await loadMounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete mount config');
    } finally {
      setDeletingSlot(null);
    }
  }

  const percentUsed = config
    ? Math.round((config.storage.total / (1024 * 1024 * 1024)) * 100)
    : 0;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Admin Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-6 space-y-6">
          {/* Error */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex gap-3">
              <AlertCircle size={20} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          {/* Success */}
          {successMessage && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 flex gap-3">
              <CheckCircle size={20} className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-700 dark:text-green-300">{successMessage}</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader size={24} className="animate-spin text-accent" />
            </div>
          )}

          {!loading && config && (
            <>
              {/* ── Storage Information ─────────────────────────────────────── */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Storage Information</h3>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Container Storage Path
                  </label>
                  <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg font-mono break-all">
                    {config.storagePath}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Maps to{' '}
                    <span className="font-mono font-medium text-gray-700 dark:text-gray-300">
                      ~/TheFabVault/data/storage
                    </span>{' '}
                    on the host via Docker volume mount.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Container Database Path
                  </label>
                  <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg font-mono break-all">
                    {config.dataDirPath}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Maps to{' '}
                    <span className="font-mono font-medium text-gray-700 dark:text-gray-300">
                      ~/TheFabVault/data/db
                    </span>{' '}
                    on the host via Docker volume mount.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Storage Usage
                  </label>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-600 dark:text-gray-400">
                        Total: {config.storage.totalFormatted} ({config.storage.assetCount} files)
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-accent h-2 rounded-full transition-all"
                        style={{ width: `${Math.min(percentUsed, 100)}%` }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="bg-gray-50 dark:bg-gray-700 p-2 rounded">
                        <p className="text-gray-600 dark:text-gray-400">Assets</p>
                        <p className="font-semibold text-gray-900 dark:text-white">
                          {config.storage.assetsFormatted}
                        </p>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-700 p-2 rounded">
                        <p className="text-gray-600 dark:text-gray-400">Thumbnails</p>
                        <p className="font-semibold text-gray-900 dark:text-white">
                          {config.storage.thumbnailsFormatted}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Change Storage Location ─────────────────────────────────── */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-gray-900 dark:text-white">Change Storage Location</h3>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    New Storage Path
                  </label>
                  <input
                    type="text"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder="/path/to/storage"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    This is the path <em>inside the container</em>. To persist data, make sure the
                    path is covered by a Docker volume mount in your{' '}
                    <span className="font-mono">docker-compose.yml</span>.
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => setShowConfirmPath(true)}
                    disabled={newPath === config.storagePath || !newPath.trim()}
                    className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Update Path
                  </button>
                  {newPath !== config.storagePath && (
                    <button
                      onClick={() => setNewPath(config.storagePath)}
                      className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              {/* ── Network Mounts ──────────────────────────────────────────── */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900 dark:text-white">Network Mounts</h3>
                  <button
                    onClick={loadMounts}
                    disabled={mountsLoading}
                    title="Refresh mount status"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  >
                    <RefreshCw
                      size={15}
                      className={`text-gray-500 ${mountsLoading ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Connect NFS or SMB/CIFS shares directly from the UI. Mounted shares are
                  automatically scanned for new files on startup. Requires{' '}
                  <span className="font-mono">cap_add: [SYS_ADMIN]</span> in{' '}
                  <span className="font-mono">docker-compose.yml</span>.
                </p>

                <div className="space-y-3">
                  {mountsLoading && mounts.length === 0 ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader size={20} className="animate-spin text-accent" />
                    </div>
                  ) : (
                    ([1, 2, 3] as const).map((slot) => {
                      const slotData = mounts.find((m) => m.slot === slot);
                      const cfg = slotData?.config ?? null;
                      const mounted = slotData?.mounted ?? false;
                      const isWorking = mountingSlot === slot;

                      return (
                        <div
                          key={slot}
                          className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
                        >
                          {/* Slot header row */}
                          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-700/50">
                            <div className="flex items-center gap-2">
                              <HardDrive size={15} className="text-gray-500" />
                              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                Slot {slot}
                              </span>
                              {cfg && (
                                <span className="text-xs bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded font-mono uppercase">
                                  {cfg.type}
                                </span>
                              )}
                              {cfg?.role === 'library' && (
                                <span className="flex items-center gap-1 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded font-medium">
                                  <Database size={11} /> Library
                                </span>
                              )}
                              {cfg &&
                                (mounted ? (
                                  <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                    <Wifi size={12} /> Mounted
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                                    <WifiOff size={12} /> Unmounted
                                  </span>
                                ))}
                            </div>

                            <div className="flex items-center gap-1">
                              {cfg ? (
                                <>
                                  <button
                                    onClick={() => handleToggleMount(slot, mounted)}
                                    disabled={isWorking}
                                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${
                                      mounted
                                        ? 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500'
                                        : 'bg-green-600 text-white hover:bg-green-700'
                                    }`}
                                  >
                                    {isWorking ? (
                                      <Loader size={12} className="animate-spin" />
                                    ) : mounted ? (
                                      'Unmount'
                                    ) : (
                                      'Mount'
                                    )}
                                  </button>
                                  <button
                                    onClick={() => openAddMount(slot)}
                                    className="px-2.5 py-1 text-xs font-medium rounded-md bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => setShowConfirmDeleteSlot(slot)}
                                    title="Remove mount config"
                                    className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => openAddMount(slot)}
                                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
                                >
                                  <Plus size={12} /> Configure
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Share address (when configured) */}
                          {cfg && editingSlot !== slot && (
                            <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 font-mono bg-white dark:bg-gray-800">
                              {cfg.type === 'nfs'
                                ? `${cfg.host}:${cfg.remote_path}`
                                : `//${cfg.host}/${cfg.remote_path}`}
                            </div>
                          )}

                          {/* Inline edit / add form */}
                          {editingSlot === slot && (
                            <div className="px-4 pb-4 pt-3 space-y-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                              <div className="grid grid-cols-2 gap-3">
                                {/* Name */}
                                <div className="col-span-2 space-y-1">
                                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                    Name
                                  </label>
                                  <input
                                    type="text"
                                    value={mountForm.name}
                                    onChange={(e) =>
                                      setMountForm((f) => ({ ...f, name: e.target.value }))
                                    }
                                    placeholder="My NAS Share"
                                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                  />
                                </div>

                                {/* Type */}
                                <div className="space-y-1">
                                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                    Type
                                  </label>
                                  <select
                                    value={mountForm.type}
                                    onChange={(e) =>
                                      setMountForm((f) => ({
                                        ...f,
                                        type: e.target.value as 'nfs' | 'smb',
                                      }))
                                    }
                                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                  >
                                    <option value="nfs">NFS</option>
                                    <option value="smb">SMB / CIFS</option>
                                  </select>
                                </div>

                                {/* Host */}
                                <div className="space-y-1">
                                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                    Host / IP
                                  </label>
                                  <input
                                    type="text"
                                    value={mountForm.host}
                                    onChange={(e) =>
                                      setMountForm((f) => ({ ...f, host: e.target.value }))
                                    }
                                    placeholder="192.168.1.100"
                                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                  />
                                </div>

                                {/* Remote path */}
                                <div className="col-span-2 space-y-1">
                                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                    {mountForm.type === 'nfs'
                                      ? 'Export Path (e.g. /mnt/tank/3d-prints)'
                                      : 'Share Name (e.g. media/3d-prints)'}
                                  </label>
                                  <input
                                    type="text"
                                    value={mountForm.remote_path}
                                    onChange={(e) =>
                                      setMountForm((f) => ({ ...f, remote_path: e.target.value }))
                                    }
                                    placeholder={
                                      mountForm.type === 'nfs'
                                        ? '/mnt/tank/3d-prints'
                                        : 'media/3d-prints'
                                    }
                                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                  />
                                </div>

                                {/* SMB credentials */}
                                {mountForm.type === 'smb' && (
                                  <>
                                    <div className="space-y-1">
                                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                        Username
                                      </label>
                                      <input
                                        type="text"
                                        value={mountForm.username}
                                        onChange={(e) =>
                                          setMountForm((f) => ({
                                            ...f,
                                            username: e.target.value,
                                          }))
                                        }
                                        placeholder="guest"
                                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                        Password
                                      </label>
                                      <input
                                        type="password"
                                        value={mountForm.password}
                                        onChange={(e) =>
                                          setMountForm((f) => ({
                                            ...f,
                                            password: e.target.value,
                                          }))
                                        }
                                        placeholder="leave blank for guest"
                                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                      />
                                    </div>
                                  </>
                                )}

                                {/* Extra options */}
                                <div className="col-span-2 space-y-1">
                                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                                    Extra Mount Options{' '}
                                    <span className="text-gray-400 font-normal">(optional)</span>
                                  </label>
                                  <input
                                    type="text"
                                    value={mountForm.mount_opts}
                                    onChange={(e) =>
                                      setMountForm((f) => ({ ...f, mount_opts: e.target.value }))
                                    }
                                    placeholder={
                                      mountForm.type === 'nfs' ? 'nfsvers=3' : 'vers=2.0'
                                    }
                                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                                  />
                                </div>

                                {/* Role: Use as Library */}
                                <div className="col-span-2 pt-1">
                                  <label className="flex items-start gap-2.5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={mountForm.role === 'library'}
                                      onChange={(e) =>
                                        setMountForm((f) => ({
                                          ...f,
                                          role: e.target.checked ? 'library' : 'import',
                                        }))
                                      }
                                      className="mt-0.5 accent-accent"
                                    />
                                    <div>
                                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1">
                                        <Database size={11} /> Use as Library (primary storage)
                                      </span>
                                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                        Assets will be stored on this share instead of local storage.
                                        Mounted read-write. Only one slot can be the library at a time.
                                      </p>
                                    </div>
                                  </label>
                                  {mountForm.role === 'library' && (
                                    <div className="mt-2 flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-md p-2.5 text-xs text-amber-700 dark:text-amber-300">
                                      <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                                      <span>
                                        A <strong>restart</strong> is required after saving for the
                                        new storage location to take effect.
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex gap-2 pt-1">
                                <button
                                  onClick={handleSaveMount}
                                  disabled={isSavingMount}
                                  className="px-3 py-1.5 bg-accent text-white text-sm font-medium rounded-md hover:bg-accent/90 disabled:opacity-50 transition-colors"
                                >
                                  {isSavingMount ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  onClick={() => setEditingSlot(null)}
                                  className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ── Library Tools ───────────────────────────────────────────── */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-gray-900 dark:text-white">Library Tools</h3>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setDuplicatesOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <Copy size={15} /> Find Duplicate Files
                  </button>
                  <button
                    onClick={() => setOrphansOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <Database size={15} /> Detect Orphans
                  </button>
                </div>
              </div>

              {/* ── Application Control ─────────────────────────────────────── */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-gray-900 dark:text-white">Application Control</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Restart the application to apply changes or for maintenance.
                </p>
                <button
                  onClick={() => setShowConfirmRestart(true)}
                  disabled={isRestarting}
                  className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isRestarting ? 'Restarting...' : 'Restart Application'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Confirm Storage Path Dialog ───────────────────────────────────── */}
        {showConfirmPath && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                Confirm Storage Path Change
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Are you sure you want to change the storage location to:
              </p>
              <p className="text-sm font-mono bg-gray-50 dark:bg-gray-700 p-3 rounded-lg break-all text-gray-900 dark:text-white">
                {newPath}
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg">
                ⚠️ Existing files will not be automatically moved. You may need to migrate files
                manually or run an import scan.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirmPath(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateStoragePath}
                  disabled={isUpdating}
                  className="flex-1 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isUpdating ? 'Updating...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Confirm Restart Dialog ────────────────────────────────────────── */}
        {showConfirmRestart && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                Confirm Application Restart
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                The application will restart shortly. You may experience a brief interruption in
                service.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                It may take a few seconds for the application to become available again.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirmRestart(false)}
                  disabled={isRestarting}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRestart}
                  disabled={isRestarting}
                  className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isRestarting ? 'Restarting...' : 'Restart'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Confirm Delete Mount Dialog ───────────────────────────────────── */}
        {showConfirmDeleteSlot !== null && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 dark:text-white">Remove Mount Config</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This will remove the configuration for Slot {showConfirmDeleteSlot} and unmount
                the share if it is currently active.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirmDeleteSlot(null)}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteMount(showConfirmDeleteSlot as 1 | 2 | 3)}
                  disabled={deletingSlot !== null}
                  className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {deletingSlot !== null ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {duplicatesOpen && (
        <DuplicatesModal
          onClose={() => setDuplicatesOpen(false)}
          onDeleted={(id) => setDeletedFromDupes((prev) => [...prev, id])}
        />
      )}

      <OrphansModal
        isOpen={orphansOpen}
        onClose={() => setOrphansOpen(false)}
      />
    </div>
  );
}
