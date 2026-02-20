import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type { FolderOut } from '../types/index.js';

export function useFolders() {
  const [folders, setFolders] = useState<FolderOut[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.folders.list();
      setFolders(list);
    } catch (err) {
      console.error('[useFolders]', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createFolder = useCallback(async (name: string, parentId?: string): Promise<FolderOut> => {
    const folder = await api.folders.create(name, parentId);
    setFolders((prev) => [...prev, folder]);
    return folder;
  }, []);

  const renameFolder = useCallback(async (id: string, name: string): Promise<void> => {
    const updated = await api.folders.update(id, { name });
    setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)));
  }, []);

  const deleteFolder = useCallback(async (id: string): Promise<void> => {
    await api.folders.delete(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
  }, []);

  return { folders, loading, refresh, createFolder, renameFolder, deleteFolder };
}
