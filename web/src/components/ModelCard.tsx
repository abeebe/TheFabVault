import { Link } from 'react-router-dom';
import { FileBox, Lock } from 'lucide-react';
import { api } from '../lib/api.js';
import type { ModelOut } from '../lib/api.js';

interface ModelCardProps {
  model: ModelOut;
}

// Thumbnail/hover treatment lifted from AssetCard (same square tile,
// same border/hover-ring pattern) but deliberately not a fork of it --
// AssetCard is 543 LOC of asset-specific affordances (inline
// rename/tag-editing, drag-and-drop, move-to-folder, rethumb, per-project
// context menus...) that a model card has no use for. This is the small
// subset that's actually shared: a square cover tile + title, wired to
// navigate to the model's detail page instead of opening a preview modal.
export function ModelCard({ model }: ModelCardProps) {
  const thumbUrl = api.models.coverThumbUrl(model);

  return (
    <Link
      to={`/models/${model.id}`}
      className="group relative flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-surface-2 hover:border-gray-300 dark:hover:border-gray-600 transition-all"
    >
      {model.visibility === 'private' && (
        <div
          className="absolute top-2 right-2 z-10 p-1 rounded bg-black/40 text-white"
          title="Private"
        >
          <Lock size={12} />
        </div>
      )}

      <div
        className="relative bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden rounded-t-xl"
        style={{ aspectRatio: '1' }}
      >
        {thumbUrl ? (
          <img src={thumbUrl} alt={model.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-400 p-4">
            <FileBox size={28} className="text-blue-400" />
            <span className="text-xs text-center">
              {model.fileCount} file{model.fileCount === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col p-3 gap-1 flex-1">
        <p
          className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-accent transition-colors"
          title={model.title}
        >
          {model.title}
        </p>
        <div className="flex items-center justify-between gap-1">
          <p className="text-xs text-gray-400">
            {model.fileCount} file{model.fileCount === 1 ? '' : 's'}
          </p>
          {model.tags.length > 0 && (
            <p className="text-xs text-gray-400 truncate">
              {model.tags[0]}{model.tags.length > 1 ? ` +${model.tags.length - 1}` : ''}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
