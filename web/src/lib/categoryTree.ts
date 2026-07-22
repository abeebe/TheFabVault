import type { CategoryOut } from './api.js';

// Flattens the useCategories() tree into a single ordered list, indenting
// children under their parent with a simple em-dash prefix per depth
// level. Extracted from ModelPage.tsx's Edit Details category <select>
// (#2164) so BrowsePage's category chips (#2168, Phase B) walk the exact
// same tree in the exact same order -- one tree-flatten implementation,
// not two copies that could quietly drift (e.g. a future sortOrder change
// only applied to one call site).
export function buildCategoryOptions(categories: CategoryOut[]): Array<{ id: string; label: string }> {
  const byParent = new Map<string | null, CategoryOut[]>();
  for (const c of categories) {
    const key = c.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  const options: Array<{ id: string; label: string }> = [];
  function walk(parentId: string | null, depth: number) {
    for (const c of byParent.get(parentId) ?? []) {
      options.push({ id: c.id, label: `${'— '.repeat(depth)}${c.name}` });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  return options;
}
