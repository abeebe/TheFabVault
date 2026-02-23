import { useState, useCallback } from 'react';
import { LogOut, Settings } from 'lucide-react';
import { Sidebar } from './components/Sidebar.js';
import { AssetGrid } from './components/AssetGrid.js';
import { SearchBar } from './components/SearchBar.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { UploadZone } from './components/UploadZone.js';
import { Spinner } from './components/Spinner.js';
import { Modal } from './components/Modal.js';
import { ProjectView } from './components/ProjectView.js';
import { AdminSettings } from './components/AdminSettings.js';
import { useAuth } from './hooks/useAuth.js';
import { useAssets } from './hooks/useAssets.js';
import { useFolders } from './hooks/useFolders.js';
import { useTheme } from './hooks/useTheme.js';
import { useProjects } from './hooks/useProjects.js';
import { api } from './lib/api.js';
import type { AssetOut } from './types/index.js';

// Category detection utilities
type Category = '3dprint' | 'laser' | 'vinyl';

function getAssetCategories(asset: AssetOut): Category[] {
  const categories: Category[] = [];

  const ext = asset.filename.split('.').pop()?.toLowerCase();

  // 3D files - automatic detection by extension
  if (['.stl', '.obj', '.3mf'].includes(`.${ext}`)) {
    categories.push('3dprint');
  }

  // Laser files - automatic detection by extension
  if (['.svg', '.dxf'].includes(`.${ext}`)) {
    categories.push('laser');
  }

  // Tags-based - manual assignment (additive, won't duplicate)
  if (asset.tags.includes('laser') && !categories.includes('laser')) categories.push('laser');
  if (asset.tags.includes('vinyl')) categories.push('vinyl');

  return categories;
}

function LoginPage({ onLogin }: { onLogin: (u: string, p: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onLogin(username, password);
    } catch {
      setError('Invalid username or password');
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-accent mx-auto mb-4 flex items-center justify-center">
            <span className="text-white text-xl font-bold">TFV</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">TheFabricatorsVault</h1>
          <p className="text-xs text-gray-400 mt-1 tracking-wide italic">Light it up &bull; Stick it on &bull; Print it out</p>
          <p className="text-sm text-gray-500 mt-3">Sign in to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-surface-2 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700 p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:bg-accent-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {loading && <Spinner size="sm" />}
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}

export function App() {
  const { isAuthenticated, checking, authRequired, login, logout } = useAuth();
  const { theme, cycleTheme } = useTheme();

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const PAGE_SIZE = 100;

  // New project modal
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);

  // Admin settings modal
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);

  const cleanParams = Object.fromEntries(
    Object.entries({
      q: searchQuery || undefined,
      tags: selectedTags.length ? selectedTags.join(',') : undefined,
      folder_id: selectedFolderId ?? undefined,
      limit: PAGE_SIZE,
      offset: currentPage * PAGE_SIZE,
    }).filter(([, v]) => v !== undefined)
  );

  const { assets, total, loading, refresh, updateAsset, removeAsset, addAssets } = useAssets(cleanParams);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { folders, createFolder, renameFolder, deleteFolder, refresh: refreshFolders } = useFolders();
  const { projects, refresh: refreshProjects, createProject } = useProjects();

  function handleTagToggle(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
    setCurrentPage(0);
  }

  function handleCategorySelect(category: Category | null) {
    if (category === selectedCategory) {
      setSelectedCategory(null);
    } else {
      setSelectedCategory(category);
      setSelectedFolderId(null);
      setSelectedTags([]);
      setSearchQuery('');
      setSelectedProjectId(null);
    }
    setCurrentPage(0);
  }

  // Filter assets by selected category
  const displayAssets = selectedCategory
    ? assets.filter(a => getAssetCategories(a).includes(selectedCategory))
    : assets;

  const handleUploaded = useCallback((newAssets: AssetOut[]) => {
    addAssets(newAssets);
  }, [addAssets]);

  function handleProjectSelect(id: string) {
    setSelectedProjectId(id);
    setSelectedFolderId(null);
    setSelectedTags([]);
    setSearchQuery('');
  }

  async function handleAddToProject(assetId: string, projectId: string) {
    try {
      await api.projects.addAssets(projectId, [assetId]);
      console.log(`[App] Asset ${assetId} added to project ${projectId}`);
      refreshProjects();
    } catch (err) {
      console.error('[App] Failed to add asset to project:', err);
    }
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const created = await createProject(name);
      setNewProjectOpen(false);
      setNewProjectName('');
      setSelectedProjectId(created.id);
    } finally {
      setCreatingProject(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (authRequired && !isAuthenticated) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      <Sidebar
        folders={folders}
        assets={assets}
        selectedFolderId={selectedFolderId}
        selectedTags={selectedTags}
        onFolderSelect={(id) => { setSelectedFolderId(id); setSelectedTags([]); setSelectedProjectId(null); setCurrentPage(0); }}
        onTagToggle={handleTagToggle}
        onFolderCreate={createFolder}
        onFolderRename={renameFolder}
        onFolderDelete={deleteFolder}
        onImportScan={() => { refresh(); refreshFolders(); }}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onProjectSelect={handleProjectSelect}
        onProjectCreate={() => setNewProjectOpen(true)}
        selectedCategory={selectedCategory}
        onCategorySelect={handleCategorySelect}
      />

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedProjectId ? (
          <ProjectView
            projectId={selectedProjectId}
            folders={folders}
            onDeleted={() => { setSelectedProjectId(null); refreshProjects(); }}
            onProjectUpdated={refreshProjects}
          />
        ) : (
          <>
            {/* Top bar */}
            <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
              <div className="flex-1 max-w-sm">
                <SearchBar value={searchQuery} onChange={(v) => { setSearchQuery(v); setCurrentPage(0); }} />
              </div>
              <div className="flex-1" />
              <UploadZone currentFolderId={selectedFolderId} onUploaded={handleUploaded} />
              <ThemeToggle theme={theme} onCycle={cycleTheme} />
              {authRequired && (
                <>
                  <button
                    onClick={() => setAdminSettingsOpen(true)}
                    title="Admin settings"
                    className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <Settings size={16} />
                  </button>
                  <button
                    onClick={logout}
                    title="Sign out"
                    className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <LogOut size={16} />
                  </button>
                </>
              )}
            </header>

            {/* Breadcrumb / context */}
            <div className="px-5 py-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 bg-surface border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
              <span
                className="hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer"
                onClick={() => { setSelectedFolderId(null); setSelectedTags([]); setSearchQuery(''); setSelectedCategory(null); setCurrentPage(0); }}
              >
                All Files
              </span>
              {selectedCategory && (
                <>
                  <span>/</span>
                  <span className="text-gray-900 dark:text-gray-100 font-medium">
                    {selectedCategory === '3dprint' ? '3D Print' : selectedCategory.charAt(0).toUpperCase() + selectedCategory.slice(1)}
                  </span>
                </>
              )}
              {selectedFolderId && (
                <>
                  <span>/</span>
                  <span className="text-gray-900 dark:text-gray-100 font-medium">
                    {folders.find((f) => f.id === selectedFolderId)?.name ?? 'Folder'}
                  </span>
                </>
              )}
              {selectedTags.length > 0 && (
                <>
                  <span>/</span>
                  <span className="text-gray-900 dark:text-gray-100 font-medium">
                    Tagged: {selectedTags.join(', ')}
                  </span>
                </>
              )}
              {searchQuery && (
                <>
                  <span>/</span>
                  <span className="text-gray-900 dark:text-gray-100 font-medium">
                    Search: &quot;{searchQuery}&quot;
                  </span>
                </>
              )}
              <div className="flex-1" />
              <span className="text-xs">{total} {total === 1 ? 'file' : 'files'}</span>
            </div>

            {/* Main content */}
            <div className="flex-1 overflow-y-auto p-5">
              <AssetGrid
                assets={displayAssets}
                folders={folders}
                loading={loading}
                onUpdate={updateAsset}
                onDelete={removeAsset}
                projects={projects}
                onAddToProject={handleAddToProject}
              />

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-6 pb-2">
                  <button
                    onClick={() => setCurrentPage(0)}
                    disabled={currentPage === 0}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    First
                  </button>
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Prev
                  </button>

                  {/* Page numbers */}
                  {Array.from({ length: totalPages }, (_, i) => i)
                    .filter(i => i === 0 || i === totalPages - 1 || Math.abs(i - currentPage) <= 2)
                    .reduce<(number | 'gap')[]>((acc, i, idx, arr) => {
                      if (idx > 0 && i - (arr[idx - 1] as number) > 1) acc.push('gap');
                      acc.push(i);
                      return acc;
                    }, [])
                    .map((item, idx) =>
                      item === 'gap' ? (
                        <span key={`gap-${idx}`} className="px-1 text-xs text-gray-400">…</span>
                      ) : (
                        <button
                          key={item}
                          onClick={() => setCurrentPage(item)}
                          className={`min-w-[2rem] px-2 py-1.5 text-xs rounded-lg border transition-colors ${
                            item === currentPage
                              ? 'bg-accent text-white border-accent font-medium'
                              : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {item + 1}
                        </button>
                      )
                    )}

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={currentPage >= totalPages - 1}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                  <button
                    onClick={() => setCurrentPage(totalPages - 1)}
                    disabled={currentPage >= totalPages - 1}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Last
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {/* New project modal */}
      {newProjectOpen && (
        <Modal title="New Project" onClose={() => { setNewProjectOpen(false); setNewProjectName(''); }}>
          <div className="p-1 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project name</label>
              <input
                autoFocus
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject(); }}
                placeholder="My awesome project"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setNewProjectOpen(false); setNewProjectName(''); }}
                className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim() || creatingProject}
                className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {creatingProject ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Admin settings modal */}
      <AdminSettings isOpen={adminSettingsOpen} onClose={() => setAdminSettingsOpen(false)} />
    </div>
  );
}
