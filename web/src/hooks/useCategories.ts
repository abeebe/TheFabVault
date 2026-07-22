import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type { CategoryOut } from '../lib/api.js';

// Read-only for now -- same idiom as useFolders.ts's flat list+refresh
// shape. #2164's scope is "feed ModelPage's picker", not a category
// admin UI (that's Phase B proper, per the plan) -- api.categories
// already has create/update/delete (contract-first commit) for that
// later UI to call directly; this hook doesn't wrap them yet since
// nothing calls them.
export function useCategories() {
  const [categories, setCategories] = useState<CategoryOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.categories.list();
      setCategories(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { categories, loading, error, refresh };
}
