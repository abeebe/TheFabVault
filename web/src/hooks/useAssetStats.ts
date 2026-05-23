import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export interface AssetStats {
  total: number;
  favorites: number;
  threeDmodel: number;
  twoD: number;
  uncategorized: number;
}

const ZERO: AssetStats = { total: 0, favorites: 0, threeDmodel: 0, twoD: 0, uncategorized: 0 };

// Sidebar category counts. The /assets list is paginated, so counting
// from the loaded page would only reflect ~one page worth — this hook
// fetches a single backend aggregate across all non-trashed assets.
export function useAssetStats() {
  const [stats, setStats] = useState<AssetStats>(ZERO);

  const refresh = useCallback(async () => {
    try {
      const s = await api.assets.stats();
      setStats(s);
    } catch (err) {
      console.error('[useAssetStats] Failed to fetch stats:', err);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { stats, refresh };
}
