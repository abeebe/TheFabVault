import { useState, useEffect } from 'react';
import { X, AlertCircle, CheckCircle, Loader } from 'lucide-react';
import { api } from '../lib/api.js';
import type { AdminConfig } from '../types/index.js';

interface AdminSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AdminSettings({ isOpen, onClose }: AdminSettingsProps) {
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [showConfirmPath, setShowConfirmPath] = useState(false);
  const [showConfirmRestart, setShowConfirmRestart] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !config) {
      loadConfig();
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
      // Close after a delay to show success message
      setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send restart signal');
      setIsRestarting(false);
    }
  }

  const percentUsed = config ? Math.round((config.storage.total / (1024 * 1024 * 1024)) * 100) : 0; // Approximate for display

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
          {/* Error Message */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex gap-3">
              <AlertCircle size={20} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          {/* Success Message */}
          {successMessage && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 flex gap-3">
              <CheckCircle size={20} className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-700 dark:text-green-300">{successMessage}</p>
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader size={24} className="animate-spin text-accent" />
            </div>
          )}

          {/* Config Content */}
          {!loading && config && (
            <>
              {/* Storage Information */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Storage Information</h3>

                {/* Current Path */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Current Storage Path
                  </label>
                  <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg font-mono break-all">
                    {config.storagePath}
                  </p>
                </div>

                {/* Storage Usage */}
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

              {/* Storage Path Configuration */}
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
                    Enter an absolute path where application has read/write access. The path will be created if it doesn't exist.
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

              {/* Restart */}
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

        {/* Confirm Path Dialog */}
        {showConfirmPath && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 dark:text-white">Confirm Storage Path Change</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Are you sure you want to change the storage location to:
              </p>
              <p className="text-sm font-mono bg-gray-50 dark:bg-gray-700 p-3 rounded-lg break-all text-gray-900 dark:text-white">
                {newPath}
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg">
                ⚠️ Existing files will not be automatically moved. You may need to migrate files manually or run an import scan.
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

        {/* Confirm Restart Dialog */}
        {showConfirmRestart && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 dark:text-white">Confirm Application Restart</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                The application will restart shortly. You may experience a brief interruption in service.
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
      </div>
    </div>
  );
}
