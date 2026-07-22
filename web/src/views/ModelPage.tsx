import { useParams } from 'react-router-dom';

// Placeholder for the individual model page (Phase A4, #2153 plan): gallery,
// 3D viewer tab, description, files list, print profiles. This ticket
// (#2156) only needs the route to exist and render something recognizable.
export function ModelPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="flex h-full items-center justify-center bg-surface">
      <div className="text-center text-gray-500 dark:text-gray-400">
        <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Model</p>
        <p className="text-sm mt-1">Model page for id &quot;{id}&quot; — coming soon.</p>
      </div>
    </div>
  );
}
