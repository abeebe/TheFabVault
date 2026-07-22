import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { CollectionOut, CollectionDetailOut, CollectionCreateBody, CollectionUpdateBody } from '../lib/api.js';

// Model-level analog of useSets.ts -- same list+create+delete shape, just
// swapping api.sets.* for api.collections.* and SetOut/SetDetailOut for
// CollectionOut/CollectionDetailOut. See useSets.ts for the idiom this
// mirrors; not re-explaining the reasoning here since it's identical.
export function useCollections() {
  const [collections, setCollections] = useState<CollectionOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCollections(await api.collections.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      console.error('[useCollections] Failed to fetch collections:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createCollection = useCallback(async (
    name: string,
    options: Omit<CollectionCreateBody, 'name'> = {},
  ): Promise<CollectionOut> => {
    const collection = await api.collections.create({ name, ...options });
    setCollections((prev) => [collection, ...prev].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    ));
    return collection;
  }, []);

  const deleteCollection = useCallback(async (id: string): Promise<void> => {
    await api.collections.delete(id);
    setCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return { collections, loading, error, refresh, createCollection, deleteCollection };
}

// Detail view of a single collection + its member models. Mirrors
// useSetDetail's shape (removeAsset -> removeModel, addAssets ->
// addModels), plus reorderModels/setCover which sets.ts's web contract
// doesn't expose today (collections.ts's API does -- see
// api.collections.reorderModels/setCover in lib/api.ts) -- both refetch
// the whole detail record afterward, same "await the write, then
// refresh" pattern useModel.ts uses uniformly for its own mutations.
export function useCollection(id: string | null) {
  const [collection, setCollection] = useState<CollectionDetailOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) { setCollection(null); return; }
    setLoading(true);
    setError(null);
    try {
      setCollection(await api.collections.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCollection(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const update = useCallback(async (body: CollectionUpdateBody) => {
    if (!id) return;
    await api.collections.update(id, body);
    await refresh();
  }, [id, refresh]);

  // Optimistic locally -- same immediate-splice treatment useSetDetail's
  // removeAsset gives removals, since there's no server round-trip worth
  // waiting on to know the member is gone.
  const removeModel = useCallback(async (modelId: string) => {
    if (!id) return;
    await api.collections.removeModel(id, modelId);
    setCollection((prev) => prev ? {
      ...prev,
      models: prev.models.filter((m) => m.id !== modelId),
      modelCount: prev.modelCount - 1,
    } : null);
  }, [id]);

  const addModels = useCallback(async (modelIds: string[]) => {
    if (!id) return;
    await api.collections.addModels(id, modelIds);
    await refresh();
  }, [id, refresh]);

  const reorderModels = useCallback(async (modelIds: string[]) => {
    if (!id) return;
    await api.collections.reorderModels(id, modelIds);
    await refresh();
  }, [id, refresh]);

  const setCover = useCallback(async (modelId: string | null) => {
    if (!id) return;
    await api.collections.setCover(id, modelId);
    await refresh();
  }, [id, refresh]);

  return { collection, loading, error, refresh, update, removeModel, addModels, reorderModels, setCover };
}
