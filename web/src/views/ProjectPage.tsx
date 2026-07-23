import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { ProjectView } from '../components/ProjectView.js';
import { useFolders } from '../hooks/useFolders.js';

// Detail route for a single project (/projects/:id, #2182). A thin wrapper
// around the existing ProjectView -- the same component VaultPage's
// internal view-switch has always used to render a selected project, so
// admin behavior via /vault stays pixel-equivalent (VaultPage's own
// Projects sidebar section and its ProjectView instance are untouched by
// this ticket). All this wrapper adds is the routing plumbing ProjectView
// itself never needed when it only had one caller: reading :id from the
// URL, a back-to-list link (mirrors CollectionPage's), and folders (needed
// by ProjectView's AssetGrid instances for folder context/breadcrumbs --
// GET /folders is requireAuth, not admin-gated, so this is safe for
// members same as the Projects/Sets/Manifest routes ProjectView calls).
export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { folders } = useFolders();

  if (!id) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="text-center text-gray-500 dark:text-gray-400">
          <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Project not found</p>
          <Link to="/projects" className="text-xs text-accent hover:underline mt-1 inline-block">Back to Projects</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface">
      <div className="px-5 pt-3 flex-shrink-0">
        <Link to="/projects" className="text-xs text-gray-400 hover:text-accent inline-flex items-center gap-1">
          <ChevronLeft size={12} /> Projects
        </Link>
      </div>
      <div className="flex-1 min-h-0">
        <ProjectView
          projectId={id}
          folders={folders}
          onDeleted={() => navigate('/projects')}
          onProjectUpdated={() => {}}
        />
      </div>
    </div>
  );
}
