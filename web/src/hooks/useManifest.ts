import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type { ManifestOut } from '../types/index.js';

// Fetches the whole build-manifest tree once per project load. Per the UX
// spec (section 7): Build Mode's breadcrumb drill-down and Organize Mode's
// tree both operate against this flat, already-loaded payload — drilling
// in/out is client-side state, never a per-node network request.
export function useManifest(projectId: string | null) {
  const [manifest, setManifest] = useState<ManifestOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) { setManifest(null); return; }
    setLoading(true);
    setError(false);
    try {
      const data = await api.manifest.get(projectId);
      setManifest(data);
    } catch (err) {
      console.error('[useManifest] Failed to fetch manifest:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { manifest, loading, error, refresh };
}
