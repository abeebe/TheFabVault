import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useProjects } from '../hooks/useProjects.js';
import { ProjectCard } from '../components/ProjectCard.js';
import { Modal } from '../components/Modal.js';
import { Spinner } from '../components/Spinner.js';

// Projects list landing -- the /projects route (#2182). Member-reachable:
// this is deliberately a NEW page, not a move of VaultPage's Projects
// sidebar section, because that section is embedded inside VaultPage's own
// state (selectedProjectId, the New Project modal, the sidebar drag-drop
// wiring) and VaultPage as a whole stays admin-only behind RequireAdmin --
// see AppShell.tsx's routing comment. Before this ticket, ProjectView (the
// actual project detail UI) was reachable ONLY by first landing on /vault
// and clicking a project in the sidebar, which is exactly why Projects had
// no member-reachable route at all. This page — plus ProjectPage.tsx for
// the detail route — gives Projects its own entry point that doesn't
// depend on Vault being visible, mirroring the CollectionsPage/CollectionPage
// split (list route + :id detail route) rather than inventing a new
// routing shape.
//
// Deliberately a plain grid, same scope discipline CollectionsPage's
// comment calls out: no search/sort here unless a future ticket asks for
// it (Projects today is a handful of items per vault, not a discovery
// surface like Browse).
export function ProjectsPage() {
  const navigate = useNavigate();
  const { projects, loading, createProject } = useProjects();

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createProject(name);
      navigate(`/projects/${created.id}`);
    } catch (err) {
      console.error('[ProjectsPage] Failed to create project:', err);
      alert(`Couldn't create project: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Projects</span>
        <span className="text-xs text-gray-400">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span>
        <div className="flex-1" />
        <button
          onClick={() => setNewOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} /> New project
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <p className="text-lg font-medium">No projects yet</p>
            <p className="text-sm mt-1">Create a project to start organizing a build.</p>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}
      </div>

      {newOpen && (
        <Modal title="New Project" onClose={() => { setNewOpen(false); setNewName(''); }}>
          <div className="p-1 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project name</label>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                placeholder="My awesome project"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setNewOpen(false); setNewName(''); }}
                className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {creating ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
