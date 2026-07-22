import { Link } from 'react-router-dom';
import { Layers, Lock } from 'lucide-react';
import { api } from '../lib/api.js';
import type { CollectionOut } from '../lib/api.js';

interface Props {
  collection: CollectionOut;
}

// Collection-level analog of ModelCard.tsx -- same square-tile-plus-title
// tile, wired to /collections/:id instead of /models/:id, and showing
// modelCount instead of fileCount. Cover comes from
// api.collections.coverThumbUrl (cover_model_id's own cover, or the
// first member with a usable thumb, resolved server-side -- see
// routes/collections.ts#resolveCollectionCoverThumb).
export function CollectionCard({ collection }: Props) {
  const thumbUrl = api.collections.coverThumbUrl(collection);

  return (
    <Link
      to={`/collections/${collection.id}`}
      className="group relative flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-surface-2 hover:border-gray-300 dark:hover:border-gray-600 transition-all"
    >
      {collection.visibility === 'private' && (
        <div className="absolute top-2 right-2 z-10 p-1 rounded bg-black/40 text-white" title="Private">
          <Lock size={12} />
        </div>
      )}

      <div
        className="relative bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden rounded-t-xl"
        style={{ aspectRatio: '1' }}
      >
        {thumbUrl ? (
          <img src={thumbUrl} alt={collection.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-400 p-4">
            <Layers size={28} className="text-blue-400" />
            <span className="text-xs text-center">
              {collection.modelCount} model{collection.modelCount === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col p-3 gap-1 flex-1">
        <p
          className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-accent transition-colors"
          title={collection.name}
        >
          {collection.name}
        </p>
        <p className="text-xs text-gray-400">
          {collection.modelCount} model{collection.modelCount === 1 ? '' : 's'}
        </p>
      </div>
    </Link>
  );
}
