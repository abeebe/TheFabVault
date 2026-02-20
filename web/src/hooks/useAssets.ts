import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type { AssetOut } from '../types/index.js';
import type { AssetListParams } from '../lib/api.js';

export function useAssets(params: AssetListParams) {
  const [assets, setAssets] = useState<AssetOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.assets.list(params);
      setAssets(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [refresh]);

  const updateAsset = useCallback((updated: AssetOut) => {
    setAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  const removeAsset = useCallback((id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const addAssets = useCallback((newAssets: AssetOut[]) => {
    setAssets((prev) => [...newAssets, ...prev]);
  }, []);

  return { assets, loading, error, refresh, updateAsset, removeAsset, addAssets };
}
