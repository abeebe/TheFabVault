// Placeholder for the model-centric Library view (Phase A4, #2153 plan).
// Real implementation (grid of ModelCard, search/category/tag filtering)
// lands once api/src/routes/models.ts (#2154) is in place. This ticket
// (#2156) only needs the route to exist and render something recognizable.
export function LibraryPage() {
  return (
    <div className="flex h-full items-center justify-center bg-surface">
      <div className="text-center text-gray-500 dark:text-gray-400">
        <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Library</p>
        <p className="text-sm mt-1">Model-centric library — coming soon.</p>
      </div>
    </div>
  );
}
