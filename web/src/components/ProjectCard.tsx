import { Link } from 'react-router-dom';
import { Layers } from 'lucide-react';
import type { ProjectOut } from '../types/index.js';

interface Props {
  project: ProjectOut;
}

// Project-level analog of CollectionCard.tsx -- same square-tile-plus-title
// grid tile, wired to /projects/:id instead of /collections/:id. Projects
// have no cover image (unlike Collections/Models, which resolve one
// server-side), so the tile always shows the Layers glyph + asset count --
// mirrors the icon Sidebar.tsx already uses for a project row (#2153/A-era),
// just at grid-tile scale instead of a nav-row scale. The manifest-percent
// badge is the same one Sidebar's project row shows (Reid's UX spec 4.2):
// present only once a build manifest exists and at least one part has been
// placed.
export function ProjectCard({ project }: Props) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="group relative flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-surface-2 hover:border-gray-300 dark:hover:border-gray-600 transition-all"
    >
      <div
        className="relative bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden rounded-t-xl"
        style={{ aspectRatio: '1' }}
      >
        <div className="flex flex-col items-center gap-2 text-gray-400 p-4">
          <Layers size={28} className="text-accent" />
          <span className="text-xs text-center">
            {project.assetCount} file{project.assetCount === 1 ? '' : 's'}
          </span>
        </div>
        {project.hasManifest && project.manifestPercent !== null && (
          <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/50 text-white text-[10px] font-medium">
            {project.manifestPercent}%
          </div>
        )}
      </div>

      <div className="flex flex-col p-3 gap-1 flex-1">
        <p
          className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-accent transition-colors"
          title={project.name}
        >
          {project.name}
        </p>
        <p className="text-xs text-gray-400">
          {project.assetCount} file{project.assetCount === 1 ? '' : 's'}
        </p>
      </div>
    </Link>
  );
}
