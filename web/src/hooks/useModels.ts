import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type {
  ModelListParams, ModelOut, ModelDetailOut, ModelUpdateBody,
  ModelFileRole, PrintProfileCreateBody, PrintProfileUpdateBody,
} from '../lib/api.js';

// List hook -- mirrors useAssets.ts's shape (list + total + loading/error +
// refresh) so the model-centric and asset-centric list views stay easy to
// reason about side by side. No addAssets-equivalent here: unlike uploads
// (which resolve client-side and can be appended optimistically), model
// creation always redirects straight to the new model's detail page
// (see LibraryPage), so there's no "just created, splice it into this
// list" case to support.
export function useModels(params: ModelListParams) {
  const [models, setModels] = useState<ModelOut[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.models.list(params);
      setModels(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [refresh]);

  return { models, total, loading, error, refresh };
}

// Detail hook -- mirrors useSetDetail's shape (single-record fetch, plus
// mutation methods that refetch afterward). A model's file list and print
// profiles nest inside the one GET /model/:id payload rather than having
// their own list endpoints, so every mutation here just re-fetches the
// whole detail record -- same "await the write, then refresh" pattern
// useSetDetail uses for addAssets/update, just applied uniformly since
// there's no per-field partial-update path worth optimizing for yet.
export function useModel(id: string | null) {
  const [model, setModel] = useState<ModelDetailOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) { setModel(null); return; }
    setLoading(true);
    setError(null);
    try {
      setModel(await api.models.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setModel(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const update = useCallback(async (body: ModelUpdateBody) => {
    if (!id) return;
    await api.models.update(id, body);
    await refresh();
  }, [id, refresh]);

  const attachExisting = useCallback(async (assetIds: string[], role?: ModelFileRole) => {
    if (!id) return;
    await api.models.attachExisting(id, assetIds, role);
    await refresh();
  }, [id, refresh]);

  const uploadFiles = useCallback(async (files: File[], role?: ModelFileRole) => {
    if (!id) return;
    await api.models.uploadFiles(id, files, role);
    await refresh();
  }, [id, refresh]);

  const detachFile = useCallback(async (assetId: string) => {
    if (!id) return;
    await api.models.detachFile(id, assetId);
    await refresh();
  }, [id, refresh]);

  const reorderFiles = useCallback(async (assetIds: string[]) => {
    if (!id) return;
    await api.models.reorderFiles(id, assetIds);
    await refresh();
  }, [id, refresh]);

  const setCover = useCallback(async (assetId: string | null) => {
    if (!id) return;
    await api.models.setCover(id, assetId);
    await refresh();
  }, [id, refresh]);

  const createProfile = useCallback(async (body: PrintProfileCreateBody) => {
    if (!id) return;
    await api.models.profiles.create(id, body);
    await refresh();
  }, [id, refresh]);

  const updateProfile = useCallback(async (profileId: string, body: PrintProfileUpdateBody) => {
    await api.models.profiles.update(profileId, body);
    await refresh();
  }, [refresh]);

  const deleteProfile = useCallback(async (profileId: string) => {
    await api.models.profiles.delete(profileId);
    await refresh();
  }, [refresh]);

  return {
    model, loading, error, refresh,
    update, attachExisting, uploadFiles, detachFile, reorderFiles, setCover,
    createProfile, updateProfile, deleteProfile,
  };
}
