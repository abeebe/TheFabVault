import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type { AssetOut } from '../types/index.js';
import type { AssetListParams } from '../lib/api.js';

export function useAssets(params: AssetListParams) {
  const [assets, setAssets] = useState<AssetOut[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.assets.list(params);
      setAssets(result.items);
      setTotal(result.total);
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
    setTotal((prev) => Math.max(0, prev - 1));
  }, []);

  const addAssets = useCallback((newAssets: AssetOut[]) => {
    setAssets((prev) => [...newAssets, ...prev]);
    setTotal((prev) => prev + newAssets.length);
  }, []);

  return { assets, total, loading, error, refresh, updateAsset, removeAsset, addAssets };
}
