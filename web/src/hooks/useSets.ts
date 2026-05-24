import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { SetOut, SetDetailOut } from '../types/index.js';

export function useSets() {
  const [sets, setSets] = useState<SetOut[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSets(await api.sets.list());
    } catch (err) {
      console.error('[useSets] Failed to fetch sets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createSet = useCallback(async (
    name: string,
    options: { description?: string; assetIds?: string[] } = {},
  ): Promise<SetOut> => {
    const set = await api.sets.create({ name, ...options });
    setSets((prev) => [set, ...prev].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
    return set;
  }, []);

  const deleteSet = useCallback(async (id: string): Promise<void> => {
    await api.sets.delete(id);
    setSets((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sets, loading, refresh, createSet, deleteSet };
}

// Detail view of a single set + its member assets.
export function useSetDetail(id: string | null) {
  const [set, setSet] = useState<SetDetailOut | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) { setSet(null); return; }
    setLoading(true);
    try {
      setSet(await api.sets.get(id));
    } catch {
      setSet(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const removeAsset = useCallback(async (assetId: string) => {
    if (!id) return;
    await api.sets.removeAsset(id, assetId);
    setSet((prev) => prev ? {
      ...prev,
      assets: prev.assets.filter((a) => a.id !== assetId),
      assetCount: prev.assetCount - 1,
    } : null);
  }, [id]);

  const addAssets = useCallback(async (assetIds: string[]) => {
    if (!id) return;
    await api.sets.addAssets(id, assetIds);
    await refresh();
  }, [id, refresh]);

  const update = useCallback(async (body: {
    name?: string;
    description?: string | null;
    coverAssetId?: string | null;
  }) => {
    if (!id) return;
    await api.sets.update(id, body);
    await refresh();
  }, [id, refresh]);

  return { set, loading, refresh, removeAsset, addAssets, update };
}
